import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { loadConfig, type AppConfig } from '../server/config.js';
import { WorkerError, type Worker } from '../server/worker.js';
import { TESTNET_SYSTEM_ID, GENERIC_RESPONSE_QUERY_KEY, VerusAdapter, VerusError, type RustIdentity } from '../server/verus.js';

// These tests exercise API/session/persistence behavior, not cryptography.
// Real serialization/signature tests are in verus.test.ts and the Rust suite.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const identityId = 'i3kT4uvcakroae5k6cLtWrG6BX34gAzxCp';
const identity: RustIdentity = {
  id: Array(20).fill(3), system_id: Array(20).fill(4), testnet: true,
  height: 123456, min_sigs: 1, revoked: false, primary_addresses: ['local-mock-address'],
};
const displayIdentity = { id: identityId, name: 'Local test signer', systemId: TESTNET_SYSTEM_ID, signingHeight: 123456, currentStatus: 'active' };
const prepared = {
  profile: 65, flags: 2, systemId: TESTNET_SYSTEM_ID, width: 641, height: 481,
  helperHex: '00'.repeat(384), quantized: Array(1024).fill(0),
  message: `Vatermark image authentication v2\nsha256:${'ab'.repeat(32)}`,
  commitment: 'ab'.repeat(32), sourceSha256: 'cd'.repeat(32),
};
const verification = { version_type: 65, signature_valid: true, identity_id: identityId, system_id: TESTNET_SYSTEM_ID, testnet: true, signing_height: 123456 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(overrides: Partial<AppConfig> = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-api-test-'));
  // Match the application's default hidden storage directory. Ordinary /tmp
  // paths miss Express's dotfile protection when serving private image files.
  const dataDir = path.join(tempDir, '.data');
  const config = { ...loadConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'https://wallet.example.test', VATERMARK_SERVICE_ID: identityId, VATERMARK_SERVICE_WIF: 'local-mock-secret-never-share' }), ...overrides };
  const workerRun = vi.fn(async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (command.cmd) {
      case 'prepare':
        fs.writeFileSync(String(command.normalized_output), png);
        return { ok: true, width: 641, height: 481, previewPath: command.normalized_output, prepared };
      case 'inspect':
        return { ok: true, profile: 65, flags: 2, identityId, systemId: TESTNET_SYSTEM_ID, testnet: true, signingHeight: 123456, width: 641, height: 481 };
      case 'verify': return { ok: true, verification, nativeSignature: 'mock-native-signature', signerAddress: 'local-mock-address' };
      case 'finalize':
        fs.writeFileSync(String(command.output), png);
        return { ok: true, verification, width: 641, height: 481, report: {} };
      default: throw new Error(`Unexpected worker command ${command.cmd}`);
    }
  });
  const adapter = {
    status: vi.fn(async () => ({ enabled: true })),
    resolveIdentity: vi.fn(async () => ({ identity, currentActive: true, displayIdentity })),
    createRequest: vi.fn(async (_input: unknown) => ({ requestHex: 'aabbcc', requestHashHex: 'ee'.repeat(32), walletUri: 'verus://1/local-mock-request' })),
    verifyResponse: vi.fn(async (_input: unknown) => ({ identityId, systemId: TESTNET_SYSTEM_ID, nativeSignature: 'mock-native-signature', identity, displayIdentity })),
  };
  const worker = { run: workerRun } as unknown as Worker;
  const created = await createApp(config, { worker, adapter: adapter as unknown as VerusAdapter });
  cleanups.push(async () => { await created.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const owner = request.agent(created.app);
  const stranger = request.agent(created.app);
  const ownerConfig = await owner.get('/api/config').expect(200);
  const cookie = ownerConfig.headers['set-cookie'][0].split(';')[0];
  await stranger.get('/api/config').expect(200);
  return { ...created, owner, stranger, config, dataDir, workerRun, adapter, worker, cookie };
}
async function createJob(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.owner.post('/api/sign-jobs').attach('image', png, { filename: 'picture.png', contentType: 'image/png' });
  expect(response.status, response.text).toBeLessThan(300);
  expect(response.body.id).toMatch(/^[a-f0-9]{32}$/);
  expect(response.body.status).toBe('awaiting_signature');
  return response.body as { id: string; previewUrl: string; walletUri: string; expiresAt: number; status: string; downloadUrl?: string };
}
async function completed(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await f.owner.get(`/api/sign-jobs/${id}`).expect(200);
    if (response.body.status === 'complete') return response.body;
    expect(response.body.status, response.text).toBe('finalizing');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Mock worker finalization did not complete');
}
const callback = (f: Awaited<ReturnType<typeof fixture>>, id: string, body = Buffer.from('local signed response')) =>
  request(f.app).post(`/api/sign-jobs/${id}/response`).set('Content-Type', 'application/octet-stream').send(body);

describe('local API verification', () => {
  it('keeps Verify usable without a service WIF and passes only chain-fetched authority to Rust', async () => {
    const f = await fixture({ serviceId: undefined, serviceWif: undefined, publicOrigin: undefined });
    f.adapter.status.mockResolvedValue({ enabled: false });
    const config = await f.owner.get('/api/config').expect(200);
    expect(config.body.signing.enabled).toBe(false);
    expect(config.text).not.toContain('local-mock-secret');
    await f.owner.post('/api/sign-jobs').attach('image', png, 'image.png').expect(503);
    const result = await f.owner.post('/api/verify').attach('image', png, 'watermarked.png').expect(200);
    expect(result.body.status).toBe('verified');
    expect(result.body.identity.id).toBe(identityId);
    expect(f.adapter.resolveIdentity).toHaveBeenCalledWith(expect.objectContaining({ identityId, systemId: TESTNET_SYSTEM_ID, signingHeight: 123456 }));
    expect(f.workerRun).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'verify', identity }));
    expect(JSON.stringify(f.workerRun.mock.calls)).not.toContain('local-mock-secret');
  });

  it.each([
    ['no_watermark', 'unmarked'], ['unsupported_profile', 'unsupported'],
    ['unsupported_network', 'unsupported'], ['authentication_failed', 'invalid'],
  ])('classifies worker %s as %s without claiming a valid signature', async (code, status) => {
    const f = await fixture();
    f.workerRun.mockRejectedValue(new WorkerError(code, 'Controlled local test failure'));
    const result = await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(200);
    expect(result.body.status).toBe(status);
    expect(result.body.verification?.signature_valid).not.toBe(true);
  });

  it('distinguishes unavailable chain data from failed authentication', async () => {
    const f = await fixture();
    f.adapter.resolveIdentity.mockRejectedValue(new VerusError('CHAIN_UNAVAILABLE', 'Chain lookup unavailable'));
    const result = await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(200);
    expect(result.body.status).toBe('unavailable');
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'verify')).toHaveLength(0);
  });

  it('reports current revocation separately from the verified historical signature', async () => {
    const f = await fixture();
    f.adapter.resolveIdentity.mockResolvedValue({ identity, currentActive: false, displayIdentity: { ...displayIdentity, currentStatus: 'revoked' } });
    const result = await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(200);
    expect(result.body.status).toBe('revoked');
    expect(result.body.verification.signature_valid).toBe(true);
  });

  it('rejects upload limits and foreign browser origins before processing', async () => {
    const f = await fixture({ maxUploadBytes: 1024 });
    const foreign = await f.owner.post('/api/verify').set('Origin', 'https://attacker.example').attach('image', png, 'image.png');
    expect(foreign.status).toBe(403);
    const oversized = await f.owner.post('/api/verify').attach('image', Buffer.alloc(2048), 'large.png');
    expect(oversized.status).toBe(413);
    expect(f.workerRun).not.toHaveBeenCalled();
  });
});

describe('signing jobs and binary wallet callbacks', () => {
  it('keeps normalized preview and completed PNG private, accepts exact callback retries once', async () => {
    const f = await fixture(); const job = await createJob(f);
    expect(job.walletUri).toBe('verus://1/local-mock-request');
    expect(f.adapter.createRequest).toHaveBeenCalledWith(expect.objectContaining({ message: prepared.message,
      callbackUrl: `https://wallet.example.test/api/sign-jobs/${job.id}/response`, requestIdHex: expect.stringMatching(/^[a-f0-9]{40}$/) }));
    const preview = await f.owner.get(job.previewUrl).expect(200).expect('Content-Type', /image\/png/);
    expect(preview.body).toEqual(png);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect((await f.stranger.get(job.previewUrl)).status).toBeGreaterThanOrEqual(400);
    expect((await request(f.app).get(`/api/sign-jobs/${job.id}`)).status).toBeGreaterThanOrEqual(400);
    const body = Buffer.from('local signed response');
    const response = await callback(f, job.id, body);
    expect(response.status, response.text).toBeLessThan(300);
    const finished = await completed(f, job.id);
    expect(finished.previewUrl).not.toBe(job.previewUrl);
    expect(finished.identity.id).toBe(identityId);
    expect(f.adapter.verifyResponse).toHaveBeenCalledWith(expect.objectContaining({ body, message: prepared.message, requestHex: 'aabbcc' }));
    expect((await callback(f, job.id, body)).status).toBeLessThan(300);
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(1);
    expect(f.adapter.verifyResponse).toHaveBeenCalledTimes(1);
    expect(f.workerRun).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'finalize', nativeSignature: 'mock-native-signature', identityId, identity, prepared }));
    const conflict = await callback(f, job.id, Buffer.from('different signed response'));
    expect(conflict.status).toBe(409);
    const outputPreview = await f.owner.get(finished.previewUrl).expect(200).expect('Content-Type', /image\/png/);
    expect(outputPreview.body).toEqual(png);
    const download = await f.owner.get(finished.downloadUrl).expect(200).expect('Content-Type', /image\/png/);
    expect(download.body).toEqual(png);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="?vatermark-signed\.png"?$/);
    expect(download.headers['cache-control']).toBe('no-store');
    expect((await f.stranger.get(finished.downloadUrl)).status).toBeGreaterThanOrEqual(400);
    expect((await request(f.app).get(finished.downloadUrl)).status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(finished)).not.toContain(prepared.helperHex);
    expect(JSON.stringify(finished)).not.toContain('local-mock-secret');
  });

  it('withholds output if the accepted signer becomes revoked before finalization', async () => {
    const f = await fixture(); const job = await createJob(f);
    f.adapter.resolveIdentity.mockResolvedValue({ identity, currentActive: false, displayIdentity: { ...displayIdentity, currentStatus: 'revoked' } });
    expect((await callback(f, job.id)).status).toBe(200);
    await f.close();
    const state = await f.owner.get(`/api/sign-jobs/${job.id}`).expect(200);
    expect(state.body.status).toBe('failed');
    expect(state.body.downloadUrl).toBeUndefined();
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(0);
    expect(fs.existsSync(path.join(f.dataDir, 'jobs', job.id, 'output.png'))).toBe(false);
  });

  it('returns properly typed errors if a completed image file is unavailable', async () => {
    const f = await fixture(); const job = await createJob(f);
    await callback(f, job.id).expect(200);
    const finished = await completed(f, job.id);
    fs.rmSync(path.join(f.dataDir, 'jobs', job.id, 'output.png'));
    for (const url of [finished.previewUrl, finished.downloadUrl]) {
      const response = await f.owner.get(url);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.body.error.message).toBeTruthy();
    }
  });

  it('does not finalize malformed callbacks and keeps the pending job usable', async () => {
    const f = await fixture(); const job = await createJob(f);
    f.adapter.verifyResponse.mockRejectedValueOnce(new VerusError('INVALID_SIGNATURE', 'Wrong request signature'));
    const rejected = await callback(f, job.id);
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(0);
    const pending = await f.owner.get(`/api/sign-jobs/${job.id}`).expect(200);
    expect(pending.body.status).toBe('awaiting_signature');
    expect((await callback(f, job.id)).status).toBeLessThan(300);
    await completed(f, job.id);
  });

  it('rejects JSON and oversized binary callback bodies', async () => {
    const f = await fixture(); const job = await createJob(f);
    const jsonReply = await request(f.app).post(`/api/sign-jobs/${job.id}/response`).send({ response: 'not binary' });
    expect(jsonReply.status).toBeGreaterThanOrEqual(400);
    const oversized = await callback(f, job.id, Buffer.alloc(65537));
    expect(oversized.status).toBe(413);
    expect(f.adapter.verifyResponse).not.toHaveBeenCalled();
  });

  it('cancels only the owning session and rejects callbacks after cancellation', async () => {
    const f = await fixture(); const job = await createJob(f);
    expect((await f.stranger.delete(`/api/sign-jobs/${job.id}`)).status).toBeGreaterThanOrEqual(400);
    expect((await f.owner.delete(`/api/sign-jobs/${job.id}`)).status).toBeLessThan(300);
    const status = await f.owner.get(`/api/sign-jobs/${job.id}`).expect(200);
    expect(status.body.status).toBe('cancelled');
    expect((await callback(f, job.id)).status).toBeGreaterThanOrEqual(400);
    expect(f.adapter.verifyResponse).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.dataDir, 'jobs', job.id, 'source.png'))).toBe(false);
  });

  it('checks persisted expiry again before accepting a callback', async () => {
    const f = await fixture(); const job = await createJob(f);
    const file = path.join(f.dataDir, 'jobs', job.id, 'job.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.expiresAt = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    expect((await callback(f, job.id)).status).toBeGreaterThanOrEqual(400);
    expect(f.adapter.verifyResponse).not.toHaveBeenCalled();
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(0);
  });
});

describe('job races and restart recovery', () => {
  it.each(['cancel', 'expire'])('rechecks %s while a wallet response is being validated', async (operation) => {
    const f = await fixture(); const job = await createJob(f);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.adapter.verifyResponse.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ identityId, systemId: TESTNET_SYSTEM_ID, nativeSignature: 'mock-native-signature', identity, displayIdentity });
      entered();
    }));
    const pending = callback(f, job.id).then(response => response);
    await started;
    if (operation === 'cancel') {
      await f.owner.delete(`/api/sign-jobs/${job.id}`).expect(200);
    } else {
      const file = path.join(f.dataDir, 'jobs', job.id, 'job.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.expiresAt = Date.now() - 1;
      fs.writeFileSync(file, JSON.stringify(saved));
    }
    release();
    expect((await pending).status).toBe(409);
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(0);
    const state = await f.owner.get(`/api/sign-jobs/${job.id}`).expect(200);
    expect(state.body.status).toBe(operation === 'cancel' ? 'cancelled' : 'expired');
  });

  it('serializes competing callbacks and handles the accepted retry without another signature check', async () => {
    const f = await fixture(); const job = await createJob(f);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.adapter.verifyResponse.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ identityId, systemId: TESTNET_SYSTEM_ID, nativeSignature: 'mock-native-signature', identity, displayIdentity }); entered();
    }));
    const first = callback(f, job.id).then(response => response);
    await started;
    expect((await callback(f, job.id, Buffer.from('competing response'))).status).toBe(409);
    expect(f.adapter.verifyResponse).toHaveBeenCalledTimes(1);
    release(); expect((await first).status).toBe(200);
    await completed(f, job.id);
    expect((await callback(f, job.id)).status).toBe(200);
    expect(f.adapter.verifyResponse).toHaveBeenCalledTimes(1);
    expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(1);
  });

  it('resumes an accepted signature persisted before process restart', async () => {
    const f = await fixture(); const job = await createJob(f);
    await f.close();
    const file = path.join(f.dataDir, 'jobs', job.id, 'job.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.status = 'finalizing';
    saved.accepted = { identityId, systemId: TESTNET_SYSTEM_ID, nativeSignature: 'mock-native-signature', identity, displayIdentity };
    saved.acceptedHash = 'e1'.repeat(32);
    fs.writeFileSync(file, JSON.stringify(saved));
    // Interrupted output must not be trusted; the new worker rebuilds it.
    fs.writeFileSync(path.join(f.dataDir, 'jobs', job.id, 'output.png'), 'interrupted output');
    const restarted = await createApp(f.config, { worker: f.worker, adapter: f.adapter });
    cleanups.push(async () => { await restarted.close(); });
    const owner = request.agent(restarted.app);
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await owner.get(`/api/sign-jobs/${job.id}`).set('Cookie', f.cookie).expect(200);
      if (response.body.status === 'complete') {
        const download = await owner.get(response.body.downloadUrl).set('Cookie', f.cookie).expect(200);
        expect(download.body).toEqual(png);
        expect(f.workerRun.mock.calls.filter(([c]) => c.cmd === 'finalize')).toHaveLength(1);
        return;
      }
      expect(response.body.status).toBe('finalizing');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Accepted job did not resume');
  });

  it('does not resurrect a job that expired during image preparation', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = f.workerRun.getMockImplementation()!;
    f.workerRun.mockImplementationOnce(async command => {
      const value = await original(command);
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return value;
    });
    const pending = f.owner.post('/api/sign-jobs').attach('image', png, 'image.png').then(response => response);
    await started;
    const id = fs.readdirSync(path.join(f.dataDir, 'jobs'))[0];
    const file = path.join(f.dataDir, 'jobs', id, 'job.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.expiresAt = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    release();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    const state = await f.owner.get(`/api/sign-jobs/${id}`).expect(200);
    expect(state.body.status).toBe('expired');
    expect(fs.existsSync(path.join(f.dataDir, 'jobs', id, 'source.png'))).toBe(false);
  });

  it('enforces output retention at download time without waiting for periodic cleanup', async () => {
    const f = await fixture(); const job = await createJob(f);
    expect((await callback(f, job.id)).status).toBe(200);
    const finished = await completed(f, job.id);
    const file = path.join(f.dataDir, 'jobs', job.id, 'job.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.deleteAt = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    const download = await f.owner.get(finished.downloadUrl);
    expect(download.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(f.dataDir, 'jobs', job.id, 'output.png'))).toBe(false);
  });
});

describe('bounded image admission', () => {
  it('rejects the forty-first upload before invoking the worker', async () => {
    const f = await fixture();
    f.workerRun.mockRejectedValue(new WorkerError('no_watermark', 'No frame'));
    for (let i = 0; i < 40; i++) {
      await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(200);
    }
    await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(429);
    expect(f.workerRun).toHaveBeenCalledTimes(40);
  });

  it('bounds concurrent uploads and restores capacity after processing finishes', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    let count = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = f.workerRun.getMockImplementation()!;
    f.workerRun.mockImplementation(async command => {
      if (command.cmd === 'inspect') {
        if (++count === 8) entered();
        await blocked;
      }
      return original(command);
    });
    const pending = Array.from({ length: 8 }, () => f.owner.post('/api/verify').attach('image', png, 'image.png').then(response => response));
    await started;
    try {
      await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(503);
      expect(count).toBe(8);
    } finally { release(); }
    expect((await Promise.all(pending)).every(response => response.status === 200)).toBe(true);
    await f.owner.post('/api/verify').attach('image', png, 'image.png').expect(200);
    expect(count).toBe(9);
  });
});

describe('wallet browser redirects', () => {
  it('accepts canonical signed bytes with no session, preserves the owner, and redirects to a clean URL', async () => {
    const f = await fixture({ publicOrigin: 'http://192.168.1.42:5173', responseMode: 'redirect' });
    const config = await request(f.app).get('/api/config').set('Host', '192.168.1.42:5173').expect(200);
    expect(config.headers['set-cookie'][0]).not.toMatch(/; Secure(?:;|$)/);
    expect(config.body.responseMode).toBe('redirect');
    const job = await createJob(f);
    expect(f.adapter.createRequest).toHaveBeenCalledWith(expect.objectContaining({ responseMode: 'redirect', callbackUrl: `http://192.168.1.42:5173/api/sign-jobs/${job.id}/response` }));
    const body = Buffer.from('local signed response');
    const url = `/api/sign-jobs/${job.id}/response?${GENERIC_RESPONSE_QUERY_KEY}=${body.toString('base64url')}`;
    // SameSite=Strict can omit the original browser cookie on the first return.
    const response = await request(f.app).get(url).set('Sec-Fetch-Site', 'cross-site').expect(303);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers.location).toBe(`/?walletReturn=${job.id}`);
    expect(response.headers.location).not.toContain(body.toString('base64url'));
    expect(f.adapter.verifyResponse).toHaveBeenCalledWith(expect.objectContaining({ body }));
    const done = await completed(f, job.id);
    await f.owner.get(done.downloadUrl).expect(200);
    await f.stranger.get(done.downloadUrl).expect(404);
    await request(f.app).get(done.downloadUrl).expect(404);
    // A redirected callback cannot rotate an existing browser's owner either.
    await f.owner.get(url).expect(303).expect('Location', `/?walletReturn=${job.id}`);
    await callback(f, job.id, body).expect(200);
    expect(f.adapter.verifyResponse).toHaveBeenCalledTimes(1);
    expect(f.workerRun.mock.calls.filter(([command]) => command.cmd === 'finalize')).toHaveLength(1);
  });

  it('rejects duplicate, empty, padded, malformed and noncanonical base64url before validation', async () => {
    const f = await fixture(); const job = await createJob(f);
    const key = GENERIC_RESPONSE_QUERY_KEY;
    for (const query of ['', `${key}=`, `${key}=AA==`, `${key}=A`, `${key}=AB`, `${key}=a+b`, `${key}=AA&${key}=AA`]) {
      const response = await request(f.app).get(`/api/sign-jobs/${job.id}/response?${query}`).expect(303);
      expect(response.headers.location).toBe(`/?walletReturn=${job.id}&returnError=INVALID_CALLBACK`);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(f.adapter.verifyResponse).not.toHaveBeenCalled();
    expect((await f.owner.get(`/api/sign-jobs/${job.id}`)).body.status).toBe('awaiting_signature');
  });

  it('does not accept bad signatures or expired jobs through a redirect', async () => {
    const f = await fixture(); const job = await createJob(f);
    const url = `/api/sign-jobs/${job.id}/response?${GENERIC_RESPONSE_QUERY_KEY}=AA`;
    f.adapter.verifyResponse.mockRejectedValue(new VerusError('INVALID_SIGNATURE', 'Private parser detail must not enter the URL'));
    await request(f.app).get(url).expect(303).expect('Location', `/?walletReturn=${job.id}&returnError=INVALID_SIGNATURE`);
    expect((await f.owner.get(`/api/sign-jobs/${job.id}`)).body.status).toBe('awaiting_signature');
    const file = path.join(f.dataDir, 'jobs', job.id, 'job.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.expiresAt = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    await request(f.app).get(url).expect(303).expect('Location', `/?walletReturn=${job.id}&returnError=JOB_CLOSED`);
    expect(f.adapter.verifyResponse).toHaveBeenCalledTimes(1);
    expect((await f.owner.get(`/api/sign-jobs/${job.id}`)).body.status).toBe('expired');
    expect(f.workerRun.mock.calls.filter(([command]) => command.cmd === 'finalize')).toHaveLength(0);
  });
});
