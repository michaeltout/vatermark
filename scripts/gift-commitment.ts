import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  EVALS, KeyID, OptCCParams, SmartTransactionScript, TxDestination,
  fromBase58Check, nameAndParentAddrToIAddr,
} from 'verus-typescript-primitives';

const require = createRequire(import.meta.url);
const primitiveRequire = createRequire(require.resolve('verus-typescript-primitives'));
const clientRequire = createRequire(require.resolve('verusid-ts-client'));
const BN = primitiveRequire('bn.js');
const { Transaction, networks, address } = clientRequire('@bitgo/utxo-lib');

export class GiftOperationError extends Error {}

export type GiftRpc = (method: string, params?: unknown[]) => Promise<any>;
export type PreparedGiftTransaction = { txid: string; hex: string };
export type GiftNameReservation = {
  version: number; name: string; parent: string; referral: string; salt: string; nameid: string;
};

/** Mirrors CAdvancedNameReservation and MakeMofNCCScript without broadcasting.
 * Sources: VerusCoin/src/pbaas/identity.h, registernamecommitment in pbaasrpc.cpp,
 * and verus-typescript-primitives IdentityCommitmentScript. Persist the returned
 * salt and signed transaction before sendrawtransaction. Retrying the same bytes
 * can never purchase a second commitment.
 */
export function makeCommitmentScript(name: string, parentId: string, controlAddress: string,
  salt = randomBytes(32), referralId?: string): { script: Buffer; namereservation: GiftNameReservation } {
  if (!/^[a-z][a-z0-9]{0,62}$/.test(name)) throw new GiftOperationError('Commitment requires a lowercase ASCII leaf name.');
  if (salt.length !== 32) throw new GiftOperationError('Commitment salt must contain 32 bytes.');
  const parent = fromBase58Check(parentId);
  const controller = fromBase58Check(controlAddress);
  const referral = referralId ? fromBase58Check(referralId) : undefined;
  if (referral && referral.version !== 102) throw new GiftOperationError('Commitment referral must be an identity address.');
  if (parent.version !== 102 || controller.version !== 60) throw new GiftOperationError('Invalid commitment parent or R-address controller.');
  const version = Buffer.alloc(4); version.writeUInt32LE(1);
  const bytes = Buffer.from(name, 'utf8');
  const reservation = Buffer.concat([version, Buffer.from([bytes.length]), bytes, parent.hash, referral?.hash ?? Buffer.alloc(20), salt]);
  const hash = createHash('sha256').update(createHash('sha256').update(reservation).digest()).digest();
  const destination = new TxDestination(new KeyID(controller.hash));
  const params = (evalCode: number, vData: Buffer[]) => new OptCCParams({
    version: new BN(3), evalCode: new BN(evalCode), m: new BN(1), n: new BN(1),
    destinations: [destination], vData,
  });
  return {
    script: new SmartTransactionScript(params(EVALS.EVAL_NONE, []), params(EVALS.EVAL_IDENTITY_COMMITMENT, [hash])).toBuffer(),
    namereservation: {
      version: 1, name, parent: parentId, referral: referralId ?? '', salt: Buffer.from(salt).reverse().toString('hex'),
      nameid: nameAndParentAddrToIAddr(name, parentId),
    },
  };
}

export async function prepareCommitment(rpc: GiftRpc, name: string, parentId: string,
  controlAddress: string, feeInput?: { txid: string; vout: number }, referralId?: string): Promise<PreparedGiftTransaction & { namereservation: GiftNameReservation }> {
  const { script, namereservation } = makeCommitmentScript(name, parentId, controlAddress, undefined, referralId);
  const empty = await rpc('createrawtransaction', [[], {}]);
  const tx = Transaction.fromHex(empty, networks.verustest);
  tx.addOutput(script, 0);
  const funded = await rpc('fundrawtransaction', feeInput ? [tx.toHex(), [{ txid: feeInput.txid, voutnum: feeInput.vout }], controlAddress, 0.0001] : [tx.toHex()]);
  const signed = await rpc('signrawtransaction', [funded.hex]);
  if (!signed.complete || typeof signed.hex !== 'string') throw new GiftOperationError('Daemon could not fully sign the commitment.');
  const decoded = await rpc('decoderawtransaction', [signed.hex]);
  if (!/^[0-9a-f]{64}$/.test(decoded.txid)) throw new GiftOperationError('Daemon returned an invalid commitment transaction ID.');
  return { namereservation, txid: decoded.txid, hex: signed.hex };
}


/** Each commitment spends its own confirmed fee output, so 200 commitments can
 * share a confirmation block without a chain of 200 mempool ancestors. The
 * daemon registeridentity only accepts the first commitment output in a tx,
 * which rules out combining commitments themselves into one transaction. */
export async function prepareCommitmentFeeFunding(rpc: GiftRpc, controlAddress: string,
  cardIds: string[]): Promise<PreparedGiftTransaction & { allocations: { cardId: string; vout: number }[] }> {
  if (cardIds.length < 1 || cardIds.length > 200 || new Set(cardIds).size !== cardIds.length)
    throw new GiftOperationError('Invalid commitment fee allocation.');
  const empty = await rpc('createrawtransaction', [[], {}]);
  const tx = Transaction.fromHex(empty, networks.verustest);
  const script = address.toOutputScript(controlAddress, networks.verustest);
  for (const id of cardIds) { void id; tx.addOutput(script, 100000); }
  const funded = await rpc('fundrawtransaction', [tx.toHex()]);
  const signed = await rpc('signrawtransaction', [funded.hex]);
  if (!signed.complete || typeof signed.hex !== 'string') throw new GiftOperationError('Daemon could not sign commitment fee funding.');
  const decoded = await rpc('decoderawtransaction', [signed.hex]);
  const outputs = decoded.vout.filter((output: any) => output.scriptPubKey?.hex === script.toString('hex') &&
    Math.round(Number(output.value) * 100000000) === 100000);
  if (outputs.length !== cardIds.length) throw new GiftOperationError('Commitment fee output allocation is ambiguous.');
  return { hex: signed.hex, txid: decoded.txid,
    allocations: cardIds.map((cardId, index) => ({ cardId, vout: outputs[index].n })) };
}
