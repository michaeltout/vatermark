import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericRequest, SpendableKeyDetailsOrdinalVDXFObject, nameAndParentAddrToIAddr } from 'verus-typescript-primitives';
import { atomicWritePrivate, createBatch, deriveGiftAddress, makeGiftCard, resolveNativeNameCollisions, prepareRegistrationFunding, assertRegistrationFundingInputs } from '../scripts/generate-gifts';
import { makeCommitmentScript, prepareCommitment, prepareCommitmentFeeFunding } from '../scripts/gift-commitment';
import { GIFT_TESTNET_SYSTEM } from '../scripts/gift-referrals';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'vatermark-gift-test-')); directories.push(path); return path; }

describe('Mobile compatible gift generation', () => {
  it('matches the independently checked Verus-Mobile address for public zero entropy', () => {
    // This public test vector is deliberately unfunded. Mobile: entropyToMnemonic,
    // keys.js deriveElectrumKeypair -> agama-wallet-lib/keys.js seedToWif(..., true).
    expect(deriveGiftAddress(Buffer.alloc(32))).toBe('RLGnXMZQKaWVRg6HiqiCcVmpuJSxakgrZc');
    expect(() => deriveGiftAddress(Buffer.alloc(31))).toThrow('32 bytes');
  });
  it('uses the actual unsigned testnet SpendableKeyDetails envelope and preserves entropy', () => {
    const entropy = Buffer.alloc(32, 1);
    const parent = GIFT_TESTNET_SYSTEM;
    const card = makeGiftCard('gentleotter', parent, entropy);
    expect(card.id).toMatch(/^[a-f0-9]{32}$/);
    expect(card.identityName).toBe('gentleotter.vrsctest@');
    expect(card.identityId).toBe(nameAndParentAddrToIAddr('gentleotter', parent));
    const request = GenericRequest.fromWalletDeeplinkUri(card.walletUri);
    expect(request.flags.eq(GenericRequest.FLAG_IS_TESTNET)).toBe(true);
    expect(request.isSigned()).toBe(false);
    expect(request.details).toHaveLength(1);
    const detail = request.details[0] as SpendableKeyDetailsOrdinalVDXFObject;
    expect(detail).toBeInstanceOf(SpendableKeyDetailsOrdinalVDXFObject);
    expect(detail.data.data.equals(entropy)).toBe(true);
    expect(detail.data.isEncrypted()).toBe(false);
    expect(deriveGiftAddress(detail.data.data)).toBe(card.address);
  });
  it('creates 100 unique cards and avoids every previously journaled name', async () => {
    const directory = await temporary();
    const first = await createBatch(100, directory);
    await atomicWritePrivate(join(directory, 'first.state.json'), first);
    const second = await createBatch(100, directory);
    for (const field of ['id', 'address', 'walletUri', 'identityId', 'identityName'] as const) {
      expect(new Set([...first.cards, ...second.cards].map(card => card[field])).size).toBe(200);
    }
    expect(first.cards.every(card => /^[a-z]+\.vrsctest@$/.test(card.identityName))).toBe(true);
  });
  it('rejects invalid sizes and suppresses malformed journal content', async () => {
    const directory = await temporary();
    await expect(createBatch(201, directory)).rejects.toThrow('between 1 and 200');
    await expect(createBatch(0, directory)).rejects.toThrow('between 1 and 200');
    const path = join(directory, 'bad.state.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{"secret":"PRIVATE-BEARER-TEXT"', { mode: 0o600 });
    await expect(createBatch(1, directory)).rejects.toThrow('No private contents are printed');
  });
  it('renames a colliding native name before commitments while preserving the gift key', async () => {
    const batch = await createBatch(1, await temporary());
    const before = { ...batch.cards[0] };
    let writes = 0;
    const rpc = async (_method: string, params?: unknown[]) => {
      if (params?.[0] === before.identityId) return { status: 'active', identity: { primaryaddresses: ['some-other-key'] } };
      throw Object.assign(new Error('Identity not found'), { code: -5 });
    };
    await resolveNativeNameCollisions(batch, rpc, async () => { writes++; });
    expect(writes).toBe(1);
    expect(batch.cards[0].identityName).not.toBe(before.identityName);
    expect(batch.cards[0].identityId).toBe(nameAndParentAddrToIAddr(batch.cards[0].identityName.split('.')[0], GIFT_TESTNET_SYSTEM));
    for (const field of ['address', 'id', 'walletUri'] as const) expect(batch.cards[0][field]).toBe(before[field]);
  });
  it('does not rename a conflicting identity after its registration was saved', async () => {
    const batch = await createBatch(1, await temporary());
    batch.cards[0].registration = { txid: 'a'.repeat(64), hex: 'aa' };
    const before = batch.cards[0].identityName;
    const rpc = async () => ({ status: 'active', identity: { primaryaddresses: ['some-other-key'] } });
    let writes = 0;
    await expect(resolveNativeNameCollisions(batch, rpc, async () => { writes++; })).rejects.toThrow('controlled exclusively');
    expect(writes).toBe(0); expect(batch.cards[0].identityName).toBe(before);
  });
  it('writes private atomic checkpoints and replaces them without widening permissions', async () => {
    const directory = await temporary(); const path = join(directory, 'batch.state.json');
    await atomicWritePrivate(path, { stage: 'prepared' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await atomicWritePrivate(path, { stage: 'broadcast' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ stage: 'broadcast' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('durable local name commitment preparation', () => {
  // Published VRSCTEST chain fixtures from verus-typescript-primitives's
  // identity-registration/veruscoin-v1.json, captured by read-only daemon RPC.
  const fixtures = [
    { name: 'monkins', parent: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
      salt: '7cec9d79bc29327eba3571834e440e32f5f5411bf239bf5413ed64a8603a4f55',
      controller: 'REXBEDfAz9eJMCxdexa5GnWQBAax8hwuiu', identityId: 'iRmBDWNs2WahXDAvS2TEsJyJwwHXhwcs7w',
      script: '1a040300010114397dbe2d918f1bd30c65e36687c10feac0bf4d3fcc3b040311010114397dbe2d918f1bd30c65e36687c10feac0bf4d3f204702a39fc7abe4605d952c4d39b1929a8b147e5153331b71324fdd59e3a24f2d75' },
    { name: 'mobile', parent: 'iHBwQo7LUmb7QKKqbsd8Kw9BxdQvgTdK9f',
      salt: '0bb34b6d5f755e60c553900c4a5741e73eb048f4813f55583a3bedaa599a508a',
      controller: 'RGGfvnyjF1is1jGwPKVSNSDNov6V4aBDMF', identityId: 'iEfHWqHSyHtU6bJokaRhdLm9uFzy8HXTPV',
      script: '1a0403000101144cafb6536134ed179cc135033926e2f534baf07acc3b0403110101144cafb6536134ed179cc135033926e2f534baf07a207f6315c7c6ffc23aec66d2ef84a4b359fc83aa00488db1d7e4ac640b92c8883275' },
  ];
  it.each(fixtures)('matches mined daemon script bytes for $name', fixture => {
    const result = makeCommitmentScript(fixture.name, fixture.parent, fixture.controller, Buffer.from(fixture.salt, 'hex').reverse());
    expect(result.script.toString('hex')).toBe(fixture.script);
    expect(result.namereservation.salt).toBe(fixture.salt);
    expect(result.namereservation.nameid).toBe(fixture.identityId);
  });
  it('commits to the selected referral and preserves it for daemon registration', () => {
    const fixture = fixtures[0]; const salt = Buffer.from(fixture.salt, 'hex').reverse();
    const plain = makeCommitmentScript(fixture.name, fixture.parent, fixture.controller, salt);
    const referred = makeCommitmentScript(fixture.name, fixture.parent, fixture.controller, salt, fixtures[1].identityId);
    expect(referred.namereservation.referral).toBe(fixtures[1].identityId);
    expect(referred.namereservation.nameid).toBe(plain.namereservation.nameid);
    expect(referred.script.equals(plain.script)).toBe(false);
    expect(() => makeCommitmentScript(fixture.name, fixture.parent, fixture.controller, salt, fixture.controller)).toThrow('referral');
  });
  it('rejects malformed commitment context', () => {
    const fixture = fixtures[0];
    expect(() => makeCommitmentScript('bad.name', fixture.parent, fixture.controller)).toThrow('leaf');
    expect(() => makeCommitmentScript('name', fixture.controller, fixture.controller)).toThrow('parent');
    expect(() => makeCommitmentScript('name', fixture.parent, fixture.controller, Buffer.alloc(1))).toThrow('32 bytes');
  });
  it('prepares a fully signed commitment with its allocated input and never broadcasts', async () => {
    const methods: string[] = []; let fundingParams: unknown[] | undefined;
    const rpc = async (method: string, params?: unknown[]) => {
      methods.push(method);
      if (method === 'createrawtransaction') return '01000000000000000000';
      if (method === 'fundrawtransaction') { fundingParams = params; return { hex: 'aa' }; }
      if (method === 'signrawtransaction') return { complete: true, hex: 'bb' };
      if (method === 'decoderawtransaction') return { txid: 'c'.repeat(64) };
      throw new Error('Unexpected RPC');
    };
    const input = { txid: 'd'.repeat(64), vout: 3 };
    const result = await prepareCommitment(rpc, 'gentleotter', fixtures[0].parent, fixtures[0].controller, input);
    expect(result.txid).toBe('c'.repeat(64));
    expect(result.hex).toBe('bb');
    expect(fundingParams?.slice(1)).toEqual([[{ txid: input.txid, voutnum: input.vout }], fixtures[0].controller, 0.0001]);
    expect(methods).toEqual(['createrawtransaction', 'fundrawtransaction', 'signrawtransaction', 'decoderawtransaction']);
  });
  it('refuses invalid or duplicated commitment fee allocations without daemon calls', async () => {
    const rpc = async () => { throw new Error('Must not call daemon'); };
    await expect(prepareCommitmentFeeFunding(rpc, fixtures[0].controller, [])).rejects.toThrow('allocation');
    await expect(prepareCommitmentFeeFunding(rpc, fixtures[0].controller, ['a', 'a'])).rejects.toThrow('allocation');
  });
});


describe('independent native registration fee funding', () => {
  it('funds only unfinished cards at unique operator addresses and resumes without another payment', async () => {
    const batch = await createBatch(3, await temporary());
    batch.cards[0].registration = { hex: 'aa', txid: 'a'.repeat(64) };
    const methods: string[] = []; let addressCount = 0; let paymentOutputs: any;
    const checkpoints: any[] = [];
    const persist = async () => { checkpoints.push(JSON.parse(JSON.stringify(batch))); };
    const rpc = async (method: string, params?: unknown[]) => {
      methods.push(method);
      if (method === 'getnewaddress') return deriveGiftAddress(Buffer.alloc(32, 200 + addressCount++));
      if (method === 'createrawtransaction') { paymentOutputs = params?.[1]; return 'aa'; }
      if (method === 'fundrawtransaction') return { hex: 'bb' };
      if (method === 'signrawtransaction') return { hex: 'cc', complete: true };
      if (method === 'decoderawtransaction') return { txid: 'f'.repeat(64) };
      throw new Error('Unexpected RPC');
    };
    await prepareRegistrationFunding(batch, rpc, persist);
    expect(addressCount).toBe(2);
    expect(batch.cards[0].registrationFundingAddress).toBeUndefined();
    expect(new Set(batch.cards.slice(1).map(card => card.registrationFundingAddress)).size).toBe(2);
    expect(Object.values(paymentOutputs)).toEqual([80.001, 80.001]);
    expect(Object.keys(paymentOutputs).some(address => batch.cards.some(card => card.address === address))).toBe(false);
    expect(batch.registrationFunding?.cardIds).toEqual(batch.cards.slice(1).map(card => card.id));
    expect(checkpoints[0].cards[1].registrationFundingAddress).toBeDefined();
    expect(checkpoints.at(-1).registrationFunding?.hex).toBe('cc');
    const callCount = methods.length;
    await prepareRegistrationFunding(batch, rpc, persist);
    expect(methods.length).toBe(callCount);
    expect(methods).not.toContain('sendrawtransaction');
  });
  it('refuses to use a gift address as an operator fee address', async () => {
    const batch = await createBatch(2, await temporary());
    batch.cards[0].registrationFundingAddress = batch.cards[1].address;
    const rpc = async () => { throw new Error('Must not call daemon'); };
    await expect(prepareRegistrationFunding(batch, rpc, async () => {})).rejects.toThrow('distinct');
  });
});


describe('registration fee input isolation', () => {
  const commitment = { txid: 'a'.repeat(64), vout: 1 };
  const reserved = { txid: 'b'.repeat(64), vout: 3 };
  const oldChange = { txid: 'c'.repeat(64), vout: 0 };
  const ownOutputs = [
    { txid: reserved.txid, outputIndex: reserved.vout, satoshis: 8000100000 },
    { txid: oldChange.txid, outputIndex: oldChange.vout, satoshis: 1027209 },
  ];
  it('accepts reserved funds plus old change owned by this same operator fee address', () => {
    expect(() => assertRegistrationFundingInputs({ vin: [commitment, oldChange, reserved] }, commitment, reserved, ownOutputs)).not.toThrow();
  });
  it('rejects a foreign input even when the correct reservation is also present', () => {
    const foreign = { txid: 'd'.repeat(64), vout: 0 };
    expect(() => assertRegistrationFundingInputs({ vin: [commitment, foreign, reserved] }, commitment, reserved, ownOutputs)).toThrow('unassigned');
  });
  it('does not let another card commitment pass merely because it is indexed under the same address', () => {
    const otherCommitment = { txid: 'e'.repeat(64), vout: 0 };
    const indexed = [...ownOutputs, { txid: otherCommitment.txid, outputIndex: 0, satoshis: 0 }];
    expect(() => assertRegistrationFundingInputs({ vin: [commitment, otherCommitment, reserved] }, commitment, reserved, indexed)).toThrow('unassigned');
  });
  it('rejects duplicate inputs or omission of the dedicated reservation', () => {
    expect(() => assertRegistrationFundingInputs({ vin: [commitment, reserved, reserved] }, commitment, reserved, ownOutputs)).toThrow('unassigned');
    expect(() => assertRegistrationFundingInputs({ vin: [commitment, oldChange] }, commitment, reserved, ownOutputs)).toThrow('unassigned');
  });
});
