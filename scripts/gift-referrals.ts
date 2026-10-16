import { nameAndParentAddrToIAddr } from 'verus-typescript-primitives';
import { prepareCommitment, type GiftRpc, type GiftNameReservation, type PreparedGiftTransaction } from './gift-commitment.js';

export const GIFT_TESTNET_SYSTEM = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';
export const GIFT_NATIVE_PARENT = 'vrsctest@';
export const GIFT_NATIVE_REGISTRATION_FEE = 80;
export const GIFT_REFERRAL_REBATE = 20;
const ROOT_NAME = 'vatermark';
const ANCHOR_NAMES = ['vatermarkreferralone', 'vatermarkreferraltwo'] as const;
type SavedTx = PreparedGiftTransaction & { broadcast?: boolean };
export type GiftReferralAnchor = {
  name: string; identityId: string;
  commitment?: SavedTx & { namereservation: GiftNameReservation };
  registration?: SavedTx;
};
export type GiftReferralState = { controlAddress?: string; anchors: GiftReferralAnchor[] };
export type GiftReferralOptions = {
  rpc: GiftRpc; state: { referrals?: GiftReferralState }; persist: () => Promise<void>;
  waitForTx: (txid: string) => Promise<void>; log: (message: string) => void; allowBroadcast: boolean;
};

async function lookup(rpc: GiftRpc, method: string, params: unknown[]): Promise<any | undefined> {
  try { return await rpc(method, params); }
  catch (error) { if ((error as { code?: number }).code === -5) return undefined; throw error; }
}
function assertOperatorIdentity(result: any, identityId: string, controlAddress?: string): void {
  const identity = result?.identity;
  if (result?.status !== 'active' || result?.canspendfor !== true || identity?.identityaddress !== identityId ||
      identity.parent !== GIFT_TESTNET_SYSTEM || identity.minimumsignatures !== 1 ||
      identity.primaryaddresses?.length !== 1 || identity.revocationauthority !== identityId ||
      identity.recoveryauthority !== identityId || (controlAddress && identity.primaryaddresses[0] !== controlAddress)) {
    throw new Error('A referral anchor is not an active native identity exclusively controlled by this wallet.');
  }
}

/** Referrals are paid before the reservation output. Never confuse change with a rebate. */
export function assertNativeReferralPayouts(transaction: any, identityId: string, ancestors: string[]): void {
  const outputs = transaction?.vout;
  if (!Array.isArray(outputs) || ancestors.length < 1 || ancestors.length > 3) throw new Error('Invalid native referral transaction.');
  const identityIndex = outputs.findIndex(output => output.scriptPubKey?.identityprimary?.identityaddress === identityId);
  const reservationIndex = outputs.findIndex(output => output.scriptPubKey?.identityreservation?.nameid === identityId);
  const reservation = outputs[reservationIndex]?.scriptPubKey?.identityreservation;
  if (identityIndex < 0 || reservationIndex !== identityIndex + ancestors.length + 1 ||
      reservation?.referral !== ancestors[0] || reservation?.parent !== GIFT_TESTNET_SYSTEM) {
    throw new Error('Native identity registration does not contain the expected referral chain.');
  }
  for (let index = 0; index < ancestors.length; index++) {
    const output = outputs[identityIndex + index + 1];
    if (output.value !== GIFT_REFERRAL_REBATE || output.scriptPubKey?.addresses?.length !== 1 ||
        output.scriptPubKey.addresses[0] !== ancestors[index] || output.scriptPubKey?.reqSigs !== 1) {
      throw new Error('Native identity registration is missing an operator-controlled 20 VRSCTEST rebate.');
    }
  }
}

async function verifyHistoricalReferrals(rpc: GiftRpc, identityId: string, ancestors: string[]): Promise<void> {
  const history = await rpc('getidentityhistory', [identityId]);
  const entries = history?.history;
  if (!Array.isArray(entries) || !entries.length) throw new Error('Referral identity registration history is unavailable.');
  const first = [...entries].sort((a, b) => a.height - b.height)[0];
  const txid = first.output?.txid;
  if (!/^[a-f0-9]{64}$/.test(txid ?? '')) throw new Error('Referral registration history is invalid.');
  const registration = await rpc('getrawtransaction', [txid, 1]);
  if (Number(registration.confirmations) < 1) throw new Error('Referral registration must be confirmed.');
  assertNativeReferralPayouts(registration, identityId, ancestors);
}

async function prepared(rpc: GiftRpc, hex: unknown, identityId: string, ancestors: string[]): Promise<SavedTx> {
  if (typeof hex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error('Daemon returned invalid referral registration bytes.');
  const decoded = await rpc('decoderawtransaction', [hex]);
  if (!/^[a-f0-9]{64}$/.test(decoded.txid ?? '')) throw new Error('Daemon returned an invalid referral transaction ID.');
  assertNativeReferralPayouts(decoded, identityId, ancestors);
  return { hex, txid: decoded.txid };
}
async function relay(options: GiftReferralOptions, transaction: SavedTx): Promise<void> {
  const existing = await lookup(options.rpc, 'getrawtransaction', [transaction.txid, 1]);
  if (Number(existing?.confirmations) < 0) throw new Error('Saved referral transaction is conflicted.');
  if (!existing) {
    const txid = await options.rpc('sendrawtransaction', [transaction.hex]);
    if (txid !== transaction.txid) throw new Error('Unexpected referral broadcast transaction ID.');
  }
  transaction.broadcast = true;
  await options.persist();
  await options.waitForTx(transaction.txid);
}

/** Local wallet bootstrap. The web server never imports this module. */
export async function ensureGiftReferrals(options: GiftReferralOptions): Promise<{
  referralId: string; controlAddress: string; registrationFee: 80; sourceOfFunds: '*'; rebateIdentities: string[];
}> {
  if (!options.allowBroadcast) throw new Error('Referral setup requires explicit execution mode.');
  const { rpc, persist, state, log } = options;
  const info = await rpc('getinfo');
  const chain = await rpc('getcurrency', ['VRSCTEST']);
  if (info.testnet !== true || info.name?.toUpperCase() !== 'VRSCTEST' || chain.currencyid !== GIFT_TESTNET_SYSTEM ||
      chain.idregistrationfees !== 100 || chain.idreferrallevels !== 3 || !(chain.options & 8)) {
    throw new Error('Native gift registration requires the expected VRSCTEST 100/80/20 referral fee schedule.');
  }
  const rootId = nameAndParentAddrToIAddr(ROOT_NAME, GIFT_TESTNET_SYSTEM);
  assertOperatorIdentity(await lookup(rpc, 'getidentity', [`${ROOT_NAME}.${GIFT_NATIVE_PARENT}`]), rootId);
  const journal = state.referrals ??= { anchors: [] };
  if (!Array.isArray(journal.anchors) || journal.anchors.length > 2) throw new Error('Invalid private referral journal.');
  const ancestors = [rootId];
  for (const [index, name] of ANCHOR_NAMES.entries()) {
    const identityId = nameAndParentAddrToIAddr(name, GIFT_TESTNET_SYSTEM);
    let anchor = journal.anchors[index];
    if (!anchor) { anchor = { name, identityId }; journal.anchors.push(anchor); await persist(); }
    if (anchor.name !== name || anchor.identityId !== identityId) throw new Error('Unexpected referral identity in the private journal.');
    let identity = await lookup(rpc, 'getidentity', [identityId]);
    if (!identity) {
      if (!journal.controlAddress) { journal.controlAddress = await rpc('getnewaddress', []); await persist(); }
      const controlAddress = journal.controlAddress;
      if (typeof controlAddress !== 'string') throw new Error('Daemon did not return a referral controller.');
      if (!anchor.commitment) {
        anchor.commitment = await prepareCommitment(rpc, name, GIFT_TESTNET_SYSTEM, controlAddress, undefined, ancestors[0]);
        await persist();
      }
      log(`Waiting for the ${name}.vrsctest@ commitment.`);
      await relay(options, anchor.commitment);
      if (!anchor.registration) {
        const hex = await rpc('registeridentity', [{ txid: anchor.commitment.txid,
          namereservation: anchor.commitment.namereservation, identity: { name, parent: GIFT_TESTNET_SYSTEM,
            primaryaddresses: [controlAddress], minimumsignatures: 1,
            revocationauthority: identityId, recoveryauthority: identityId } }, true, GIFT_NATIVE_REGISTRATION_FEE, '*']);
        anchor.registration = await prepared(rpc, hex, identityId, ancestors);
        await persist();
      }
      log(`Waiting for the ${name}.vrsctest@ registration.`);
      await relay(options, anchor.registration);
      identity = await rpc('getidentity', [identityId]);
    }
    assertOperatorIdentity(identity, identityId, anchor.registration ? journal.controlAddress : undefined);
    await verifyHistoricalReferrals(rpc, identityId, ancestors);
    ancestors.unshift(identityId);
  }
  if (!journal.controlAddress) { journal.controlAddress = await rpc('getnewaddress', []); await persist(); }
  const controlAddress = journal.controlAddress;
  if (typeof controlAddress !== 'string') throw new Error('Daemon did not return a gift commitment controller.');
  return { referralId: ancestors[0], controlAddress, registrationFee: 80, sourceOfFunds: '*', rebateIdentities: ancestors };
}
