import { describe, expect, it, vi } from 'vitest';
import { repairConflictedGiftRegistrations, type RepairableGiftCard } from '../scripts/gift-registration.js';
import type { GiftRpc } from '../scripts/gift-commitment.js';

const firstTx = '1'.repeat(64), rejectedTx = '2'.repeat(64), firstCommit = '3'.repeat(64), secondCommit = '4'.repeat(64);
const sharedCoin = '5'.repeat(64), untouchedCoin = '6'.repeat(64);
const cards = (): RepairableGiftCard[] => [
  { identityId: 'iFirst', commitment: { txid: firstCommit, hex: '01' }, registration: { txid: firstTx, hex: '03', broadcast: true } },
  { identityId: 'iSecond', commitment: { txid: secondCommit, hex: '02' }, registration: { txid: rejectedTx, hex: '04' } },
];
const confirmed = () => ({ txid: firstTx, confirmations: 2, vin: [{ txid: firstCommit, vout: 1 }, { txid: sharedCoin, vout: 0 }] });
const failed = () => ({ txid: rejectedTx, vin: [{ txid: secondCommit, vout: 1 }, { txid: sharedCoin, vout: 0 }, { txid: untouchedCoin, vout: 2 }] });
const absent = () => { throw Object.assign(new Error('Not found'), { code: -5 }); };
function setup(override?: (method: string, params: unknown[]) => unknown) {
  const entries = cards();
  const rpc: GiftRpc = vi.fn(async (method, params = []) => {
    const response = override?.(method, params); if (response !== undefined) return response;
    if (method === 'getrawtransaction') return params[0] === firstTx ? confirmed() : absent();
    if (method === 'getidentity') return absent();
    if (method === 'decoderawtransaction') return failed();
    if (method === 'gettxout') return params[0] === sharedCoin ? null : { value: params[0] === secondCommit ? 0 : 10 };
    throw new Error(`Unexpected RPC mutation ${method}`);
  });
  const persist = vi.fn(async () => {});
  return { rpc, cards: entries, persist };
}

describe('gift registration input conflict recovery', () => {
  it('archives only the rejected registration after proving its competing spend confirmed', async () => {
    const input = setup();
    await expect(repairConflictedGiftRegistrations(input)).resolves.toBe(1);
    expect(input.cards[0].registration?.txid).toBe(firstTx);
    expect(input.cards[1].registration).toBeUndefined();
    expect(input.cards[1].retiredRegistrations).toEqual([expect.objectContaining({ txid: rejectedTx, hex: '04',
      reason: 'confirmed-input-conflict', confirmedSpenders: [firstTx] })]);
    expect(input.persist).toHaveBeenCalledOnce();
    await expect(repairConflictedGiftRegistrations(input)).resolves.toBe(0);
    expect(input.cards[1].retiredRegistrations).toHaveLength(1);
  });
  it('keeps an unknown but fully unspent registration for exact-byte resubmission', async () => {
    const input = setup(method => method === 'gettxout' ? { value: 0 } : undefined);
    await expect(repairConflictedGiftRegistrations(input)).resolves.toBe(0);
    expect(input.cards[1].registration?.txid).toBe(rejectedTx);
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('does not replace a registration present in the mempool', async () => {
    const input = setup((method, params) => method === 'getrawtransaction' && params[0] === rejectedTx
      ? { ...failed(), confirmations: 0 } : undefined);
    await expect(repairConflictedGiftRegistrations(input)).resolves.toBe(0);
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('refuses repair if the identity is already present including mempool', async () => {
    const input = setup(method => method === 'getidentity' ? { identity: {} } : undefined);
    await expect(repairConflictedGiftRegistrations(input)).rejects.toThrow('already exists');
    expect(input.rpc).toHaveBeenCalledWith('getidentity', ['iSecond', -1]);
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('refuses repair if the unique commitment is spent', async () => {
    const input = setup((method, params) => method === 'gettxout' && params[0] === secondCommit ? null : undefined);
    await expect(repairConflictedGiftRegistrations(input)).rejects.toThrow('commitment has been spent');
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('requires the competing journal registration to be confirmed', async () => {
    const input = setup((method, params) => method === 'getrawtransaction' && params[0] === firstTx
      ? { ...confirmed(), confirmations: 0 } : undefined);
    await expect(repairConflictedGiftRegistrations(input)).rejects.toThrow('without a confirmed');
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('refuses an unrelated spent input even when one input has a proven conflict', async () => {
    const input = setup((method, params) => method === 'gettxout' && params[0] === untouchedCoin ? null : undefined);
    await expect(repairConflictedGiftRegistrations(input)).rejects.toThrow('without a confirmed');
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('rechecks confirmation before changing the journal', async () => {
    let checks = 0;
    const input = setup((method, params) => method === 'getrawtransaction' && params[0] === firstTx
      ? { ...confirmed(), confirmations: ++checks > 1 ? 0 : 1 } : undefined);
    await expect(repairConflictedGiftRegistrations(input)).rejects.toThrow('no longer confirmed');
    expect(input.cards[1].registration?.txid).toBe(rejectedTx);
    expect(input.persist).not.toHaveBeenCalled();
  });
  it('rejects journal bytes that decode to another transaction', async () => {
    const input = setup(method => method === 'decoderawtransaction' ? { ...failed(), txid: firstTx } : undefined);
    await expect(repairConflictedGiftRegistrations(input)).rejects.toThrow('do not match');
    expect(input.persist).not.toHaveBeenCalled();
  });
});
