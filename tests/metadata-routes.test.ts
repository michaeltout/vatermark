import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { JobStore, ownerHash } from '../server/jobs.js';
import { MetadataService, type MetadataAdapter } from '../server/metadata.js';
import { TESTNET_SYSTEM_ID, GENERIC_RESPONSE_QUERY_KEY, VerusError } from '../server/verus.js';
import type { Worker } from '../server/worker.js';

const identityId = 'i3kT4uvcakroae5k6cLtWrG6BX34gAzxCp';
// The real SDK wire format is covered by metadata-verus.test.ts. This fixture
// makes the request's plaintext visibility explicit in route/session tests.
const requestData = Buffer.from(JSON.stringify({ message: 'Private title', encrypttoaddress: 'zs-test-recipient' }));
const requestHex = requestData.toString('hex');
const walletUri = `verus://1/${requestData.toString('base64url')}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-metadata-routes-'));
  const config = loadConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:5173', WALLET_RESPONSE_MODE: 'redirect',
    VATERMARK_SERVICE_ID: identityId, VATERMARK_SERVICE_WIF: 'local-test-only-secret' });
  const store = new JobStore(dataDir);
  const displayIdentity = { id: identityId, name: 'Test signer', systemId: TESTNET_SYSTEM_ID, signingHeight: 100, currentStatus: 'active' };
  const identity = { id: Array(20).fill(3), system_id: Array(20).fill(4), testnet: true, height: 100, min_sigs: 1, revoked: false, primary_addresses: ['test'] };
  const adapter = { status: vi.fn(async () => ({ enabled: true })), createRequest: vi.fn(), verifyResponse: vi.fn(),
    resolveIdentity: vi.fn(async () => ({ identity, displayIdentity, currentActive: true })) };
  const metadataAdapter = { metadataContentKey: vi.fn(), createMetadataRequest: vi.fn(), getMetadataRecords: vi.fn(), getReferencedMetadata: vi.fn(),
    verifyMetadataResponse: vi.fn(async () => ({ identityId, txid: 'ab'.repeat(32) })) };
  const worker = { run: vi.fn(async (command: Record<string, unknown>) => command.cmd === 'inspect'
    ? { identityId, systemId: TESTNET_SYSTEM_ID, profile: 65, signingHeight: 100, testnet: true }
    : { verification: { signature_valid: true }, nativeSignature: 'private-image-signature' }) } as unknown as Worker;
  const prepare = vi.spyOn(MetadataService.prototype, 'prepare').mockResolvedValue({ requestHex, requestHashHex: 'ee'.repeat(32),
    walletUri, contentKey: identityId, expiryHeight: 160, locator: 'cd'.repeat(32), payloadHash: 'ef'.repeat(32) });
  const lookup = vi.spyOn(MetadataService.prototype, 'lookup').mockResolvedValue({ status: 'not_found' });
  const created = await createApp(config, { store, adapter, worker, metadataAdapter: metadataAdapter as unknown as MetadataAdapter });
  cleanups.push(async () => { await created.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const owner = request.agent(created.app);
  const response = await owner.get('/api/config').expect(200);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const job = store.create(ownerHash(cookie.split('=')[1]), 600_000);
  job.status = 'complete'; job.deleteAt = Date.now() + 600_000;
  job.prepared = { profile: 65, flags: 2, systemId: TESTNET_SYSTEM_ID, width: 641, height: 481, helperHex: '', quantized: [], message: 'signed message', commitment: '', sourceSha256: '' };
  job.accepted = { identityId, systemId: TESTNET_SYSTEM_ID, nativeSignature: 'private-image-signature', identity, displayIdentity };
  store.save(job); fs.writeFileSync(path.join(store.directory(job.id), 'output.png'), png);
  const base = `/api/sign-jobs/${job.id}`;
  return { ...created, config, store, owner, cookie, job, base, prepare, lookup, metadataAdapter, worker };
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  return f.owner.post(`${f.base}/metadata`).send({ metadata: { title: 'Private title' } }).expect(201);
}
function callback(f: Awaited<ReturnType<typeof fixture>>, bytes = Buffer.from('signed-metadata-response')) {
  return request(f.app).post(`${f.base}/metadata/response`).set('Content-Type', 'application/octet-stream').set('Origin', 'https://wallet.example').send(bytes);
}

describe('optional identity metadata API', () => {
  it('requires the owner and a completed image, stores the wallet request privately, and preserves identical download bytes', async () => {
    const f = await fixture();
    await request(f.app).post(`${f.base}/metadata`).send({ metadata: { title: 'x' } }).expect(404);
    const response = await prepare(f);
    expect(response.body.status).toBe('complete'); expect(response.body.metadata.status).toBe('awaiting_approval');
    expect(response.body.metadata.qrText).toBe(walletUri);
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ nativeSignature: 'private-image-signature', identityId }),
      { title: 'Private title' }, expect.objectContaining({ callbackUrl: `http://localhost:5173${f.base}/metadata/response`, responseMode: 'redirect' }));
    const persisted = JSON.stringify(f.store.get(f.job.id)?.metadata);
    expect(Buffer.from(f.store.get(f.job.id)!.metadata!.requestHex!, 'hex').toString()).toContain('Private title');
    expect(Buffer.from(response.body.metadata.walletUri.split('/').at(-1), 'base64url').toString()).toContain('Private title');
    for (const secret of ['private-image-signature', 'local-test-only-secret']) {
      expect(persisted).not.toContain(secret); expect(response.text).not.toContain(secret);
    }
    expect((await f.owner.get(`${f.base}/image`).expect(200)).body).toEqual(png);
    await f.owner.post(`${f.base}/metadata`).send({ metadata: { title: 'again' } }).expect(409);
    const job = f.store.get(f.job.id)!; job.status = 'awaiting_signature'; f.store.save(job);
    await f.owner.post(`${f.base}/metadata`).send({ metadata: { title: 'x' } }).expect(409);
  });

  it('rejects invalid fields, malicious links, oversized UTF-8, and cross-origin writes before deriving the wallet recipient', async () => {
    const f = await fixture();
    for (const metadata of [{}, { extra: 'x' }, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.org' }, { description: '😀'.repeat(180) }]) {
      await f.owner.post(`${f.base}/metadata`).send({ metadata }).expect(400);
    }
    await f.owner.post(`${f.base}/metadata`).set('Origin', 'https://attacker.example').send({ metadata: { title: 'x' } }).expect(403);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('accepts cross-origin callbacks without cookies, binds them to the request and image identity, and waits for chain publication', async () => {
    const f = await fixture(); await prepare(f);
    const response = await callback(f).expect(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(f.metadataAdapter.verifyMetadataResponse).toHaveBeenCalledWith(expect.objectContaining({ identityId, requestHex, requestIdHex: expect.stringMatching(/^[0-9a-f]{40}$/) }));
    const status = await f.owner.get(f.base).expect(200);
    expect(status.body.status).toBe('complete'); expect(status.body.metadata.status).toBe('submitted');
    expect(f.lookup).toHaveBeenCalledWith(expect.objectContaining({ nativeSignature: 'private-image-signature' }),
      { contentKey: identityId, payloadHash: 'ef'.repeat(32), txid: 'ab'.repeat(32) });
    await callback(f).expect(200);
    await callback(f, Buffer.from('different')).expect(409);
    expect(f.metadataAdapter.verifyMetadataResponse).toHaveBeenCalledTimes(1);
    await f.owner.delete(`${f.base}/metadata`).expect(409);
    expect((await f.owner.get(`${f.base}/image`)).body).toEqual(png);
    f.lookup.mockResolvedValue({ status: 'decrypted', data: { title: 'Private title' }, txid: 'ab'.repeat(32), height: 101 });
    const pending = f.store.get(f.job.id)!; pending.metadata!.checkedAt = 0; f.store.save(pending);
    expect((await f.owner.post(`${f.base}/metadata/check`).expect(200)).body.metadata.status).toBe('published');
  });

  it('cleans redirect response bytes from the URL and never changes the owner cookie', async () => {
    const f = await fixture(); await prepare(f);
    const response = await request(f.app).get(`${f.base}/metadata/response?${GENERIC_RESPONSE_QUERY_KEY}=${Buffer.from('response').toString('base64url')}`)
      .set('Sec-Fetch-Site', 'cross-site').expect(303);
    expect(response.headers.location).toBe(`/?walletReturn=${f.job.id}&metadataReturn=1`);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect((await f.owner.get(`${f.base}/image`)).body).toEqual(png);
  });

  it('accepts a matching wallet receipt after the owner already confirmed publication', async () => {
    const f = await fixture(); await prepare(f);
    f.lookup.mockResolvedValue({ status: 'decrypted', data: { title: 'Private title' }, txid: 'ab'.repeat(32), height: 101 });
    expect((await f.owner.post(`${f.base}/metadata/check`).expect(200)).body.metadata.status).toBe('published');
    f.metadataAdapter.verifyMetadataResponse.mockResolvedValueOnce({ identityId, txid: 'ff'.repeat(32) });
    await callback(f, Buffer.from('wrong transaction')).expect(409);
    await callback(f).expect(200); await callback(f).expect(200);
    expect(f.store.get(f.job.id)?.metadata?.status).toBe('published');
    expect(f.metadataAdapter.verifyMetadataResponse).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed redirects and wrong signatures without consuming the request', async () => {
    const f = await fixture(); await prepare(f);
    for (const encoded of ['', 'AA==', 'AB', `AA&${GENERIC_RESPONSE_QUERY_KEY}=AA`]) {
      await request(f.app).get(`${f.base}/metadata/response?${GENERIC_RESPONSE_QUERY_KEY}=${encoded}`).expect(303)
        .expect('Location', `/?walletReturn=${f.job.id}&metadataReturn=1&returnError=INVALID_CALLBACK`);
    }
    expect(f.metadataAdapter.verifyMetadataResponse).not.toHaveBeenCalled();
    f.metadataAdapter.verifyMetadataResponse.mockRejectedValueOnce(new VerusError('INVALID_SIGNATURE', 'Wrong identity'));
    await callback(f).expect(422);
    expect(f.store.get(f.job.id)?.metadata?.status).toBe('awaiting_approval');
    await callback(f).expect(200);
  });

  it('expires only the optional request and rejects late callbacks even without an owner poll', async () => {
    const f = await fixture(); await prepare(f);
    const job = f.store.get(f.job.id)!; job.metadata!.expiresAt = Date.now() - 1; f.store.save(job);
    await callback(f).expect(409);
    expect(f.metadataAdapter.verifyMetadataResponse).not.toHaveBeenCalled();
    expect((await f.owner.get(f.base)).body.metadata.status).toBe('expired');
    expect((await f.owner.get(`${f.base}/image`)).body).toEqual(png);
    await f.owner.delete(`${f.base}/metadata`).expect(200);
    expect(f.store.get(f.job.id)?.metadata).toBeUndefined();
  });

  it.each(['awaiting_approval', 'submitted', 'published'] as const)('retires an old pre-encrypted %s request while keeping its signed image available', async status => {
    const f = await fixture(); await prepare(f);
    const job = f.store.get(f.job.id)!;
    job.metadata!.status = status;
    delete job.metadata!.payloadHash;
    Object.assign(job.metadata!, { ciphertextHash: 'ef'.repeat(32) });
    f.store.save(job);
    await callback(f).expect(409);
    expect(f.metadataAdapter.verifyMetadataResponse).not.toHaveBeenCalled();
    const response = await f.owner.get(f.base).expect(200);
    expect(response.body.metadata.status).toBe(status === 'awaiting_approval' ? 'expired' : 'failed');
    if (status !== 'awaiting_approval') expect(response.body.metadata.message).toContain('previously submitted chain update is unaffected');
    expect(response.body.metadata.qrText).toBeUndefined();
    expect((await f.owner.get(`${f.base}/image`).expect(200)).body).toEqual(png);
    await prepare(f);
    expect(f.store.get(f.job.id)?.metadata?.payloadHash).toBe('ef'.repeat(32));
  });

  it('does not resurrect metadata cancelled while preparing', async () => {
    const f = await fixture();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const signed = await f.prepare.getMockImplementation()!({} as never, {} as never, {} as never);
    f.prepare.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; entered(); }); return signed; });
    const pending = f.owner.post(`${f.base}/metadata`).send({ metadata: { title: 'Private title' } }).then(result => result);
    await started;
    await f.owner.delete(`${f.base}/metadata`).expect(200);
    release(); expect((await pending).status).toBe(409);
    expect(f.store.get(f.job.id)?.metadata).toBeUndefined();
    expect((await f.owner.get(`${f.base}/image`)).body).toEqual(png);
  });

  it('rechecks cancellation after validating a callback', async () => {
    const f = await fixture(); await prepare(f);
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.metadataAdapter.verifyMetadataResponse.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); }); return { identityId, txid: 'ab'.repeat(32) };
    });
    const pending = callback(f).then(result => result); await started;
    await f.owner.delete(`${f.base}/metadata`).expect(200); release();
    expect((await pending).status).toBe(409); expect(f.store.get(f.job.id)?.metadata).toBeUndefined();
  });

  it('displays decrypted details but keeps a valid image valid when metadata is unavailable or invalid', async () => {
    const f = await fixture();
    for (const status of ['decrypted', 'unavailable', 'invalid'] as const) {
      f.lookup.mockResolvedValue({ status, ...(status === 'decrypted' ? { data: { title: 'Private title' } } : {}) });
      const response = await f.owner.post('/api/verify').attach('image', png, 'signed.png').expect(200);
      expect(response.body.status).toBe('verified'); expect(response.body.verification.signature_valid).toBe(true);
      expect(response.body.metadata.status).toBe(status); expect(response.text).not.toContain('private-image-signature');
    }
  });
});
