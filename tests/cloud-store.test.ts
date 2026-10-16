import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { CloudJobStore, StoreConflict, type PrivateObjects, type StoredObject } from '../server/cloud-store.js';
import { createApp, type Adapter } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import type { Worker } from '../server/worker.js';
import { HttpError } from '../server/errors.js';
import { TESTNET_SYSTEM_ID, GENERIC_RESPONSE_QUERY_KEY } from '../server/verus.js';

class MemoryObjects implements PrivateObjects {
  data = new Map<string, StoredObject>();
  revision = 0;
  reads: string[] = [];
  async read(name: string) { this.reads.push(name); return this.data.get(name); }
  async write(name: string, data: Buffer, revision: string | 0) {
    const actual = this.data.get(name)?.revision ?? 0;
    if (actual !== revision) throw new StoreConflict();
    const next = String(++this.revision); this.data.set(name, { data: Buffer.from(data), revision: next }); return next;
  }
  async list(prefix: string) { return [...this.data.keys()].filter(key => key.startsWith(prefix)); }
  async remove(name: string) { this.data.delete(name); }
  async upload(name: string, filename: string) { await this.write(name, fs.readFileSync(filename), 0); }
  async download(name: string, filename: string) { fs.writeFileSync(filename, this.data.get(name)!.data); }
  async stream(name: string) { const value = this.data.get(name); if (!value) throw new Error('Missing image'); return Readable.from(value.data); }
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function stores() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-cloud-test-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const objects = new MemoryObjects();
  return { directory, objects, a: new CloudJobStore(path.join(directory, 'a'), objects), b: new CloudJobStore(path.join(directory, 'b'), objects) };
}
async function finalizing(store: CloudJobStore) { const job = await store.create('owner', 60_000); job.status = 'finalizing'; await store.save(job); return job; }

describe('durable private jobs', () => {
  it('fails a stale callback/cancellation write closed across independent instances', async () => {
    const { a, b } = stores(); const job = await a.create('owner', 60_000);
    const stale = (await b.get(job.id))!;
    job.status = 'cancelled'; await a.save(job);
    stale.status = 'finalizing';
    await expect(b.save(stale)).rejects.toBeInstanceOf(StoreConflict);
    expect((await b.get(job.id))!.status).toBe('cancelled');
  });
  it('grants one lease and lets a new instance recover only after lease expiry', async () => {
    const { a, b } = stores(); const job = await finalizing(a); const stale = (await b.get(job.id))!;
    const lease = await a.claim(job, 1000); expect(lease).toMatch(/^[a-f0-9]{32}$/);
    await expect(b.claim(stale, 1000)).rejects.toBeInstanceOf(StoreConflict);
    const current = (await b.get(job.id))!;
    expect(await b.claim(current, 2000)).toBeUndefined();
    expect(await b.claim(current, 121_001)).toMatch(/^[a-f0-9]{32}$/);
    job.status = 'complete';
    await expect(a.save(job)).rejects.toBeInstanceOf(StoreConflict);
    expect((await a.get(job.id))!.status).toBe('finalizing');
  });
  it('never deletes artifacts when a stale terminal-state write loses to a finalizer', async () => {
    const { a, b, objects } = stores(); const job = await a.create('owner', 60_000);
    const stale = (await b.get(job.id))!;
    const filename = path.join(a.directory(job.id), 'source.png'); fs.writeFileSync(filename, 'private pixels');
    await a.publish(job, 'source.png', filename);
    job.status = 'finalizing'; await a.save(job);
    stale.status = 'cancelled';
    await expect(b.removeImages(stale)).rejects.toBeInstanceOf(StoreConflict);
    expect(objects.data.has(`jobs/${job.id}/source.png`)).toBe(true);
  });
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const identityId = 'i3kT4uvcakroae5k6cLtWrG6BX34gAzxCp';
const identity = { id: Array(20).fill(3), system_id: Array(20).fill(4), testnet: true, height: 123456,
  min_sigs: 1, revoked: false, primary_addresses: ['mock-address'] };
const displayIdentity = { id: identityId, name: 'Mock signer', systemId: TESTNET_SYSTEM_ID, signingHeight: 123456, currentStatus: 'active' };
const prepared = { profile: 65, flags: 2, systemId: TESTNET_SYSTEM_ID, width: 641, height: 481, helperHex: '00'.repeat(384),
  quantized: Array(1024).fill(0), message: 'Vatermark test commitment', commitment: 'ab'.repeat(32), sourceSha256: 'cd'.repeat(32) };
const accepted = { identityId, systemId: TESTNET_SYSTEM_ID, nativeSignature: 'mock-native', identity, displayIdentity };
async function apps() {
  const f = stores();
  const config = loadConfig({ DATA_DIR: path.join(f.directory, 'uploads'), JOB_STORAGE_BUCKET: 'private-test-bucket',
    PUBLIC_ORIGIN: 'https://vatermark-9f27a.web.app', VATERMARK_SERVICE_ID: identityId, VATERMARK_SERVICE_WIF: 'secret-not-in-storage' });
  const run = vi.fn(async (command: Record<string, unknown>) => {
    if (command.cmd === 'prepare') { fs.writeFileSync(String(command.normalized_output), png); return { prepared }; }
    if (command.cmd === 'finalize') {
      expect(fs.readFileSync(String(command.input))).toEqual(png);
      fs.writeFileSync(String(command.output), png); return { verification: { signature_valid: true } };
    }
    throw new Error('Unexpected command');
  });
  const worker = { run } as unknown as Worker;
  const adapter = { status: vi.fn(async () => ({ enabled: true })),
    createRequest: vi.fn(async () => ({ requestHex: 'aabbcc', requestHashHex: 'ee'.repeat(32), walletUri: 'verus://1/mock-request' })),
    resolveIdentity: vi.fn(async () => ({ identity, currentActive: true, displayIdentity })),
    verifyResponse: vi.fn(async () => accepted) } satisfies Adapter;
  const first = await createApp(config, { worker, adapter, store: f.a }); cleanups.push(first.close);
  const second = await createApp(config, { worker, adapter, store: f.b }); cleanups.push(second.close);
  const setup = await request(first.app).get('/api/config').expect(200);
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  expect(setup.headers['set-cookie'][0]).toMatch(/^__session=/);
  expect(setup.headers['set-cookie'][0]).toContain('; Secure');
  const response = await request(first.app).post('/api/sign-jobs').set('Cookie', cookie).attach('image', png, 'image.png').expect(201);
  const id = response.body.id as string;
  return { ...f, first, second, run, adapter, cookie, id };
}

describe('hosted callback and file serving', () => {
  it.each(['redirect', 'post'])('returns the same private PNG across instances with a %s response', async mode => {
    const f = await apps();
    expect(f.adapter.createRequest).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: `https://vatermark-9f27a.web.app/api/sign-jobs/${f.id}/response` }));
    const preview = await request(f.second.app).get(`/api/sign-jobs/${f.id}/preview`).set('Cookie', f.cookie).expect(200);
    expect(preview.body).toEqual(png); expect(preview.headers['cache-control']).toBe('no-store');
    await request(f.second.app).get(`/api/sign-jobs/${f.id}/preview`).expect(404);
    const body = Buffer.from('test signed response');
    if (mode === 'redirect') await request(f.second.app).get(`/api/sign-jobs/${f.id}/response?${GENERIC_RESPONSE_QUERY_KEY}=${body.toString('base64url')}`).expect(303).expect('Location', `/?walletReturn=${f.id}`);
    else await request(f.second.app).post(`/api/sign-jobs/${f.id}/response`).set('Content-Type', 'application/octet-stream').send(body).expect(200);
    const status = await request(f.first.app).get(`/api/sign-jobs/${f.id}`).set('Cookie', f.cookie).expect(200);
    expect(status.body.status).toBe('complete');
    const output = await request(f.first.app).get(status.body.downloadUrl).set('Cookie', f.cookie).expect(200);
    expect(output.body).toEqual(png); expect(output.headers['content-type']).toMatch(/^image\/png/);
    expect(output.headers['content-length']).toBeUndefined();
    expect(output.headers['content-disposition']).toContain('vatermark-signed.png');
    await request(f.first.app).get(status.body.downloadUrl).expect(404);
    await request(f.first.app).post(`/api/sign-jobs/${f.id}/response`).set('Content-Type', 'application/octet-stream').send(body).expect(200);
    expect(f.run.mock.calls.filter(([command]) => command.cmd === 'finalize')).toHaveLength(1);
    expect([...f.objects.data.values()].map(value => value.data.toString()).join('')).not.toContain('secret-not-in-storage');
    expect(fs.existsSync(path.join(f.directory, 'a', 'jobs', f.id))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'b', 'jobs', f.id))).toBe(false);
  });
  it('recovers durable accepted work with an expired lease on an authenticated poll', async () => {
    const f = await apps();
    const job = (await f.a.get(f.id))!;
    job.status = 'finalizing'; job.accepted = accepted; job.acceptedHash = 'ab'.repeat(32);
    job.lease = { token: 'ff'.repeat(16), until: Date.now() - 1 }; await f.a.save(job);
    await request(f.second.app).get(`/api/sign-jobs/${f.id}`).expect(404);
    expect(f.run.mock.calls.filter(([command]) => command.cmd === 'finalize')).toHaveLength(0);
    const status = await request(f.second.app).get(`/api/sign-jobs/${f.id}`).set('Cookie', f.cookie).expect(200);
    expect(status.body.status).toBe('complete');
    expect(f.run.mock.calls.filter(([command]) => command.cmd === 'finalize')).toHaveLength(1);
  });
  it('preserves accepted work and releases a busy finalizer lease for the next poll', async () => {
    const f = await apps();
    const job = (await f.a.get(f.id))!; job.status = 'finalizing'; job.accepted = accepted;
    await f.a.save(job);
    f.run.mockRejectedValueOnce(new HttpError(503, 'BUSY', 'Worker occupied'));
    const waiting = await request(f.second.app).get(`/api/sign-jobs/${f.id}`).set('Cookie', f.cookie).expect(200);
    expect(waiting.body.status).toBe('finalizing');
    const saved = (await f.b.get(f.id))!;
    expect(saved.lease).toBeUndefined(); expect(saved.accepted).toEqual(accepted);
    expect(f.objects.data.has(`jobs/${f.id}/source.png`)).toBe(true);
    const retried = await request(f.first.app).get(`/api/sign-jobs/${f.id}`).set('Cookie', f.cookie).expect(200);
    expect(retried.body.status).toBe('complete');
    const image = await request(f.second.app).get(retried.body.downloadUrl).set('Cookie', f.cookie).expect(200);
    expect(image.body).toEqual(png);
  });
  it('admits only one finalizer when the same signed callback reaches two instances', async () => {
    const f = await apps();
    const job = (await f.a.get(f.id))!; job.status = 'finalizing'; job.accepted = accepted;
    await f.a.save(job);
    const results = await Promise.all([f.first, f.second].map(app => request(app.app).get(`/api/sign-jobs/${f.id}`).set('Cookie', f.cookie)));
    expect(results.every(response => response.status === 200)).toBe(true);
    expect(f.run.mock.calls.filter(([command]) => command.cmd === 'finalize')).toHaveLength(1);
    expect((await f.a.get(f.id))!.status).toBe('complete');
  });
});
