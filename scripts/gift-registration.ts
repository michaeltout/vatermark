import { GiftOperationError, type GiftRpc, type PreparedGiftTransaction } from './gift-commitment.js';

type SavedRegistration = PreparedGiftTransaction & { broadcast?: boolean };
export type RetiredGiftRegistration = SavedRegistration & {
  reason: 'confirmed-input-conflict'; retiredAt: string; confirmedSpenders: string[];
};
export interface RepairableGiftCard {
  identityId: string;
  commitment?: PreparedGiftTransaction;
  registration?: SavedRegistration;
  retiredRegistrations?: RetiredGiftRegistration[];
}
type Input = { txid: string; vout: number };
const validTxid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function inputs(transaction: any): Input[] {
  if (!Array.isArray(transaction?.vin) || !transaction.vin.length || transaction.vin.some((input: Input) =>
    !validTxid(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0)) {
    throw new GiftOperationError('Cannot validate the inputs of a saved gift registration.');
  }
  return transaction.vin.map((input: Input) => ({ txid: input.txid, vout: input.vout }));
}
const outpoint = (input: Input) => `${input.txid}:${input.vout}`;
async function optional(rpc: GiftRpc, method: string, params: unknown[]) {
  try { return await rpc(method, params); }
  catch (error) { if ((error as { code?: number }).code === -5) return undefined; throw error; }
}

/** Retire only a permanently conflicting, unbroadcast registration. No broadcast,
 * key changes, or gift funding occurs here. The original signed bytes are retained.
 * A confirmed journal transaction proves every spent input's competing spend. */
export async function repairConflictedGiftRegistrations(options: {
  rpc: GiftRpc; cards: RepairableGiftCard[]; persist: () => Promise<void>;
}): Promise<number> {
  const { rpc, cards, persist } = options;
  let repaired = 0;
  const known = new Map<string, any>();
  const transaction = async (txid: string) => {
    if (!known.has(txid)) known.set(txid, await optional(rpc, 'getrawtransaction', [txid, 1]));
    return known.get(txid);
  };
  for (const card of cards) {
    const saved = card.registration;
    if (!saved || await transaction(saved.txid)) continue;
    if (!card.commitment || !validTxid(saved.txid) || !validTxid(card.commitment.txid)) {
      throw new GiftOperationError('A missing saved registration does not have a valid commitment journal.');
    }
    // Include the mempool. Never retire a card whose identity was already registered.
    if (await optional(rpc, 'getidentity', [card.identityId, -1])) {
      throw new GiftOperationError('A gift identity already exists but its saved registration is unknown. Investigate before continuing.');
    }
    const decoded = await rpc('decoderawtransaction', [saved.hex]);
    if (decoded?.txid !== saved.txid) throw new GiftOperationError('Saved gift registration bytes do not match their transaction ID.');
    const allInputs = inputs(decoded);
    const commitmentInputs = allInputs.filter(input => input.txid === card.commitment!.txid);
    if (commitmentInputs.length !== 1 || !await rpc('gettxout', [commitmentInputs[0].txid, commitmentInputs[0].vout, true])) {
      throw new GiftOperationError('The saved gift commitment has been spent; automatic registration repair is unsafe.');
    }
    const spent: Input[] = [];
    for (const input of allInputs) {
      if (!await rpc('gettxout', [input.txid, input.vout, true])) spent.push(input);
    }
    if (!spent.length) continue; // Still valid to submit the exact saved transaction.
    const confirmedSpends = new Map<string, string>();
    for (const other of cards) {
      if (!other.registration || other.registration.txid === saved.txid) continue;
      const previous = await transaction(other.registration.txid);
      if (!previous || !Number.isSafeInteger(previous.confirmations) || previous.confirmations < 1) continue;
      if (previous.txid !== other.registration.txid) throw new GiftOperationError('A confirmed registration receipt has an unexpected transaction ID.');
      for (const input of inputs(previous)) confirmedSpends.set(outpoint(input), previous.txid);
    }
    if (spent.some(input => !confirmedSpends.has(outpoint(input)))) {
      throw new GiftOperationError('Saved registration inputs are spent without a confirmed competing gift transaction. Wait for confirmations or investigate; no registration was replaced.');
    }
    // Recheck the irreversible conditions immediately before checkpointing repair.
    if (await optional(rpc, 'getrawtransaction', [saved.txid, 1]) ||
        await optional(rpc, 'getidentity', [card.identityId, -1]) ||
        !await rpc('gettxout', [commitmentInputs[0].txid, commitmentInputs[0].vout, true])) {
      throw new GiftOperationError('The gift registration changed during repair. Retry after checking its status.');
    }
    const confirmedSpenders = [...new Set(spent.map(input => confirmedSpends.get(outpoint(input))!))];
    for (const txid of confirmedSpenders) {
      const receipt = await rpc('getrawtransaction', [txid, 1]);
      if (receipt.txid !== txid || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 1) {
        throw new GiftOperationError('A competing registration is no longer confirmed; automatic repair stopped.');
      }
    }
    (card.retiredRegistrations ??= []).push({ ...saved, reason: 'confirmed-input-conflict',
      retiredAt: new Date().toISOString(), confirmedSpenders });
    delete card.registration;
    await persist();
    repaired++;
  }
  return repaired;
}
