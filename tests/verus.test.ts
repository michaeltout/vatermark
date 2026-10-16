import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import { VerusAdapter, VerusError, TESTNET_SYSTEM_ID, GENERIC_RESPONSE_QUERY_KEY } from '../server/verus.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives') as typeof import('verus-typescript-primitives');
const { VerusIdInterface } = require('verusid-ts-client') as typeof import('verusid-ts-client');
// Resolve the exact crypto implementation shipped with the pinned SDK.
const sdkRequire = createRequire(require.resolve('verusid-ts-client'));
const B = sdkRequire('@bitgo/utxo-lib');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
const id = (byte: number) => P.toBase58Check(Buffer.alloc(20, byte), 102);
const cid = (address: string) => new P.CompactIAddressObject({ type: P.CompactIAddressObject.TYPE_I_ADDRESS, address, rootSystemName: 'VRSCTEST' });
const message = `Vatermark image authentication v2\nsha256:${'ab'.repeat(32)}`;
const requestIdHex = 'cd'.repeat(20);
const signatureWrapper = (identityId: string) => new P.VerifiableSignatureData({
  version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
  systemID: cid(TESTNET_SYSTEM_ID), identityID: cid(identityId),
});

/** Deterministic local test identities, never on-chain and never used by the app. */
function fixture() {
  const key = B.ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 7), B.networks.verus);
  const otherKey = B.ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 8), B.networks.verus);
  const signer = id(3), service = id(4), tip = 200, signedHeight = 120;
  const now = Math.floor(Date.now() / 1000);
  const state = { revoked: false, historicalRevoked: false, rotated: false, unavailable: false, mismatchedId: false, wrongNetwork: false, newestHistorical: false, threshold: 1 };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (identityId: string, height?: number) => ({
    identity: { identityaddress: state.mismatchedId ? id(99) : identityId, systemid: TESTNET_SYSTEM_ID, name: identityId === service ? 'local-service' : 'local-signer',
      parent: TESTNET_SYSTEM_ID, version: 3, flags: ((height == null && state.revoked) || (height != null && state.historicalRevoked)) ? 0x8000 : 0,
      minimumsignatures: state.threshold, primaryaddresses: [state.rotated && height == null ? otherKey.getAddress() : key.getAddress()] },
    status: ((height == null && state.revoked) || (height != null && state.historicalRevoked)) ? 'revoked' : 'active',
    blockheight: height == null ? tip : state.newestHistorical ? tip + 1 : 100,
    canspendfor: false, cansignfor: false, txid: '00'.repeat(32), vout: 0,
  });
  const client = new VerusIdInterface('VRSCTEST', 'https://unused.invalid');
  client.interface.getInfo = async () => {
    calls.push({ method: 'getinfo', args: [] });
    if (state.unavailable) throw new Error('Test RPC unavailable');
    return { result: { chainid: TESTNET_SYSTEM_ID, name: 'VRSCTEST', testnet: !state.wrongNetwork, blocks: tip, longestchain: tip }, error: null } as any;
  };
  client.interface.getIdentity = async (identityId: string, height?: number) => {
    calls.push({ method: 'getidentity', args: [identityId, height] });
    if (state.unavailable) throw new Error('Test RPC unavailable');
    return { result: record(identityId, height), error: null } as any;
  };
  client.interface.getBlock = async (height: string) => {
    calls.push({ method: 'getblock', args: [height] });
    return { result: { time: now }, error: null } as any;
  };
  const adapter = new VerusAdapter({ rpcUrl: 'https://unused.invalid', serviceId: service, serviceWif: key.toWIF(), client });
  async function request() { return adapter.createRequest({ message, requestIdHex, callbackUrl: 'https://vatermark.example/api/sign-jobs/test/response' }); }
  async function response(requestHex: string, options: {
    text?: string; innerId?: string; innerHeight?: number; outerHeight?: number;
    change?: (response: InstanceType<typeof P.GenericResponse>, sig: InstanceType<typeof P.SignatureData>) => void;
  } = {}) {
    const req = new P.GenericRequest(); req.fromBuffer(Buffer.from(requestHex, 'hex'));
    const innerId = options.innerId ?? signer;
    const innerHeight = options.innerHeight ?? signedHeight;
    const outerHeight = options.outerHeight ?? tip;
    const inner = signatureWrapper(innerId);
    const requestedText = (req.details[0] as InstanceType<typeof P.DataPacketRequestOrdinalVDXFObject>).data.signableObjects[0] as string;
    const messageHash = hash(options.text ?? requestedText);
    const native = await client.signHash(innerId, inner.getIdentityHash(innerHeight, messageHash), key.toWIF(), record(innerId, innerHeight), innerHeight, TESTNET_SYSTEM_ID);
    inner.signatureAsVch = Buffer.from(native, 'base64');
    const sig = inner.toSignatureData(messageHash);
    const res = new P.GenericResponse({
      flags: P.GenericResponse.FLAG_IS_TESTNET, requestID: req.requestID,
      requestHash: req.getRawDataSha256(), requestHashType: new P.BigNumber(5),
      createdAt: new P.BigNumber(now), handledBy: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
      signature: signatureWrapper(signer),
      details: [new P.DataResponseOrdinalVDXFObject({ data: new P.DataResponseDetails({
        requestID: req.requestID,
        data: new P.DataDescriptor({ objectdata: new P.VdxfUniValue({ values: [{ [P.SignatureDataKey.vdxfid]: sig }] }).toBuffer() }),
      }) })],
    });
    options.change?.(res, sig);
    // Serialize inner changes before signing the outer envelope.
    (res.details[0] as InstanceType<typeof P.DataResponseOrdinalVDXFObject>).data.data.objectdata = new P.VdxfUniValue({ values: [{ [P.SignatureDataKey.vdxfid]: sig }] }).toBuffer();
    await client.signGenericResponse(res, key.toWIF(), record(signer, outerHeight), outerHeight);
    return res.toBuffer();
  }
  return { adapter, client, state, calls, record, request, response, signer, service, key, otherKey, signedHeight, tip };
}
const errorCode = (expected: string) => (error: unknown) => error instanceof VerusError && error.code === expected;

test('service request and Mobile-shaped response verify with real SDK cryptography', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.status(), { enabled: true });
  const req = await f.request();
  assert.match(req.walletUri, /^verus:\/\/1\//);
  assert.equal(req.requestHashHex.length, 64);
  const body = await f.response(req.requestHex);
  const result = await f.adapter.verifyResponse({ body, requestHex: req.requestHex, message, requestIdHex });
  assert.equal(result.identityId, f.signer);
  assert.equal(result.systemId, TESTNET_SYSTEM_ID);
  assert.equal(Buffer.from(result.nativeSignature, 'base64').length, 73);
  assert.equal(result.identity.height, f.signedHeight);
  assert.equal(result.displayIdentity.currentStatus, 'active');
  assert.ok(f.calls.some(c => c.method === 'getidentity' && c.args[1] === f.signedHeight));
  assert.ok(f.calls.some(c => c.method === 'getidentity' && c.args[1] === f.tip));
  assert.ok(f.calls.every(c => ['getinfo', 'getidentity', 'getblock'].includes(c.method)));
  assert.ok(!JSON.stringify(f.calls).includes(f.key.toWIF()));
});

test('requests advertise only the selected wallet transport and allow HTTP redirects', async () => {
  const f = fixture();
  assert.equal(GENERIC_RESPONSE_QUERY_KEY, 'i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC');
  for (const callbackUrl of ['http://127.0.0.1:5173/api/sign-jobs/test/response', 'http://192.168.1.10:5173/api/sign-jobs/test/response', 'https://vatermark.example/callback']) {
    const signed = await f.adapter.createRequest({ message, requestIdHex, callbackUrl, responseMode: 'redirect' });
    const req = P.GenericRequest.fromWalletDeeplinkUri(signed.walletUri);
    assert.equal(req.responseURIs!.length, 1);
    assert.ok(req.responseURIs![0].type.eq(P.ResponseURI.TYPE_REDIRECT));
    assert.equal(req.responseURIs![0].getUriString(), callbackUrl);
    assert.ok(await f.client.verifyGenericRequest(req, f.record(f.service, f.tip) as any, TESTNET_SYSTEM_ID, Math.floor(Date.now() / 1000)));
  }
  for (const responseMode of [undefined, 'post'] as const) {
    const signed = await f.adapter.createRequest({ message, requestIdHex, callbackUrl: 'https://vatermark.example/callback', responseMode });
    const req = P.GenericRequest.fromWalletDeeplinkUri(signed.walletUri);
    assert.equal(req.responseURIs!.length, 1);
    assert.ok(req.responseURIs![0].type.eq(P.ResponseURI.TYPE_POST));
    await assert.rejects(f.adapter.createRequest({ message, requestIdHex, callbackUrl: 'http://localhost:5173/callback', responseMode }), errorCode('INVALID_SIGNATURE'));
  }
  for (const callbackUrl of ['file:///tmp/callback', 'javascript:alert(1)', 'https://user:password@example.invalid/callback', 'http://localhost:5173/callback#fragment']) {
    await assert.rejects(f.adapter.createRequest({ message, requestIdHex, callbackUrl, responseMode: 'redirect' }), errorCode('INVALID_SIGNATURE'));
  }
});

test('SDK hashes UTF-8 data with the exact native Verus prefix', () => {
  const sig = signatureWrapper(id(3));
  const height = Buffer.alloc(4); height.writeUInt32LE(120);
  const expected = hash(Buffer.concat([
    P.fromBase58Check(TESTNET_SYSTEM_ID).hash, height, P.fromBase58Check(id(3)).hash,
    Buffer.from([19]), Buffer.from('Verus signed data:\n'), hash(message),
  ]));
  assert.deepEqual(sig.getIdentityHash(120, hash(message)), expected);
});

test('current Mobile outer wrapper 0 is accepted only with the standard native v2 signature', async () => {
  const f = fixture(); const req = await f.request();
  const body = await f.response(req.requestHex, { change: r => { r.signature!.version = new P.BigNumber(0); } });
  const verified = await f.adapter.verifyResponse({ body, requestHex: req.requestHex, message, requestIdHex });
  assert.equal(verified.identityId, f.signer);
});

test('Rust profile 0x41 and SDK agree on the independent canonical signing vector', () => {
  const vector = JSON.parse(readFileSync(new URL('../engine/tests/fixtures/mobile-profile.json', import.meta.url), 'utf8'));
  assert.equal(hash(vector.message).toString('hex'), vector.messageHash);
  const sig = new P.SignatureData({
    version: new P.BigNumber(1), systemID: vector.systemId, identityID: vector.identityId,
    hashType: new P.BigNumber(5), sigType: new P.BigNumber(1), signatureHash: hash(vector.message),
  });
  assert.equal(sig.getIdentityHash({ version: 2, hash_type: 5, height: vector.signingHeight }).toString('hex'), vector.nativeDigest);
});

test('key rotation preserves historical signing authority', async () => {
  const f = fixture(); const req = await f.request(); const body = await f.response(req.requestHex);
  f.state.rotated = true;
  const result = await f.adapter.verifyResponse({ body, requestHex: req.requestHex, message, requestIdHex });
  assert.equal(result.identity.primary_addresses[0], f.key.getAddress());
});

test('current revocation remains separately visible during image verification', async () => {
  const f = fixture(); f.state.revoked = true;
  const result = await f.adapter.resolveIdentity({ identityId: f.signer, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: 120 });
  assert.equal(result.currentActive, false);
  assert.equal(result.identity.revoked, false);
  assert.equal(result.displayIdentity.currentStatus, 'revoked');
});

test('Verify identity resolution works without a service key', async () => {
  const f = fixture(); const adapter = new VerusAdapter({ rpcUrl: 'https://unused.invalid', client: f.client });
  assert.equal((await adapter.status()).enabled, false);
  assert.equal((await adapter.resolveIdentity({ identityId: f.signer, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: 120 })).currentActive, true);
});

test('unauthorized service WIF disables Sign without leaking the key', async () => {
  const f = fixture(); const adapter = new VerusAdapter({ rpcUrl: 'https://unused.invalid', serviceId: f.service, serviceWif: f.otherKey.toWIF(), client: f.client });
  const status = await adapter.status();
  assert.equal(status.enabled, false);
  assert.ok(!JSON.stringify(status).includes(f.otherKey.toWIF()));
  await assert.rejects(adapter.createRequest({ message, requestIdHex, callbackUrl: 'https://example.invalid/callback' }), errorCode('SERVICE_UNAVAILABLE'));
});

test('callback rejects wrong request hash, detail ID, signed message, signer, wrapper, and network', async () => {
  const cases = [
    { name: 'wrong job hash', change: (r: any) => { r.requestHash = Buffer.alloc(32); } },
    { name: 'wrong detail ID', change: (r: any) => { r.details[0].data.requestID = cid(id(22)); } },
    { name: 'wrong outer ID', change: (r: any) => { r.requestID = cid(id(22)); } },
    { name: 'wrong image hash', text: `${message.slice(0, -1)}0` },
    { name: 'different inner signer', innerId: id(9) },
    { name: 'invalid outer wrapper', change: (r: any) => { r.signature.version = new P.BigNumber(2); } },
    { name: 'inner wrapper0 is not legacy compatible', change: (_r: any, s: any) => { s.version = new P.BigNumber(0); } },
    { name: 'invalid inner wrapper', change: (_r: any, s: any) => { s.version = new P.BigNumber(2); } },
    { name: 'mainnet response', code: 'UNSUPPORTED_NETWORK', change: (r: any) => { r.flags = r.flags.and(new P.BigNumber(0xffff - 16)); } },
    { name: 'different inner system', code: 'UNSUPPORTED_NETWORK', change: (_r: any, s: any) => { s.systemID = P.DEFAULT_VERUS_CHAINID; } },
    { name: 'extra signed context', change: (_r: any, s: any) => { s.boundHashes = [Buffer.alloc(32)]; } },
    { name: 'wrong native version', change: (_r: any, s: any) => { s.signatureAsVch[0] = 1; } },
  ];
  for (const c of cases) {
    const f = fixture(); const req = await f.request(); const body = await f.response(req.requestHex, c);
    await assert.rejects(f.adapter.verifyResponse({ body, requestHex: req.requestHex, message, requestIdHex }), errorCode(c.code ?? 'INVALID_SIGNATURE'));
  }
});

test('callback rejects truncation, trailing bytes, bad compact signatures, and unknown profile', async () => {
  const f = fixture(); const req = await f.request(); const body = await f.response(req.requestHex);
  for (const bytes of [Buffer.alloc(0), body.subarray(0, -1), Buffer.concat([body, Buffer.from([0])]), Buffer.alloc(65_537)]) {
    await assert.rejects(f.adapter.verifyResponse({ body: bytes, requestHex: req.requestHex, message, requestIdHex }), errorCode('INVALID_SIGNATURE'));
  }
  await assert.rejects(f.adapter.verifyResponse({ body, requestHex: req.requestHex, message: message.replace('v2', 'v1'), requestIdHex }), errorCode('INVALID_SIGNATURE'));
  const forged = await f.response(req.requestHex, { change: (_r, s) => { s.signatureAsVch[20] ^= 1; } });
  await assert.rejects(f.adapter.verifyResponse({ body: forged, requestHex: req.requestHex, message, requestIdHex }), errorCode('INVALID_SIGNATURE'));
});

test('revoked and multisignature identities cannot complete new signing jobs', async () => {
  for (const policy of ['revoked', 'historicalRevoked', 'threshold'] as const) {
    const f = fixture(); const req = await f.request(); const body = await f.response(req.requestHex);
    if (policy === 'threshold') f.state.threshold = 2; else f.state[policy] = true;
    await assert.rejects(f.adapter.verifyResponse({ body, requestHex: req.requestHex, message, requestIdHex }), errorCode('INVALID_SIGNATURE'));
  }
});

test('chain outage, inconsistent historical records, and unavailable future heights are not forgery results', async () => {
  for (const mode of ['unavailable', 'mismatchedId', 'newestHistorical', 'future'] as const) {
    const f = fixture(); const req = await f.request(); const body = await f.response(req.requestHex, mode === 'future' ? { innerHeight: 201 } : {});
    if (mode !== 'future') f.state[mode] = true;
    await assert.rejects(f.adapter.verifyResponse({ body, requestHex: req.requestHex, message, requestIdHex }), errorCode('CHAIN_UNAVAILABLE'));
  }
});

test('configured mainnet RPC and mainnet image fail explicitly', async () => {
  const f = fixture(); f.state.wrongNetwork = true;
  await assert.rejects(f.adapter.resolveIdentity({ identityId: f.signer, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: 120 }), errorCode('UNSUPPORTED_NETWORK'));
  await assert.rejects(f.adapter.resolveIdentity({ identityId: f.signer, systemId: P.DEFAULT_VERUS_CHAINID, testnet: false, signingHeight: 120 }), errorCode('UNSUPPORTED_NETWORK'));
});

// Small dependency-free PNG fixture with a stable, textured descriptor. This
// exercises odd rectangular dimensions as well as the real image channel.
function fixturePng(width = 641, height = 481): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const base = 128 + 38 * Math.sin(x / 21) + 25 * Math.cos(y / 33);
    const offset = y * (1 + width * 3) + 1 + x * 3;
    raw[offset] = Math.trunc(base + (x * 7 + y * 13) % 19 - 9);
    raw[offset + 1] = Math.trunc(base);
    raw[offset + 2] = Math.trunc(base - 12);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffff_ffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test.each(['post', 'redirect'] as const)('real API → wallet SDK %s callback → Rust watermark → download → keyless verification', async (responseMode) => {
  const f = fixture();
  const temp = mkdtempSync(path.join(tmpdir(), 'vatermark-sdk-engine-'));
  const config = loadConfig({ DATA_DIR: path.join(temp, '.data', 'sign'), PUBLIC_ORIGIN: responseMode === 'redirect' ? 'http://127.0.0.1:5173' : 'https://vatermark.example', WALLET_RESPONSE_MODE: responseMode });
  const app = await createApp(config, { adapter: f.adapter });
  let verifyApp: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const owner = request.agent(app.app);
    await owner.get('/api/config').expect(200);
    const submitted = await owner.post('/api/sign-jobs').attach('image', fixturePng(), 'local-fixture.png').expect(201);
    assert.equal(submitted.body.status, 'awaiting_signature');
    assert.equal(submitted.body.width, 641); assert.equal(submitted.body.height, 481);
    const walletRequest = P.GenericRequest.fromWalletDeeplinkUri(submitted.body.walletUri);
    assert.equal(walletRequest.responseURIs!.length, 1);
    assert.ok(walletRequest.responseURIs![0].type.eq(responseMode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST));
    const body = await f.response(walletRequest.toBuffer().toString('hex'), {
      // Match the current Mobile outer-wrapper default exactly.
      change: r => { r.signature!.version = new P.BigNumber(0); },
    });
    const endpoint = `/api/sign-jobs/${submitted.body.id}/response`;
    const deliver = async (mode: 'post' | 'redirect', payload: Buffer, expectedError?: string) => {
      if (mode === 'post') {
        const result = await request(app.app).post(endpoint).set('Content-Type', 'application/octet-stream').send(payload).expect(expectedError ? 422 : 200);
        if (expectedError) assert.equal(result.body.error.code, expectedError); else assert.equal(result.body.accepted, true);
      } else {
        // Match Mobile's URLSearchParams.set(key, base64url(response.toBuffer())).
        const query = new URLSearchParams({ [GENERIC_RESPONSE_QUERY_KEY]: payload.toString('base64url') });
        const result = await request(app.app).get(`${endpoint}?${query}`).expect(303);
        const returned = new URL(result.headers.location, 'http://local.invalid');
        assert.equal(returned.pathname, '/');
        assert.equal(returned.searchParams.get('walletReturn'), submitted.body.id);
        assert.equal(returned.searchParams.get('returnError'), expectedError ?? null);
        assert.equal(returned.searchParams.has(GENERIC_RESPONSE_QUERY_KEY), false);
      }
    };
    // Both transports must verify identical cryptographic request bindings.
    const wrongHash = await f.response(walletRequest.toBuffer().toString('hex'), { change: r => { r.requestHash = Buffer.alloc(32); } });
    const otherRequest = await f.request();
    const otherJobBody = await f.response(otherRequest.requestHex);
    for (const mode of ['post', 'redirect'] as const) {
      await deliver(mode, wrongHash, 'INVALID_SIGNATURE');
      await deliver(mode, otherJobBody, 'INVALID_SIGNATURE');
    }
    assert.equal((await owner.get(`/api/sign-jobs/${submitted.body.id}`).expect(200)).body.status, 'awaiting_signature');
    await deliver(responseMode, body);
    let job: any;
    for (let attempt = 0; attempt < 500; attempt++) {
      const poll = await owner.get(`/api/sign-jobs/${submitted.body.id}`).expect(200);
      job = poll.body;
      if (job.status === 'complete') break;
      assert.equal(job.status, 'finalizing', JSON.stringify(job));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(job.status, 'complete');
    assert.equal(job.verification.signature_valid, true);
    assert.equal(job.verification.version_type, 65);
    assert.equal(job.identity.id, f.signer);
    // Replaying the same accepted bytes remains idempotent across transports.
    await deliver('post', body);
    await deliver('redirect', body);
    const download = await owner.get(job.downloadUrl).expect(200).expect('Content-Type', /image\/png/);
    assert.ok(Buffer.isBuffer(download.body));
    await request(app.app).get(job.downloadUrl).expect(404);

    // A separate process-equivalent app has no service identity or WIF. It must
    // reconstruct the descriptor from downloaded pixels and fetch authority.
    verifyApp = await createApp(loadConfig({ DATA_DIR: path.join(temp, 'verify') }), {
      adapter: new VerusAdapter({ rpcUrl: 'https://unused.invalid', client: f.client }),
    });
    const keyless = request.agent(verifyApp.app);
    assert.equal((await keyless.get('/api/config')).body.signing.enabled, false);
    f.state.rotated = true;
    const verified = await keyless.post('/api/verify').attach('image', download.body, 'signed.png').expect(200);
    assert.equal(verified.body.status, 'verified', JSON.stringify(verified.body));
    assert.equal(verified.body.identity.id, f.signer);
    assert.equal(verified.body.identity.signingHeight, f.signedHeight);
    assert.equal(verified.body.verification.signature_valid, true);
    f.state.revoked = true;
    const revoked = await keyless.post('/api/verify').attach('image', download.body, 'signed.png').expect(200);
    assert.equal(revoked.body.status, 'revoked');
    assert.equal(revoked.body.verification.signature_valid, true);
    f.state.unavailable = true;
    const unavailable = await keyless.post('/api/verify').attach('image', download.body, 'signed.png').expect(200);
    assert.equal(unavailable.body.status, 'unavailable');
  } finally {
    await app.close(); await verifyApp?.close();
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);
