import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MetadataService, validateMetadata, MAX_METADATA_BYTES } from '../server/metadata.js';
import QRCode from 'qrcode';
import { RustWorker } from '../server/worker.js';
import { MetadataVerusAdapter, descriptorJsonToHex, descriptorHexToJson, parseMetadataPayload } from '../server/metadata-verus.js';
import { VerusError, TESTNET_SYSTEM_ID } from '../server/verus.js';
const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives') as typeof import('verus-typescript-primitives');
const { VerusIdInterface } = require('verusid-ts-client') as typeof import('verusid-ts-client');
const B = createRequire(require.resolve('verusid-ts-client'))('@bitgo/utxo-lib');
const cid = (address: string) => new P.CompactIAddressObject({ type: P.CompactIAddressObject.TYPE_I_ADDRESS, address, rootSystemName: 'VRSCTEST' });
const signature = (identityId: string) => new P.VerifiableSignatureData({ version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true, systemID: cid(TESTNET_SYSTEM_ID), identityID: cid(identityId) });
const locator = 'ab'.repeat(32), requestIdHex = 'cd'.repeat(20), txid = 'ef'.repeat(32);
const descriptor = { version: 1, flags: 5, objectdata: '01'.repeat(100), epk: '02'.repeat(32) };
const descriptorHex = descriptorJsonToHex(descriptor);
const plaintext = JSON.stringify({ schema: 'vatermark-image-metadata', version: 1, locator, data: { title: 'Café by the sea 🌊' } });
// This public example Sapling address is never used to receive funds.
const zAddress = 'zs1wczplx4kegw32h8g0f7xwl57p5tvnprwdmnzmdnsw50chcl26f7tws92wk2ap03ykaq6jyyztfa';
const vdxfDescriptor = () => new P.VdxfUniValue({ values: [{ [P.DataDescriptorKey.vdxfid]: P.DataDescriptor.fromJson(descriptor) }] }).toBuffer().toString('hex');
const code = (expected: string) => (e: unknown) => e instanceof VerusError && e.code === expected;
function fixture() {
  const key = B.ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 7), B.networks.verus);
  const serviceName = 'local-service', signerName = 'local-signer';
  const service = P.nameAndParentAddrToIAddr(serviceName, TESTNET_SYSTEM_ID);
  const signer = P.nameAndParentAddrToIAddr(signerName, TESTNET_SYSTEM_ID);
  const other = P.nameAndParentAddrToIAddr('other-signer', TESTNET_SYSTEM_ID);
  const tip = 200, now = Math.floor(Date.now() / 1000);
  const state = { revoked: false, aggregate: [] as unknown[], history: [] as any[], transaction: null as any };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (identityId: string, height?: number) => ({ identity: {
    identityaddress: identityId, name: identityId === service ? serviceName : identityId === signer ? signerName : 'other-signer',
    parent: TESTNET_SYSTEM_ID, systemid: TESTNET_SYSTEM_ID, version: 3, flags: state.revoked ? 0x8000 : 0,
    minimumsignatures: 1, primaryaddresses: [key.getAddress()],
  }, fullyqualifiedname: `${identityId === service ? serviceName : signerName}.VRSCTEST@`, status: state.revoked ? 'revoked' : 'active', blockheight: height == null ? tip : 100,
  canspendfor: false, cansignfor: false, txid, vout: 0 });
  const client = new VerusIdInterface('VRSCTEST', 'https://unused.invalid');
  client.interface.getInfo = async () => ({ result: { chainid: TESTNET_SYSTEM_ID, name: 'VRSCTEST', testnet: true, blocks: tip }, error: null } as any);
  client.interface.getIdentity = async (identityId: string, height?: number) => ({ result: record(identityId, height), error: null } as any);
  client.interface.getBlock = async () => ({ result: { time: now }, error: null } as any);
  client.interface.getIdentityContent = async (...args: any[]) => {
    calls.push({ method: 'getidentitycontent', args });
    return { result: { ...record(signer), identity: { ...record(signer).identity, contentmultimap: { [args[5]]: state.aggregate } } }, error: null } as any;
  };
  client.interface.request = async (req: any) => {
    calls.push({ method: req.cmd, args: req.getParams() });
    return { result: { fullyqualifiedname: `${signerName}.VRSCTEST@`, txid, history: state.history }, error: null } as any;
  };
  client.interface.getRawTransaction = async (...args: any[]) => {
    calls.push({ method: 'getrawtransaction', args });
    return { result: state.transaction, error: null } as any;
  };
  const adapter = new MetadataVerusAdapter({ rpcUrl: 'https://unused.invalid', serviceId: service, serviceWif: key.toWIF(), client });
  const create = (responseMode: 'redirect' | 'post' = 'redirect', message = plaintext) => adapter.createMetadataRequest({ identityId: signer, locator, plaintext: message, zAddress, requestIdHex, callbackUrl: 'https://example.invalid/api/sign-jobs/job/metadata/response', responseMode });
  async function response(requestHex: string, change?: (response: InstanceType<typeof P.GenericResponse>) => void, responseSigner = signer) {
    const req = new P.GenericRequest(); req.fromBuffer(Buffer.from(requestHex, 'hex'));
    const res = new P.GenericResponse({ flags: P.GenericResponse.FLAG_IS_TESTNET, requestID: req.requestID, requestHash: req.getRawDataSha256(), requestHashType: new P.BigNumber(5),
      createdAt: new P.BigNumber(now), handledBy: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID, signature: signature(responseSigner),
      details: [new P.IdentityUpdateResponseOrdinalVDXFObject({ data: new P.IdentityUpdateResponseDetails({ requestID: req.requestID, txid: Buffer.from(txid, 'hex').reverse() }) })] });
    change?.(res);
    await client.signGenericResponse(res, key.toWIF(), record(responseSigner, tip) as any, tip);
    return res.toBuffer();
  }
  return { adapter, client, state, calls, key, service, signer, other, record, create, response };
}

test('metadata request exposes plaintext PartialSignData for wallet encryption to the image Sapling address', async () => {
  const f = fixture();
  for (const mode of ['redirect', 'post'] as const) {
    const signed = await f.create(mode);
    const request = P.GenericRequest.fromWalletDeeplinkUri(signed.walletUri);
    assert.equal(request.responseURIs!.length, 1);
    assert.ok(request.responseURIs![0].type.eq(mode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST));
    const details = (request.details[0] as InstanceType<typeof P.IdentityUpdateRequestOrdinalVDXFObject>).data;
    assert.equal(details.getIdentityAddress(true), f.signer);
    assert.equal(details.identity!.contains.toNumber(), 3);
    assert.equal(details.signDataMap!.size, 1);
    const cli = details.toCLIJson();
    assert.deepEqual(Object.keys(cli).sort(), ['contentmultimap', 'identityaddress', 'name', 'parent']);
    const [fqn] = details.getContentMultiMapKeys();
    assert.equal(P.toIAddress(fqn!.split('::')[0]!, 'VRSCTEST'), f.service);
    assert.equal(P.getDataKey(fqn!).id, signed.contentKey);
    const data = (cli.contentmultimap![signed.contentKey] as any).data;
    assert.deepEqual(data, { message: plaintext, encrypttoaddress: zAddress, createmmr: true, hashtype: 'sha256' });
    assert.ok(Buffer.from(signed.requestHex, 'hex').includes(Buffer.from(plaintext, 'utf8')));
    assert.ok(!Object.hasOwn(data, 'messagehex'));
    assert.ok(!Object.hasOwn(data, 'ivk') && !Object.hasOwn(data, 'ssk'));
    assert.equal(details.expiryHeight!.toNumber(), 260);
    assert.ok(!JSON.stringify(cli).includes(f.key.toWIF()));
    assert.equal((await f.adapter.verifyMetadataResponse({ body: await f.response(signed.requestHex), requestHex: signed.requestHex, requestIdHex, identityId: f.signer })).txid, txid);
  }
});

test('metadata request rejects empty, oversized, and invalid Unicode plaintext before signing', async () => {
  const f = fixture();
  for (const message of ['', 'x'.repeat(2049), '🌊'.repeat(513), '\ud800']) {
    await assert.rejects(f.create('redirect', message), code('INVALID_SIGNATURE'));
  }
});

test('metadata callbacks reject another request, signer, altered detail, invalid signature, truncation and revocation', async () => {
  const f = fixture(); const request = await f.create();
  const input = { requestHex: request.requestHex, requestIdHex, identityId: f.signer };
  const cases: Array<(r: InstanceType<typeof P.GenericResponse>) => void> = [
    r => { r.requestHash = Buffer.alloc(32); },
    r => { (r.details[0] as any).data.requestID = cid(f.other); },
    r => { (r.details[0] as any).data.txid = Buffer.alloc(32); },
    r => { r.details = [new P.DataResponseOrdinalVDXFObject({ data: new P.DataResponseDetails({ requestID: r.requestID, data: new P.DataDescriptor({ objectdata: Buffer.from('wrong') }) }) })]; },
    r => { r.createdAt = new P.BigNumber(Math.floor(Date.now() / 1000) + 3600); },
  ];
  for (const [index, change] of cases.entries()) await assert.rejects(f.adapter.verifyMetadataResponse({ ...input, body: await f.response(request.requestHex, change) }), code('INVALID_SIGNATURE'), `case ${index}`);
  await assert.rejects(f.adapter.verifyMetadataResponse({ ...input, body: await f.response(request.requestHex, undefined, f.other) }), code('INVALID_SIGNATURE'));
  const valid = await f.response(request.requestHex);
  for (const body of [valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), Buffer.alloc(65_537)]) await assert.rejects(f.adapter.verifyMetadataResponse({ ...input, body }), code('INVALID_SIGNATURE'));
  const mobile = await f.response(request.requestHex, r => { r.signature!.version = new P.BigNumber(0); });
  assert.equal((await f.adapter.verifyMetadataResponse({ ...input, body: mobile })).identityId, f.signer);
  f.state.revoked = true;
  await assert.rejects(f.adapter.verifyMetadataResponse({ ...input, body: valid }), code('INVALID_SIGNATURE'));
});

test('metadata descriptor helpers reject public IVKs/SSKs and parse native plaintext bytes', () => {
  assert.deepEqual(descriptorHexToJson(descriptorHex), descriptor);
  assert.deepEqual(parseMetadataPayload(Buffer.from(plaintext, 'utf8').toString('hex')), Buffer.from(plaintext, 'utf8'));
  for (const bad of ['', 'zz', 'c0af', 'eda080', '61'.repeat(2049)]) assert.throws(() => parseMetadataPayload(bad), code('INVALID_SIGNATURE'));
  for (const key of ['ivk', 'ssk'] as const) {
    const leaked = new P.DataDescriptor({ flags: new P.BigNumber(1), objectdata: Buffer.from(descriptor.objectdata, 'hex'), epk: Buffer.from(descriptor.epk, 'hex'), [key]: Buffer.alloc(32, 3) }).toBuffer().toString('hex');
    assert.throws(() => descriptorHexToJson(leaked), code('INVALID_SIGNATURE'));
  }
});

test('metadata lookup uses key-filtered aggregate, retains source txids, and omits deleted history', async () => {
  const f = fixture();
  const contentKey = f.adapter.metadataContentKey(locator).key;
  const current = vdxfDescriptor();
  const removed = new P.VdxfUniValue({ values: [{ [P.DataDescriptorKey.vdxfid]: P.DataDescriptor.fromJson({ ...descriptor, epk: '03'.repeat(32) }) }] }).toBuffer().toString('hex');
  f.state.aggregate = [current];
  f.state.history = [
    { identity: { ...f.record(f.signer).identity, contentmultimap: { [contentKey]: [removed] } }, height: 101, output: { txid: 'ff'.repeat(32), voutnum: 0 } },
    { identity: { ...f.record(f.signer).identity, contentmultimap: { [contentKey]: [current] } }, height: 120, output: { txid, voutnum: 0 } },
  ];
  const result = await f.adapter.getMetadataRecords({ identityId: f.signer, contentKey });
  assert.deepEqual(result.records, [{ descriptor, txid, height: 120 }]);
  assert.deepEqual(f.calls[0], { method: 'getidentitycontent', args: [f.signer, 0, 200, false, 200, contentKey] });
  assert.deepEqual(f.calls[1], { method: 'getidentityhistory', args: [f.signer, 0, 200, false] });
  f.state.aggregate = [];
  assert.deepEqual((await f.adapter.getMetadataRecords({ identityId: f.signer, contentKey })).records, []);
});

test('metadata references retrieve only confirmed same-transaction evidence, never arbitrary URLs', async () => {
  const f = fixture();
  const evidence = new P.EvidenceData({ version: new P.BigNumber(1), type: new P.BigNumber(1), md: undefined, vdxfd: P.DataDescriptorKey.vdxfid, data_vec: Buffer.from(vdxfDescriptor(), 'hex') });
  f.state.transaction = { txid, confirmations: 1, vout: [{ n: 0, scriptPubKey: { notaryevidence: { version: 1, type: 3, systemid: TESTNET_SYSTEM_ID, evidence: { version: 1, chainobjects: [{ vdxftype: P.EvidenceDataKey.vdxfid, value: evidence.toJson() }] } } } }] };
  const reference = (target = '00'.repeat(32), systemId = '') => new P.VdxfUniValue({ values: [{ [P.CrossChainDataRefKey.vdxfid]: new P.CrossChainDataRef(new P.PBaaSEvidenceRef({ version: new P.BigNumber(1), flags: new P.BigNumber(1), output: new P.UTXORef({ hash: Buffer.from(target, 'hex').reverse(), n: new P.BigNumber(0) }), objectNum: new P.BigNumber(0), subObject: new P.BigNumber(0), systemId })) }] }).toBuffer().toString('hex');
  assert.deepEqual(await f.adapter.getReferencedMetadata({ objectDataHex: reference(), sourceTxid: txid }), descriptor);
  for (const objectDataHex of [reference('ff'.repeat(32)), reference('00'.repeat(32), P.DEFAULT_VERUS_CHAINID)]) await assert.rejects(f.adapter.getReferencedMetadata({ objectDataHex, sourceTxid: txid }), code('INVALID_SIGNATURE'));
  f.state.transaction.confirmations = 0;
  await assert.rejects(f.adapter.getReferencedMetadata({ objectDataHex: reference(), sourceTxid: txid }), code('CHAIN_UNAVAILABLE'));
});


test('native daemon identity storage fixture decrypts through chain adapter and real Rust worker', async () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/metadata-native-storage.json', import.meta.url), 'utf8'));
  const f = fixture();
  const contentKey = f.adapter.metadataContentKey(native.capability.locator).key;
  const entry = { [P.DataDescriptorKey.vdxfid]: native.linkDescriptor };
  const identity = { ...f.record(native.context.identityId).identity, contentmultimap: { [contentKey]: [entry] } };
  f.client.interface.getIdentityContent = async () => ({ result: { ...f.record(native.context.identityId), identity }, error: null } as any);
  f.state.history = [{ identity, height: 120, output: { txid, voutnum: 1 } }];
  f.state.transaction = { txid, confirmations: 1, vout: [{ n: 0, scriptPubKey: { notaryevidence: native.notaryEvidence } }] };
  const service = new MetadataService(new RustWorker(fileURLToPath(new URL('../bin/vatermark-worker', import.meta.url))), f.adapter);
  const result = await service.lookup(native.context, { contentKey, txid, payloadHash: createHash('sha256').update(native.plaintext, 'utf8').digest('hex') });
  assert.equal(result.status, 'decrypted', JSON.stringify(result));
  assert.deepEqual(result.data, native.metadata);
  assert.equal(result.txid, txid);
  const rejected = await service.lookup(native.context, { contentKey, txid, payloadHash: '00'.repeat(32) });
  assert.equal(rejected.status, 'invalid');
  f.state.transaction.confirmations = 0;
  assert.equal((await service.lookup(native.context)).status, 'unavailable');
});


test('maximum permitted metadata and a long callback URL fit the wallet QR code', async () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/metadata-native-storage.json', import.meta.url), 'utf8'));
  const metadata = { title: 'A'.repeat(120), description: '' };
  metadata.description = 'B'.repeat(MAX_METADATA_BYTES - Buffer.byteLength(JSON.stringify(metadata)));
  assert.equal(Buffer.byteLength(JSON.stringify(metadata)), MAX_METADATA_BYTES);
  validateMetadata(metadata);
  const f = fixture();
  const worker = new RustWorker(fileURLToPath(new URL('../bin/vatermark-worker', import.meta.url)));
  const capability = await worker.run<any>({ cmd: 'metadata_derive', context: native.context });
  const plaintext = JSON.stringify({ schema: 'vatermark-image-metadata', version: 1, locator: capability.locator, data: metadata });
  // A 253-character DNS name is longer than the actual deployment origin.
  const hostname = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(61)}.${'d'.repeat(58)}.test`;
  for (const callbackHost of [hostname, 'vatermark-9f27a.web.app']) {
  const signed = await f.adapter.createMetadataRequest({ identityId: f.signer, locator: capability.locator, plaintext, zAddress: capability.zAddress,
    requestIdHex, callbackUrl: `https://${callbackHost}/api/sign-jobs/${'e'.repeat(32)}/metadata/response`, responseMode: 'redirect' });
  const symbol = QRCode.create(signed.walletUri, { errorCorrectionLevel: 'M' });
  assert.ok(symbol.version <= 40);
  const qr = await QRCode.toDataURL(signed.walletUri, { errorCorrectionLevel: 'M', width: 340, margin: 3 });
  assert.match(qr, /^data:image\/png;base64,/);
  }
});


test('metadata lookup cancellation prevents later RPC requests', async () => {
  const f = fixture();
  const controller = new AbortController();
  const contentKey = f.adapter.metadataContentKey(locator).key;
  let tipCalls = 0;
  f.client.interface.getInfo = async () => {
    tipCalls++;
    controller.abort();
    return { result: { chainid: TESTNET_SYSTEM_ID, name: 'VRSCTEST', testnet: true, blocks: 200 }, error: null } as any;
  };
  await assert.rejects(f.adapter.getMetadataRecords({ identityId: f.signer, contentKey, signal: controller.signal }), code('CHAIN_UNAVAILABLE'));
  assert.equal(tipCalls, 1);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.adapter.getMetadataRecords({ identityId: f.signer, contentKey, signal: controller.signal }), code('CHAIN_UNAVAILABLE'));
  assert.equal(tipCalls, 1);
  await assert.rejects(f.adapter.getReferencedMetadata({ objectDataHex: '00', sourceTxid: txid, signal: controller.signal }), code('CHAIN_UNAVAILABLE'));
  assert.equal(f.calls.length, 0);
});
