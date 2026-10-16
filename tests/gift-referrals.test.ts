import { describe, expect, it, vi } from 'vitest';
import { nameAndParentAddrToIAddr } from 'verus-typescript-primitives';
import { assertNativeReferralPayouts, ensureGiftReferrals, GIFT_TESTNET_SYSTEM,
  type GiftReferralState } from '../scripts/gift-referrals.js';
import { prepareCommitment, type GiftRpc } from '../scripts/gift-commitment.js';

vi.mock('../scripts/gift-commitment.js', () => ({ prepareCommitment: vi.fn() }));
const root = nameAndParentAddrToIAddr('vatermark', GIFT_TESTNET_SYSTEM);
const first = nameAndParentAddrToIAddr('vatermarkreferralone', GIFT_TESTNET_SYSTEM);
const second = nameAndParentAddrToIAddr('vatermarkreferraltwo', GIFT_TESTNET_SYSTEM);
const gift = nameAndParentAddrToIAddr('brightowl', GIFT_TESTNET_SYSTEM);
function identity(id: string) { return { status: 'active', canspendfor: true,
  identity: { identityaddress: id, parent: GIFT_TESTNET_SYSTEM, minimumsignatures: 1,
    primaryaddresses: ['RWallet'], revocationauthority: id, recoveryauthority: id } }; }
function registration(id: string, refs: string[]): any { return { confirmations: 1,
  vout: [{ value: 0, scriptPubKey: { identityprimary: { identityaddress: id } } },
    ...refs.map(ref => ({ value: 20, scriptPubKey: { addresses: [ref], reqSigs: 1 } })),
    { value: 0, scriptPubKey: { identityreservation: { nameid: id, parent: GIFT_TESTNET_SYSTEM, referral: refs[0] } } },
    { value: 12, scriptPubKey: { addresses: ['RWallet'], reqSigs: 1 } }],
}; }
const firstTx = 'a'.repeat(64), secondTx = 'b'.repeat(64);
function existingRpc(override?: (method: string, params: unknown[]) => unknown): GiftRpc {
  return vi.fn(async (method, params = []) => {
    const value = override?.(method, params); if (value !== undefined) return value;
    if (method === 'getinfo') return { name: 'VRSCTEST', testnet: true };
    if (method === 'getcurrency') return { currencyid: GIFT_TESTNET_SYSTEM, idregistrationfees: 100, idreferrallevels: 3, options: 264 };
    if (method === 'getidentity') return identity(params[0] === 'vatermark.vrsctest@' ? root : String(params[0]));
    if (method === 'getidentityhistory') return { history: [{ height: 10, output: { txid: params[0] === first ? firstTx : secondTx } }] };
    if (method === 'getrawtransaction') return params[0] === firstTx ? registration(first, [root]) : registration(second, [first, root]);
    if (method === 'getnewaddress') return 'RWallet';
    throw new Error(`Unexpected method: ${method}`);
  });
}
const options = (rpc: GiftRpc, state: { referrals?: GiftReferralState } = {}) => ({ rpc, state,
  persist: vi.fn(async () => {}), waitForTx: vi.fn(async () => {}), log: vi.fn(), allowBroadcast: true });

describe('native identity gift referrals', () => {
  it('requires explicit execution before RPC access', async () => {
    const rpc = existingRpc();
    await expect(ensureGiftReferrals({ ...options(rpc), allowBroadcast: false })).rejects.toThrow('execution');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects the wrong chain before changing the wallet', async () => {
    const rpc = existingRpc(method => method === 'getinfo' ? { name: 'VRSC', testnet: false } : undefined);
    await expect(ensureGiftReferrals(options(rpc))).rejects.toThrow('VRSCTEST');
    expect(rpc).not.toHaveBeenCalledWith('getnewaddress', expect.anything());
  });
  it('rejects a changed native fee schedule', async () => {
    const rpc = existingRpc(method => method === 'getcurrency' ? { currencyid: GIFT_TESTNET_SYSTEM, idregistrationfees: 200, idreferrallevels: 3, options: 264 } : undefined);
    await expect(ensureGiftReferrals(options(rpc))).rejects.toThrow('fee schedule');
  });
  it('adopts verified operator-owned anchors without buying more identities', async () => {
    const rpc = existingRpc();
    const input = options(rpc);
    await expect(ensureGiftReferrals(input)).resolves.toEqual({ referralId: second, controlAddress: 'RWallet',
      registrationFee: 80, sourceOfFunds: '*', rebateIdentities: [second, first, root] });
    expect(input.waitForTx).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('sendrawtransaction', expect.anything());
    await ensureGiftReferrals(input);
    expect(rpc).toHaveBeenCalledWith('getidentityhistory', [first]);
  });
  it.each(['wallet', 'recovery', 'parent'])('rejects anchors with wrong %s authority', async field => {
    const bad = identity(first);
    if (field === 'wallet') bad.canspendfor = false;
    if (field === 'recovery') bad.identity.recoveryauthority = gift;
    if (field === 'parent') bad.identity.parent = gift;
    const rpc = existingRpc((method, params) => method === 'getidentity' && params[0] === first ? bad : undefined);
    await expect(ensureGiftReferrals(options(rpc))).rejects.toThrow('exclusively controlled');
  });
  it('rejects an operator-owned anchor whose original referral is wrong', async () => {
    const rpc = existingRpc((method, params) => method === 'getrawtransaction' && params[0] === secondTx
      ? registration(second, [gift, root]) : undefined);
    await expect(ensureGiftReferrals(options(rpc))).rejects.toThrow('expected referral chain');
  });
  it('verifies the three 20 VRSCTEST rebates in a gift registration', () => {
    expect(() => assertNativeReferralPayouts(registration(gift, [second, first, root]), gift, [second, first, root])).not.toThrow();
  });
  it.each(['amount', 'destination', 'order', 'missing'])('rejects incorrect %s in rebate outputs', field => {
    const tx = registration(gift, [second, first, root]);
    if (field === 'amount') tx.vout[1].value = 19;
    if (field === 'destination') tx.vout[1].scriptPubKey.addresses = [gift];
    if (field === 'order') [tx.vout[1], tx.vout[2]] = [tx.vout[2], tx.vout[1]];
    if (field === 'missing') tx.vout.splice(2, 1);
    expect(() => assertNativeReferralPayouts(tx, gift, [second, first, root])).toThrow();
  });

  it('checkpoints both commitments and checked registration transactions before broadcasting', async () => {
    const state: { referrals?: GiftReferralState } = {};
    const registered = new Set<string>();
    const persisted = new Set<string>();
    const sent: string[] = [];
    const commitIds = ['c'.repeat(64), 'd'.repeat(64)];
    vi.mocked(prepareCommitment).mockImplementation(async (_rpc, name, parent, controller, _feeInput, referral) => {
      const index = name === 'vatermarkreferralone' ? 0 : 1;
      expect(parent).toBe(GIFT_TESTNET_SYSTEM); expect(controller).toBe('RWallet');
      expect(referral).toBe(index === 0 ? root : first);
      return { txid: commitIds[index], hex: index === 0 ? '01' : '02', namereservation: {
        version: 1, name, parent, referral: referral!, salt: '00'.repeat(32), nameid: index === 0 ? first : second,
      } };
    });
    const defaults = existingRpc();
    const rpc: GiftRpc = async (method, params = []) => {
      if (method === 'getidentity' && params[0] !== 'vatermark.vrsctest@' && !registered.has(String(params[0])))
        throw Object.assign(new Error('Identity not found'), { code: -5 });
      if (method === 'registeridentity') {
        expect(params[1]).toBe(true); expect(params[2]).toBe(80); expect(params[3]).toBe('*');
        return (params[0] as any).identity.name === 'vatermarkreferralone' ? '03' : '04';
      }
      if (method === 'decoderawtransaction') return params[0] === '03'
        ? { ...registration(first, [root]), txid: firstTx } : { ...registration(second, [first, root]), txid: secondTx };
      if (method === 'getrawtransaction' && !registered.has(params[0] === firstTx ? first : second))
        throw Object.assign(new Error('Transaction not found'), { code: -5 });
      if (method === 'sendrawtransaction') {
        const hex = String(params[0]); expect(persisted.has(hex)).toBe(true); sent.push(hex);
        if (hex === '03') registered.add(first); if (hex === '04') registered.add(second);
        return ({ '01': commitIds[0], '02': commitIds[1], '03': firstTx, '04': secondTx } as Record<string, string>)[hex];
      }
      return defaults(method, params);
    };
    const input = options(rpc, state);
    input.persist = vi.fn(async () => {
      for (const anchor of state.referrals?.anchors ?? []) for (const tx of [anchor.commitment, anchor.registration]) if (tx) persisted.add(tx.hex);
    });
    await expect(ensureGiftReferrals(input)).resolves.toMatchObject({ referralId: second, rebateIdentities: [second, first, root] });
    expect(sent).toEqual(['01', '03', '02', '04']);
    expect(input.waitForTx).toHaveBeenCalledTimes(4);
  });
  it('does not count a 20 VRSCTEST change output as a referral rebate', () => {
    const tx = registration(gift, [second, first]);
    tx.vout[tx.vout.length - 1] = { value: 20, scriptPubKey: { addresses: [root], reqSigs: 1 } };
    expect(() => assertNativeReferralPayouts(tx, gift, [second, first, root])).toThrow('expected referral chain');
  });
});
