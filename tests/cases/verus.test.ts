import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { TESTNET_SYSTEM_ID } from '../../server/verus.js';
import { CASE_STATEMENT, CasesVerusAdapter, EXPORT_ATTESTATION, isCasesAdapter, keyStateOf, nativeSignatureHeight } from '../../server/cases/verus.js';
import { ZERO_HASH, buildStatement } from '../../server/cases/protocol.js';
import { POLICY_HASH, POLICY_ID } from '../../server/cases/policy.js';

// The Cases adapter with a mocked chain and the real pinned SDK cryptography:
// requests are really signed by the service key, responses really signed by
// the clinician key, and the adapter's checks are exercised on real bytes.
const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives') as typeof import('verus-typescript-primitives');
const { VerusIdInterface } = require('verusid-ts-client') as typeof import('verusid-ts-client');
const B = createRequire(require.resolve('verusid-ts-client'))('@bitgo/utxo-lib');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
const id = (byte: number) => P.toBase58Check(Buffer.alloc(20, byte), 102);
const cid = (address: string) => new P.CompactIAddressObject({ type: P.CompactIAddressObject.TYPE_I_ADDRESS, address, rootSystemName: 'VRSCTEST' });
const wrapper = (identityId: string) => new P.VerifiableSignatureData({ version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true, systemID: cid(TESTNET_SYSTEM_ID), identityID: cid(identityId) });
const requestIdHex = 'cd'.repeat(20);
const imageMessage = `Vatermark image authentication v2\nsha256:${'ab'.repeat(32)}`;
const callbackUrl = 'http://127.0.0.1:5173/api/cases/attestations/0123456789abcdef0123456789abcdef/response';

function fixture() {
  const key = B.ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 7), B.networks.verus);
  const otherKey = B.ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 8), B.networks.verus);
  const signer = id(3), service = id(4), stranger = id(5), tip = 200, signedHeight = 120;
  const names: Record<string, string> = { [signer]: 'local-signer', [service]: 'local-service', [stranger]: 'local-stranger' };
  const now = Math.floor(Date.now() / 1000);
  const state = { revoked: false, rotated: false };
  const record = (identityId: string, height?: number) => ({
    identity: { identityaddress: identityId, systemid: TESTNET_SYSTEM_ID, name: names[identityId] ?? 'unknown', parent: TESTNET_SYSTEM_ID, version: 3,
      flags: height == null && state.revoked ? 0x8000 : 0, minimumsignatures: 1,
      primaryaddresses: [state.rotated && height == null ? otherKey.getAddress() : key.getAddress()] },
    status: height == null && state.revoked ? 'revoked' : 'active', blockheight: height == null ? tip : 100,
    canspendfor: false, cansignfor: false, txid: '00'.repeat(32), vout: 0,
  });
  const client = new VerusIdInterface('VRSCTEST', 'https://unused.invalid');
  client.interface.getInfo = async () => ({ result: { chainid: TESTNET_SYSTEM_ID, name: 'VRSCTEST', testnet: true, blocks: tip, longestchain: tip }, error: null } as any);
  client.interface.getIdentity = async (query: string, height?: number) => {
    const identityId = Object.entries(names).find(([, name]) => `${name}@` === query)?.[0] ?? query;
    if (!names[identityId]) throw new Error('Test identity not found');
    return { result: record(identityId, height), error: null } as any;
  };
  client.interface.getBlock = async (height: string) => ({ result: Number(height) <= tip ? { hash: 'ab'.repeat(32), height: Number(height), time: now } : { time: now }, error: null } as any);
  const adapter = new CasesVerusAdapter({ rpcUrl: 'https://unused.invalid', serviceId: service, serviceWif: key.toWIF(), client });
  const statement = buildStatement({ type: 'CASE_CREATED', case: 'VC-7K3M-Q9ZD-4XHB', seq: 1, prev: ZERO_HASH, artifact: 'ef'.repeat(32), actor: signer, actorName: 'local-signer@',
    policy: POLICY_ID, policyHash: POLICY_HASH, block: { height: signedHeight, hash: 'ab'.repeat(32) }, at: '2026-10-15T10:30:00Z', nonce: requestIdHex });
  /** What Verus Mobile returns: the actor's native signature over the statement, wrapped in a signed GenericResponse. */
  async function response(requestHex: string, options: { text?: string; innerId?: string; innerHeight?: number; outerId?: string } = {}) {
    const req = new P.GenericRequest(); req.fromBuffer(Buffer.from(requestHex, 'hex'));
    const innerId = options.innerId ?? signer;
    const innerHeight = options.innerHeight ?? signedHeight;
    const outerId = options.outerId ?? innerId;
    const inner = wrapper(innerId);
    const requested = (req.details[0] as InstanceType<typeof P.DataPacketRequestOrdinalVDXFObject>).data.signableObjects[0] as string;
    const messageHash = hash(options.text ?? requested);
    const native = await client.signHash(innerId, inner.getIdentityHash(innerHeight, messageHash), key.toWIF(), record(innerId, innerHeight) as any, innerHeight, TESTNET_SYSTEM_ID);
    inner.signatureAsVch = Buffer.from(native, 'base64');
    const sig = inner.toSignatureData(messageHash);
    const res = new P.GenericResponse({
      flags: P.GenericResponse.FLAG_IS_TESTNET, requestID: req.requestID, requestHash: req.getRawDataSha256(), requestHashType: new P.BigNumber(5),
      createdAt: new P.BigNumber(now), handledBy: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID, signature: wrapper(outerId),
      details: [new P.DataResponseOrdinalVDXFObject({ data: new P.DataResponseDetails({
        requestID: req.requestID, data: new P.DataDescriptor({ objectdata: new P.VdxfUniValue({ values: [{ [P.SignatureDataKey.vdxfid]: sig }] }).toBuffer() }),
      }) })],
    });
    await client.signGenericResponse(res, key.toWIF(), record(outerId, tip) as any, tip);
    return res.toBuffer();
  }
  return { adapter, client, key, otherKey, state, record, signer, service, stranger, tip, signedHeight, statement, response };
}

describe('case statements through Verus Mobile', () => {
  it('issues a case statement as the single signable object of a service-signed request', async () => {
    const f = fixture();
    for (const responseMode of ['redirect', 'post'] as const) {
      const signed = await f.adapter.createCaseRequest({ message: f.statement, requestIdHex, callbackUrl: callbackUrl.replace('http:', responseMode === 'post' ? 'https:' : 'http:'), responseMode });
      const request = P.GenericRequest.fromWalletDeeplinkUri(signed.walletUri);
      expect(signed.walletUri.startsWith('verus://')).toBe(true);
      expect(request.responseURIs![0].type.eq(responseMode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST)).toBe(true);
      expect((request.details[0] as InstanceType<typeof P.DataPacketRequestOrdinalVDXFObject>).data.signableObjects).toEqual([f.statement]);
      expect(signed.requestHex).toBe(request.toBuffer().toString('hex'));
    }
    // Only case statements: the app's image profile and near-misses are refused before any signing.
    await expect(f.adapter.createCaseRequest({ message: imageMessage, requestIdHex, callbackUrl })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.adapter.createCaseRequest({ message: `${f.statement}\n`, requestIdHex, callbackUrl })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.adapter.createCaseRequest({ message: f.statement, requestIdHex, callbackUrl, responseMode: 'post' })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(CASE_STATEMENT.test(f.statement)).toBe(true);
  });

  it('accepts the actor’s signed response and refuses other signers, other texts, other requests and revoked identities', async () => {
    const f = fixture();
    const signed = await f.adapter.createCaseRequest({ message: f.statement, requestIdHex, callbackUrl });
    const input = { requestHex: signed.requestHex, message: f.statement, requestIdHex };
    const verified = await f.adapter.verifyCaseResponse({ ...input, body: await f.response(signed.requestHex) });
    expect(verified.identityId).toBe(f.signer);
    expect(verified.systemId).toBe(TESTNET_SYSTEM_ID);
    expect(verified.identity.height).toBe(f.signedHeight);
    expect(nativeSignatureHeight(verified.nativeSignature)).toBe(f.signedHeight);
    expect(verified.displayIdentity).toMatchObject({ id: f.signer, name: 'local-signer', currentStatus: 'active' });
    // A different signer, even with a valid signature, is not the actor the statement names.
    const other = await f.adapter.verifyCaseResponse({ ...input, body: await f.response(signed.requestHex, { innerId: f.stranger }) });
    expect(other.identityId).toBe(f.stranger);
    await expect(f.adapter.verifyCaseResponse({ ...input, body: await f.response(signed.requestHex, { text: `${f.statement} ` }) })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.adapter.verifyCaseResponse({ ...input, body: await f.response(signed.requestHex, { innerId: f.stranger, outerId: f.signer }) })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.adapter.verifyCaseResponse({ ...input, requestIdHex: 'ee'.repeat(20), body: await f.response(signed.requestHex) })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.adapter.verifyCaseResponse({ ...input, message: imageMessage, body: await f.response(signed.requestHex) })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.adapter.verifyCaseResponse({ ...input, body: Buffer.from('not a response') })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    f.state.revoked = true;
    await expect(f.adapter.verifyCaseResponse({ ...input, body: await f.response(signed.requestHex) })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('verifies statement signatures online and offline, reports key changes, and attests exports with the service identity', async () => {
    const f = fixture();
    const signed = await f.adapter.createCaseRequest({ message: f.statement, requestIdHex, callbackUrl });
    const verified = await f.adapter.verifyCaseResponse({ requestHex: signed.requestHex, message: f.statement, requestIdHex, body: await f.response(signed.requestHex) });
    const online = await f.adapter.verifyStatement({ identityId: f.signer, statement: f.statement, nativeSignature: verified.nativeSignature });
    expect(online).toMatchObject({ valid: true, height: f.signedHeight, source: 'chain', currentActive: true, name: 'local-signer' });
    expect(keyStateOf(online.record, online.current)).toBe('unchanged');
    const offline = await f.adapter.verifyStatement({ identityId: f.signer, statement: f.statement, nativeSignature: verified.nativeSignature, record: f.record(f.signer, f.signedHeight) });
    expect(offline).toMatchObject({ valid: true, source: 'supplied' });
    expect(offline.currentActive).toBeUndefined();
    expect((await f.adapter.verifyStatement({ identityId: f.signer, statement: `${f.statement}\n`, nativeSignature: verified.nativeSignature })).valid).toBe(false);
    expect((await f.adapter.verifyStatement({ identityId: f.stranger, statement: f.statement, nativeSignature: verified.nativeSignature })).valid).toBe(false);
    // Keys rotated after signing: the signature stays valid at its height and the change is reported.
    f.state.rotated = true;
    const rotated = await f.adapter.verifyStatement({ identityId: f.signer, statement: f.statement, nativeSignature: verified.nativeSignature });
    expect(rotated.valid).toBe(true);
    expect(keyStateOf(rotated.record, rotated.current)).toBe('rotated');
    f.state.rotated = false;
    const text = `clinical-workflow-export-attestation/v1\ncase:VC-7K3M-Q9ZD-4XHB\nevents:1\nhead:${'ab'.repeat(32)}\nat:2026-10-15T10:30:00Z`;
    expect(EXPORT_ATTESTATION.test(text)).toBe(true);
    const attestation = await f.adapter.signStatement(text);
    expect(attestation).toMatchObject({ identityId: f.service, name: 'local-service', height: f.tip });
    expect((await f.adapter.verifyStatement({ identityId: f.service, statement: text, nativeSignature: attestation.native })).valid).toBe(true);
    const wrongKey = new CasesVerusAdapter({ rpcUrl: 'https://unused.invalid', serviceId: f.service, serviceWif: f.otherKey.toWIF(), client: f.client });
    await expect(wrongKey.signStatement(text)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(new CasesVerusAdapter({ rpcUrl: 'https://unused.invalid', client: f.client }).signStatement(text)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('reads identities, blocks and evidence from VRSCTEST', async () => {
    const f = fixture();
    expect(await f.adapter.lookupIdentity('local-signer')).toEqual({ id: f.signer, name: 'local-signer', active: true });
    expect(await f.adapter.lookupIdentity(' local-signer@ ')).toEqual({ id: f.signer, name: 'local-signer', active: true });
    expect(await f.adapter.lookupIdentity(f.signer)).toEqual({ id: f.signer, name: 'local-signer', active: true });
    await expect(f.adapter.lookupIdentity('nobody')).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
    await expect(f.adapter.lookupIdentity('bad name!')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    f.state.revoked = true;
    expect((await f.adapter.lookupIdentity('local-signer')).active).toBe(false);
    f.state.revoked = false;
    expect(await f.adapter.chainBlock()).toMatchObject({ height: f.tip, hash: 'ab'.repeat(32) });
    expect((await f.adapter.chainBlock(f.signedHeight)).height).toBe(f.signedHeight);
    await expect(f.adapter.chainBlock(f.tip + 1)).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
    const evidence = await f.adapter.identityEvidence(f.signer, f.signedHeight);
    expect(evidence.atHeight.blockheight).toBe(100);
    expect(evidence.current.blockheight).toBe(f.tip);
    expect(isCasesAdapter(f.adapter)).toBe(true);
    expect(isCasesAdapter({ status() {}, resolveIdentity() {}, createRequest() {}, verifyResponse() {} })).toBe(false);
  });
});
