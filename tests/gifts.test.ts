import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenericRequest, SpendableKeyDetails, SpendableKeyDetailsOrdinalVDXFObject, nameAndParentAddrToIAddr } from 'verus-typescript-primitives';
import { loadConfig } from '../server/config.js';
import { StoreConflict, type StoredObject } from '../server/cloud-store.js';
import { HttpError } from '../server/errors.js';
import { CloudGiftStore, GiftService, LocalGiftStore, GIFT_STATE_OBJECT,
  importGiftInventory, loadGiftConfig, validateGiftInventory,
  type GiftConfig, type GiftInventory, type GiftStore } from '../server/gifts.js';
import { mountGiftRoutes } from '../server/gift-routes.js';
import { makeGiftCard } from '../scripts/generate-gifts.js';
import { GIFT_TESTNET_SYSTEM } from '../scripts/gift-referrals.js';
import { FirebaseGiftObjects, importOptions, runGiftImport, verifyPrivateGiftBucket } from '../scripts/import-gifts.js';

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const owner = (name: string) => createHash('sha256').update(name).digest('hex');
const config = (): GiftConfig => ({ enabled: true, stateFile: '/unused' });
function inventory(count = 4, start = 1): GiftInventory {
  return { format: 'vatermark-gift-inventory', version: 1, network: 'VRSCTEST', parent: 'vrsctest@',
    batchId: start.toString(16).padStart(32, '0'), createdAt: '2026-10-14T00:00:00.000Z',
    cards: Array.from({ length: count }, (_, offset) => {
      const id = start + offset;
      const seed = new SpendableKeyDetails({ data: Buffer.alloc(32, id) });
      const uri = new GenericRequest({ flags: GenericRequest.FLAG_IS_TESTNET,
        details: [new SpendableKeyDetailsOrdinalVDXFObject({ data: seed })] }).toWalletDeeplinkUri();
      const draft = makeGiftCard(`bright${String.fromCharCode(97 + Math.floor(id / 26), 97 + id % 26)}bird`,
        GIFT_TESTNET_SYSTEM, Buffer.alloc(32, id));
      return { id: id.toString(16).padStart(32, '0'), identityName: draft.identityName,
        identityId: draft.identityId, address: draft.address, walletUri: uri,
        fundingTxid: id.toString(16).padStart(64, '0'), registrationTxid: (id + 100).toString(16).padStart(64, '0'), amount: '1.00000000' };
    }) };
}
class Objects {
  data = new Map<string, StoredObject>(); revision = 0;
  async read(name: string) { const entry = this.data.get(name); return entry && { data: Buffer.from(entry.data), revision: entry.revision }; }
  async write(name: string, data: Buffer, revision: string | 0) {
    if ((this.data.get(name)?.revision ?? 0) !== revision) throw new StoreConflict();
    const next = String(++this.revision); this.data.set(name, { data: Buffer.from(data), revision: next }); return next;
  }
}
function local() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-gifts-test-')); cleanup.push(dir);
  const filename = path.join(dir, 'private', 'state.json');
  return { a: new LocalGiftStore(filename), b: new LocalGiftStore(filename), filename };
}
async function fixture(store?: GiftStore, count = 4) {
  const s = store ?? local().a; const source = inventory(count); await importGiftInventory(s, source);
  return { store: s, source, service: new GiftService(config(), s) };
}

describe('gift inventory and configuration', () => {
  it('accepts a canonical testnet mobile SpendableKeyDetails request and rejects mainnet or malformed data', () => {
    const data = inventory(); expect(validateGiftInventory(data).cards).toHaveLength(4);
    const invalid = structuredClone(data); invalid.cards[0].walletUri = 'https://evil.example/secret';
    expect(() => validateGiftInventory(invalid)).toThrow('Invalid gift inventory');
    invalid.cards[0].walletUri = new GenericRequest({ details: [new SpendableKeyDetailsOrdinalVDXFObject({ data: new SpendableKeyDetails({ data: Buffer.alloc(32, 5) }) })] }).toWalletDeeplinkUri();
    expect(() => validateGiftInventory(invalid)).toThrow('Invalid gift inventory');
    expect(() => validateGiftInventory({ ...data, network: 'VRSC' })).toThrow('Invalid gift inventory');
    expect(() => validateGiftInventory({ ...data, secret: 'accidental-field' })).toThrow('Invalid gift inventory');
    invalid.cards[1] = { ...data.cards[1], walletUri: data.cards[0].walletUri };
    expect(() => validateGiftInventory(invalid)).toThrow('Invalid gift inventory');
  });
  it('reimports safely without resetting issued cards and rejects collisions atomically', async () => {
    const f = await fixture(); const assigned = await f.service.claim(owner('alice'));
    expect(await importGiftInventory(f.store, f.source)).toEqual({ added: 0, total: 4 });
    expect(await f.service.current(owner('alice'))).toEqual(assigned);
    const extra = inventory(2, 5); extra.cards[1].address = f.source.cards[0].address;
    await expect(importGiftInventory(f.store, extra)).rejects.toThrow('Invalid gift inventory');
    expect((await f.store.read()).cards).toHaveLength(4);
    expect(await importGiftInventory(f.store, inventory(2, 5))).toEqual({ added: 2, total: 6 });
  });
  it('enables gifts without external verification or quota configuration', () => {
    const app = loadConfig({});
    expect(loadGiftConfig({}, app).enabled).toBe(false);
    expect(loadGiftConfig({ GIFTS_ENABLED: 'true' }, app).enabled).toBe(true);
    expect(loadGiftConfig({ GIFTS_ENABLED: 'true', NODE_ENV: 'production' },
      { ...app, host: '0.0.0.0', publicOrigin: 'https://vatermark.example', jobStorageBucket: 'private' }).enabled).toBe(true);
    expect(() => loadGiftConfig({ GIFTS_ENABLED: 'invalid' }, app)).toThrow('true or false');
    expect(loadGiftConfig({ GIFTS_ENABLED: 'true', GIFTS_HOURLY_LIMIT: 'invalid', GIFTS_DAILY_LIMIT: '0',
      GIFTS_NETWORK_COOLDOWN_HOURS: '0' }, app)).toEqual(loadGiftConfig({ GIFTS_ENABLED: 'true' }, app));
  });
});

describe('durable gift assignment', () => {
  it('returns no secret before assignment and keeps the same card across retries and restarts', async () => {
    const pair = local(); const f = await fixture(pair.a);
    expect(await f.service.current(owner('alice'))).toBeUndefined();
    expect(Object.keys((await pair.b.read()).assignments)).toHaveLength(0);
    const card = await f.service.claim(owner('alice'));
    const restarted = new GiftService(config(), pair.b);
    expect(await restarted.claim(owner('alice'))).toEqual(card);
    expect(await restarted.current(owner('other'))).toBeUndefined();
    expect(fs.statSync(pair.filename).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(pair.filename)).mode & 0o777).toBe(0o700);
    expect((await pair.b.read()).assignments[owner('alice')]).not.toHaveProperty('networkHash');
  });
  it.each(['local', 'cloud'])('assigns each card only once across concurrent %s instances', async mode => {
    const localPair = local(); const objects = new Objects();
    const a = mode === 'local' ? localPair.a : new CloudGiftStore(objects);
    const b = mode === 'local' ? localPair.b : new CloudGiftStore(objects);
    const f = await fixture(a);
    const second = new GiftService(config(), b);
    const results = await Promise.all([f.service.claim(owner('alice')), second.claim(owner('bob'))]);
    expect(new Set(results.map(card => card.id)).size).toBe(2);
    const same = await Promise.all([f.service.claim(owner('carol')), second.claim(owner('carol'))]);
    expect(same[0]).toEqual(same[1]);
    expect(Object.keys((await a.read()).assignments)).toHaveLength(3);
  });
  it('serializes two separate Node processes sharing the same local inventory', async () => {
    const pair = local(); await importGiftInventory(pair.a, inventory());
    const filename = fileURLToPath(new URL('../server/gifts.ts', import.meta.url));
    const code = `import { LocalGiftStore, GiftService } from ${JSON.stringify(new URL(`file://${filename}`).href)};
      const store = new LocalGiftStore(process.argv[1]);
      const service = new GiftService(JSON.parse(process.argv[2]), store);
      const card = await service.claim(process.argv[3]);
      process.stdout.write(card.id);`;
    const run = promisify(execFile);
    const results = await Promise.all(['alice', 'bob'].map(name => run(process.execPath,
      ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', code, pair.filename, JSON.stringify(config()), owner(name)])));
    expect(new Set(results.map(result => result.stdout)).size).toBe(2);
    expect(Object.keys((await pair.b.read()).assignments)).toHaveLength(2);
  });
  it('assigns more than four simultaneous local claims while keeping retries idempotent', async () => {
    const f = await fixture(undefined, 8);
    const owners = Array.from({ length: 8 }, (_, index) => owner(`concurrent-${index}`));
    const cards = await Promise.all(owners.map(value => f.service.claim(value)));
    expect(new Set(cards.map(card => card.id)).size).toBe(8);
    expect(await Promise.all(owners.map(value => f.service.claim(value)))).toEqual(cards);
    expect(Object.keys((await f.store.read()).assignments)).toHaveLength(8);
  });
  it.each(['local', 'cloud'])('preserves legacy %s assignments without applying their network hashes to new claims', async mode => {
    const store = mode === 'local' ? local().a : new CloudGiftStore(new Objects());
    const f = await fixture(store);
    const oldOwner = owner('legacy-owner');
    const oldAssignment = { cardId: f.source.cards[0].id, assignedAt: Date.now(), networkHash: 'ab'.repeat(32) };
    await store.update(state => { state.assignments[oldOwner] = oldAssignment; });
    const oldCard = await new GiftService(config(), store).claim(oldOwner);
    expect(oldCard.id).toBe(oldAssignment.cardId);
    const next = await new GiftService(config(), store).claim(owner('new-owner'));
    expect(next.id).not.toBe(oldCard.id);
    expect(await importGiftInventory(store, f.source)).toEqual({ added: 0, total: 4 });
    const ledger = await store.read();
    expect(ledger.assignments[oldOwner]).toEqual(oldAssignment);
    expect(ledger.assignments[owner('new-owner')]).toEqual({ cardId: next.id, assignedAt: Date.parse(next.assignedAt) });
    expect(await new GiftService(config(), store).current(oldOwner)).toEqual(oldCard);
    expect(await new GiftService(config(), store).current(owner('new-owner'))).toEqual(next);
  });
  it('never assigns an exhausted inventory or silently replaces corrupted durable state', async () => {
    const pair = local(); const f = await fixture(pair.a, 1);
    await f.service.claim(owner('a'));
    await expect(f.service.claim(owner('b'))).rejects.toMatchObject({ code: 'GIFTS_EMPTY' });
    fs.writeFileSync(pair.filename, '{invalid');
    await expect(f.service.current(owner('a'))).rejects.toMatchObject({ code: 'GIFTS_UNAVAILABLE' });
  });
  it('recovers a committed cloud assignment after an interrupted HTTP response', async () => {
    const objects = new Objects(); const store = new CloudGiftStore(objects); const f = await fixture(store);
    const original = objects.write.bind(objects); let fail = true;
    objects.write = async (...args) => { const result = await original(...args); if (fail) { fail = false; throw new Error('Connection interrupted'); } return result; };
    await expect(f.service.claim(owner('alice'))).rejects.toThrow('interrupted');
    const current = await new GiftService(config(), new CloudGiftStore(objects)).current(owner('alice'));
    expect(current?.id).toBe(f.source.cards[0].id);
    expect(objects.data.has(GIFT_STATE_OBJECT)).toBe(true);
    expect(Object.keys((await store.read()).assignments)).toHaveLength(1);
  });
});

describe('gift HTTP surface', () => {
  it('reveals only the current owner card and never permits listing/import or secret URL parameters', async () => {
    const f = await fixture(); const app = express();
    app.use((req, res, next) => { res.locals.owner = owner(req.get('x-test-owner') || 'alice'); next(); });
    mountGiftRoutes(app, { service: f.service });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = error as HttpError; res.status(e.status || 500).json({ error: { code: e.code } });
    });
    const before = await request(app).get('/api/gifts/current').expect(200);
    expect(before.body).toEqual({ card: null });
    await request(app).post('/api/gifts/claim').send({ id: f.source.cards[0].id }).expect(400);
    const response = await request(app).post('/api/gifts/claim').send({}).expect(200);
    expect(response.body.card.walletUri).toBe(f.source.cards[0].walletUri);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(response.body)).not.toContain(f.source.cards[1].walletUri);
    expect(f.service.publicConfig()).toEqual({ enabled: true });
    const other = await request(app).get('/api/gifts/current').set('x-test-owner', 'bob').expect(200);
    expect(other.body.card).toBeNull();
    await request(app).get('/api/gifts').expect(404);
    await request(app).post('/api/gifts/import').send(f.source).expect(404);
    await request(app).get(`/api/gifts/${f.source.cards[0].id}`).expect(404);
  });
});


describe('private inventory import CLI', () => {
  it('defaults to local and requires an explicit complete cloud destination', () => {
    expect(importOptions(['--file', '/private/batch.json']).cloud).toBe(false);
    expect(() => importOptions(['--file', '/private/batch.json', '--bucket', 'private'])).toThrow('explicit --cloud');
    for (const incomplete of [
      ['--cloud'],
      ['--cloud', '--bucket', 'private'],
      ['--cloud', '--project', 'fork-project-123'],
      ['--cloud', '--project', 'fork-project-123', '--bucket', 'private', '--state', '/private/state.json'],
    ]) {
      expect(() => importOptions(['--file', '/private/batch.json', ...incomplete])).toThrow('requires --cloud');
    }
    expect(importOptions(['--file', '/private/batch.json', '--cloud', '--project', 'fork-project-123', '--bucket', 'fork-private'])).toMatchObject({
      cloud: true, project: 'fork-project-123', bucket: 'fork-private',
    });
  });
  it.each(['short', '123456', 'UPPER-case', '-bad-project', 'bad-project-', 'bad/project', 'a'.repeat(31)])(
    'rejects malformed project ID %s before reading credentials or making cloud requests', async project => {
      expect(() => importOptions(['--file', '/private/batch.json', '--cloud', '--project', project, '--bucket', 'private']))
        .toThrow('Invalid Google Cloud project ID');
      const fetcher = vi.fn();
      await expect(verifyPrivateGiftBucket(project, 'private-bucket', fetcher)).rejects.toThrow('Invalid Google Cloud project ID');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('checks the explicitly selected fork project and refuses different-project or public buckets', async () => {
    const project = 'fork-project-123';
    const metadata = { projectNumber: '123', iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } };
    const replies = [{ projectNumber: '123' }, metadata, { bindings: [{ role: 'roles/storage.admin', members: ['serviceAccount:private@example.test'] }] }];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(replies.shift())));
    await verifyPrivateGiftBucket(project, 'private-bucket', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]).toEqual(['https://cloudresourcemanager.googleapis.com/v1/projects/fork-project-123']);
    expect(fetcher.mock.calls[1]).toEqual(['https://storage.googleapis.com/storage/v1/b/private-bucket']);
    const wrongProject = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ projectNumber: '123' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...metadata, projectNumber: '456' })));
    await expect(verifyPrivateGiftBucket(project, 'private-bucket', wrongProject)).rejects.toThrow('belong to the selected project');
    expect(wrongProject).toHaveBeenCalledTimes(2);
    for (const publicMember of ['allUsers', 'allAuthenticatedUsers']) {
      const publicBucket = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ projectNumber: '123' })))
        .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
        .mockResolvedValueOnce(new Response(JSON.stringify({ bindings: [{ members: [publicMember] }] })));
      await expect(verifyPrivateGiftBucket(project, 'private-bucket', publicBucket)).rejects.toThrow('public');
    }
    for (const iamConfiguration of [
      {},
      { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: 'enforced' },
      { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'inherited' },
    ]) {
      const weakAccess = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ projectNumber: '123' })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...metadata, iamConfiguration })));
      await expect(verifyPrivateGiftBucket(project, 'private-bucket', weakAccess)).rejects.toThrow('uniform access');
      expect(weakAccess).toHaveBeenCalledTimes(2);
    }
    const malformedBucket = vi.fn();
    await expect(verifyPrivateGiftBucket(project, '../private', malformedBucket)).rejects.toThrow('bucket name');
    expect(malformedBucket).not.toHaveBeenCalled();
  });
  it('pins cloud reads and writes the same generation with a private cache policy', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit): Promise<Response> => new Response());
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ generation: '52' })))
      .mockResolvedValueOnce(new Response('synthetic-private-state'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation: '53' })))
      .mockResolvedValueOnce(new Response('', { status: 412 }));
    const objects = new FirebaseGiftObjects('private-bucket', fetcher);
    expect(await objects.read(GIFT_STATE_OBJECT)).toEqual({ data: Buffer.from('synthetic-private-state'), revision: '52' });
    expect(fetcher.mock.calls[1][0]).toContain('alt=media&generation=52');
    expect(await objects.write(GIFT_STATE_OBJECT, Buffer.from('{}'), '52')).toBe('53');
    expect(fetcher.mock.calls[2][0]).toContain('ifGenerationMatch=52');
    expect(Buffer.from(fetcher.mock.calls[2][1]!.body as Uint8Array).toString()).toContain('private, no-store');
    await expect(objects.write(GIFT_STATE_OBJECT, Buffer.from('{}'), '52')).rejects.toBeInstanceOf(StoreConflict);
  });
  it('imports a private local file and repeats safely without cloud requests or secret output', async () => {
    const pair = local(); const filename = path.join(path.dirname(pair.filename), 'batch.json');
    const source = inventory(); fs.writeFileSync(filename, JSON.stringify(source), { mode: 0o600 });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected cloud operation'); });
    try {
      await runGiftImport(['--file', filename, '--state', pair.filename]);
      await runGiftImport(['--file', filename, '--state', pair.filename]);
      expect((await pair.a.read()).cards).toHaveLength(4); expect(network).not.toHaveBeenCalled();
      const text = output.mock.calls.map(call => String(call[0])).join('');
      expect(text).toContain('"added":4'); expect(text).toContain('"added":0');
      for (const card of source.cards) expect(text).not.toContain(card.walletUri);
      const wrongAddress = inventory(); wrongAddress.cards[0].address = wrongAddress.cards[1].address; wrongAddress.cards = [wrongAddress.cards[0]];
      fs.writeFileSync(filename, JSON.stringify(wrongAddress));
      await expect(runGiftImport(['--file', filename, '--state', pair.filename])).rejects.toThrow('does not match');
      fs.chmodSync(filename, 0o644);
      await expect(runGiftImport(['--file', filename, '--state', pair.filename])).rejects.toThrow('chmod 600');
    } finally { output.mockRestore(); network.mockRestore(); }
  });
});
