import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { MetadataService, validateMetadata, metadataView, type MetadataAdapter, type MetadataContext, type MetadataCapability } from '../server/metadata.js';
import { MetadataVerusAdapter, type MetadataDescriptor, type MetadataRecord } from '../server/metadata-verus.js';
import { RustWorker, WorkerError, type Worker } from '../server/worker.js';
import { HttpError } from '../server/errors.js';
import { VerusError } from '../server/verus.js';

const require = createRequire(import.meta.url);
const { VerusIdInterface } = require('verusid-ts-client') as typeof import('verusid-ts-client');

const worker = new RustWorker(fileURLToPath(new URL('../bin/vatermark-worker', import.meta.url)));
const contentKey = 'i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv';
const systemId = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';
const txid = 'ab'.repeat(32);
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const errorCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

// Publicly reproducible synthetic signature, not a real wallet/chain identity.
function context(): MetadataContext {
  return { profile: 0x41, identityId: contentKey, systemId,
    nativeSignature: Buffer.concat([Buffer.from([2,5,100,0,0,0,1,65,31]), Buffer.alloc(64, 1)]).toString('base64') };
}

// Native wallet encryption fixture from an unbroadcast identity update using
// plaintext PartialSignData.message and the image-derived encrypttoaddress.
// Normal test runs never contact a daemon or publish a transaction.
const daemonFixture = JSON.parse(readFileSync(new URL('./fixtures/metadata-native-storage.json', import.meta.url), 'utf8'));

async function fixture() {
  const image = context();
  const reference = 'synthetic confirmed evidence reference';
  const link = await worker.run<{ datadescriptor: MetadataDescriptor }>({ cmd: 'metadata_encrypt', context: image, plaintext: reference });
  const state: { records: MetadataRecord[]; external: MetadataDescriptor; failure?: Error } = {
    records: [{ descriptor: link.datadescriptor, txid, height: 150 }], external: daemonFixture.leafDescriptor,
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  const adapter: MetadataAdapter = {
    metadataContentKey(locator) { calls.push({ method: 'contentKey', input: locator }); return { key: contentKey }; },
    async createMetadataRequest(input) { calls.push({ method: 'createRequest', input }); return {
      requestHex: 'feed', requestHashHex: 'ca'.repeat(32), walletUri: 'verusid://synthetic-request', contentKey, expiryHeight: 210,
    }; },
    async verifyMetadataResponse(input) { calls.push({ method: 'verifyResponse', input }); return { txid, identityId: image.identityId }; },
    async getMetadataRecords(input) {
      calls.push({ method: 'records', input }); if (state.failure) throw state.failure;
      return { records: state.records, height: 200 };
    },
    async getReferencedMetadata(input) {
      calls.push({ method: 'reference', input });
      assert.equal(input.objectDataHex, Buffer.from(reference).toString('hex'));
      assert.equal(input.sourceTxid, txid);
      return state.external;
    },
  };
  const commands: string[] = [];
  const tracedWorker: Worker = { async run<T>(command: Record<string, unknown>): Promise<T> {
    commands.push(String(command.cmd));
    return worker.run<T>(command);
  } };
  const service = new MetadataService(tracedWorker, adapter);
  const expected = { contentKey, payloadHash: digest(Buffer.from(daemonFixture.plaintext, 'utf8')), txid };
  return { service, adapter, state, calls, commands, image, expected };
}

const approval = { requestIdHex: 'cd'.repeat(20), callbackUrl: 'https://vatermark.example/api/sign-jobs/test/metadata/response', responseMode: 'redirect' as const };

test('metadata input is bounded, text-only and rejects unsafe links', () => {
  assert.deepEqual(validateMetadata({ title: '  Example  ', description: '', url: ' https://example.com/work ' }), { title: 'Example', url: 'https://example.com/work' });
  const invalid: unknown[] = [null, [], 'title', 42, {}, { title: '' }, { title: { text: 'nested' } }, { title: 1 },
    { title: 'valid', extra: 'unexpected' }, { title: 'bad\u0000text' }, { description: 'bad\u007ftext' },
    { title: 'a'.repeat(121) }, { description: 'a'.repeat(401) }, { url: 'javascript:alert(1)' },
    { url: 'data:text/html,hi' }, { url: 'file:///etc/passwd' }, { url: 'https://user:secret@example.com/' }, { url: '/relative' },
    { url: 'https://exam\nple.com/' }, { url: 'https://exam\tple.com/' }, { url: 'https://example.com/two words' }];
  for (const input of invalid) assert.throws(() => validateMetadata(input), errorCode('INVALID_METADATA'));
  assert.throws(() => validateMetadata({ description: 'é'.repeat(300) }), errorCode('METADATA_TOO_LARGE'));
});

test('prepare sends plaintext and the derived recipient to the wallet without encrypting or exposing image capability secrets', async () => {
  const f = await fixture();
  const data = validateMetadata({ title: 'Private approval title', description: 'Private approval description' });
  const prepared = await f.service.prepare(f.image, data, approval);
  const call = f.calls.find(call => call.method === 'createRequest')!;
  const request = call.input as Parameters<MetadataAdapter['createMetadataRequest']>[0];
  assert.equal(request.identityId, f.image.identityId);
  assert.equal(request.callbackUrl, approval.callbackUrl);
  assert.equal(request.responseMode, approval.responseMode);
  assert.match(request.zAddress, /^zs/);
  assert.match(request.locator, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(f.calls);
  assert.ok(!serialized.includes(f.image.nativeSignature));
  assert.ok(serialized.includes(data.title!));
  assert.ok(serialized.includes(data.description!));
  assert.ok(!serialized.includes('ivk') && !serialized.includes('ssk'));
  assert.deepEqual(JSON.parse(request.plaintext), {
    schema: 'vatermark-image-metadata', version: 1, locator: request.locator, data,
  });
  assert.equal(prepared.payloadHash, digest(Buffer.from(request.plaintext, 'utf8')));
  assert.deepEqual(f.commands, ['metadata_derive']);
  assert.equal(prepared.locator, request.locator);
  assert.equal(prepared.walletUri, 'verusid://synthetic-request');
});

test('prepare validates metadata before deriving a recipient or creating a wallet request', async () => {
  const f = await fixture();
  await assert.rejects(f.service.prepare(f.image, { title: 'a'.repeat(121) }, approval), errorCode('INVALID_METADATA'));
  assert.equal(f.calls.length, 0);
});

test('lookup decrypts native wallet ciphertext directly without an extra application encryption layer', async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.lookup(f.image, f.expected), {
    status: 'decrypted', data: daemonFixture.metadata, txid, height: 150,
  });
  assert.deepEqual(f.calls.map(call => call.method), ['contentKey', 'records', 'reference']);
  assert.deepEqual(f.commands, ['metadata_derive', 'metadata_decrypt', 'metadata_decrypt']);
  const sent = JSON.stringify(f.calls);
  assert.ok(!sent.includes(f.image.nativeSignature));
  assert.ok(!sent.includes(daemonFixture.metadata.title));
  assert.ok(!sent.includes('ivk') && !sent.includes('ssk'));
});

test('equivalent compact recovery headers resolve the same metadata capability', async () => {
  const f = await fixture();
  const alternate = { ...f.image };
  const native = Buffer.from(alternate.nativeSignature, 'base64'); native[8] = 34;
  alternate.nativeSignature = native.toString('base64');
  const first = await worker.run<MetadataCapability>({ cmd: 'metadata_derive', context: f.image });
  const second = await worker.run<MetadataCapability>({ cmd: 'metadata_derive', context: alternate });
  assert.deepEqual(first, second);
  assert.equal((await f.service.lookup(alternate)).status, 'decrypted');
});

test('another image signature cannot decrypt a copied identity metadata record', async () => {
  const f = await fixture();
  const changed = { ...f.image };
  const native = Buffer.from(changed.nativeSignature, 'base64'); native[20] ^= 1;
  changed.nativeSignature = native.toString('base64');
  const first = await worker.run<MetadataCapability>({ cmd: 'metadata_derive', context: f.image });
  const second = await worker.run<MetadataCapability>({ cmd: 'metadata_derive', context: changed });
  assert.notEqual(first.locator, second.locator);
  assert.notEqual(first.zAddress, second.zAddress);
  assert.equal((await f.service.lookup(changed)).status, 'invalid');
  assert.ok(!f.calls.some(call => call.method === 'reference'));
});

test('missing publication and operational lookup failures remain distinct from invalid ciphertext', async () => {
  const f = await fixture();
  f.state.records = [];
  assert.equal((await f.service.lookup(f.image)).status, 'not_found');
  for (const code of ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE'] as const) {
    f.state.failure = new VerusError(code, 'Synthetic unavailable service');
    assert.equal((await f.service.lookup(f.image)).status, 'unavailable');
  }
  const brokenWorker: Worker = { async run() { throw new WorkerError('unavailable', 'Synthetic worker unavailable'); } };
  assert.equal((await new MetadataService(brokenWorker, f.adapter).lookup(f.image)).status, 'unavailable');
});

test('metadata lookup deadline preserves a valid signature result and stops follow-up chain requests', async () => {
  const image = context();
  const capability = await worker.run<MetadataCapability>({ cmd: 'metadata_derive', context: image });
  const commands: string[] = [];
  const fastWorker: Worker = { async run<T>(command: Record<string, unknown>): Promise<T> {
    commands.push(String(command.cmd));
    assert.equal(command.cmd, 'metadata_derive');
    return capability as T;
  } };
  const client = new VerusIdInterface('VRSCTEST', 'https://unused.invalid');
  const calls: string[] = [];
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
  client.interface.getInfo = async () => {
    calls.push('getinfo'); enter(); await pending;
    return { result: { chainid: systemId, name: 'VRSCTEST', testnet: true, blocks: 200, longestchain: 200 }, error: null } as any;
  };
  client.interface.getIdentityContent = async () => { calls.push('getidentitycontent'); throw new Error('Follow-up RPC must not run'); };
  client.interface.request = async () => { calls.push('getidentityhistory'); throw new Error('Follow-up RPC must not run'); };
  client.interface.getRawTransaction = async () => { calls.push('getrawtransaction'); throw new Error('Follow-up RPC must not run'); };
  const adapter = new MetadataVerusAdapter({ rpcUrl: 'https://unused.invalid', serviceId: contentKey, client });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const lookup = new MetadataService(fastWorker, adapter, 25).lookup(image);
    await entered;
    await vi.advanceTimersByTimeAsync(25);
    const result = await lookup;
    assert.equal(result.status, 'unavailable');
    assert.match(result.message!, /image signature is valid/);
    assert.deepEqual(calls, ['getinfo']);
    // Complete the SDK request after the caller already received its bounded
    // result. Adapter cancellation must stop getidentitycontent/history, too.
    finish();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(calls, ['getinfo']);
    assert.deepEqual(commands, ['metadata_derive']);
  } finally { finish(); vi.useRealTimers(); }
});

test('lookup rejects a damaged newest record without falling back to stale metadata', async () => {
  const f = await fixture();
  const old = f.state.records[0]!;
  const damaged = structuredClone(old);
  damaged.height = 151;
  const bytes = Buffer.from(damaged.descriptor.objectdata, 'hex'); bytes[0] ^= 1;
  damaged.descriptor.objectdata = bytes.toString('hex');
  f.state.records = [damaged, old];
  assert.equal((await f.service.lookup(f.image)).status, 'invalid');
  assert.ok(!f.calls.some(call => call.method === 'reference'));
});

test('publication confirmation binds namespace, transaction and exact approved plaintext', async () => {
  const f = await fixture();
  assert.equal((await f.service.lookup(f.image, { ...f.expected, contentKey: systemId })).status, 'invalid');
  assert.equal((await f.service.lookup(f.image, { ...f.expected, txid: 'ef'.repeat(32) })).status, 'not_found');
  assert.equal((await f.service.lookup(f.image, { ...f.expected, payloadHash: '00'.repeat(32) })).status, 'invalid');
  assert.equal((await f.service.lookup(f.image, f.expected)).status, 'decrypted');
});

test('public metadata status omits all internal key and request binding material', () => {
  const metadata = { status: 'awaiting_approval' as const, requestIdHex: '01'.repeat(20), createdAt: 1, expiresAt: 2000,
    requestHex: 'sensitive serialized request', walletUri: 'verusid://approval', contentKey, locator: '02'.repeat(32),
    payloadHash: '03'.repeat(32), acceptedHash: '04'.repeat(32), txid };
  const view = metadataView(metadata)!;
  assert.equal(view.qrText, metadata.walletUri);
  assert.equal(view.walletUri, metadata.walletUri);
  for (const field of ['requestIdHex', 'requestHex', 'contentKey', 'locator', 'payloadHash', 'acceptedHash']) assert.ok(!Object.hasOwn(view, field));
  assert.equal(metadataView({ ...metadata, status: 'published' })?.walletUri, undefined);
  assert.equal(metadataView(undefined), undefined);
});
