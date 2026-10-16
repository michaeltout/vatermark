import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenericRequest, SpendableKeyDetails, SpendableKeyDetailsOrdinalVDXFObject, nameAndParentAddrToIAddr } from 'verus-typescript-primitives';
import { createApp, type Adapter } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { GiftService, LocalGiftStore, importGiftInventory, type GiftInventory } from '../server/gifts.js';
import type { Worker } from '../server/worker.js';
import { TESTNET_SYSTEM_ID } from '../server/verus.js';
import { deriveGiftAddress } from '../scripts/generate-gifts.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Deterministic, unfunded entropy, fake txids, and a fresh private directory.
 * These tests never read the real batch, service credentials, or local wallet. */
function syntheticInventory(count = 2): GiftInventory {
  return { format: 'vatermark-gift-inventory', version: 1, network: 'VRSCTEST', parent: 'vrsctest@',
    batchId: 'ac'.repeat(16), createdAt: '2026-10-14T00:00:00.000Z', cards: Array.from({ length: count }, (_, index) => {
      const leaf = ['testcedar', 'testwillow'][index] ?? `test${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}tree`;
      const entropy = Buffer.alloc(32, index + 31);
      const walletUri = new GenericRequest({ flags: GenericRequest.FLAG_IS_TESTNET,
        details: [new SpendableKeyDetailsOrdinalVDXFObject({ data: new SpendableKeyDetails({ data: entropy }) })] }).toWalletDeeplinkUri();
      return { id: (index + 1).toString(16).padStart(32, '0'), identityName: `${leaf}.vrsctest@`,
        identityId: nameAndParentAddrToIAddr(leaf, TESTNET_SYSTEM_ID), address: deriveGiftAddress(entropy), walletUri,
        fundingTxid: 'a'.repeat(64), registrationTxid: 'b'.repeat(64), amount: '1.00000000' };
    }) };
}
async function fixture(count = 2) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-gift-api-test-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: path.join(directory, '.data'), GIFTS_ENABLED: 'true',
    VATERMARK_SERVICE_ID: nameAndParentAddrToIAddr('synthetic', TESTNET_SYSTEM_ID), VATERMARK_SERVICE_WIF: 'synthetic-service-secret-never-expose' });
  const store = new LocalGiftStore(config.gifts!.stateFile);
  const inventory = syntheticInventory(count); await importGiftInventory(store, inventory);
  const gifts = new GiftService(config.gifts!, store);
  const worker = { run: vi.fn(async () => { throw new Error('Gift allocation must not run the image worker'); }) } as unknown as Worker;
  const adapter = { status: vi.fn(async () => ({ enabled: true })), createRequest: vi.fn(), resolveIdentity: vi.fn(), verifyResponse: vi.fn() } as Adapter;
  const created = await createApp(config, { worker, adapter, gifts }); cleanups.push(created.close);
  const owner = request.agent(created.app); const stranger = request.agent(created.app);
  const publicConfig = await owner.get('/api/config').expect(200);
  const cookie = publicConfig.headers['set-cookie'][0].split(';')[0];
  await stranger.get('/api/config').expect(200);
  return { ...created, owner, stranger, cookie, config, store, inventory, gifts, worker, adapter, publicConfig };
}

describe('gift claims through real application middleware', () => {
  it('binds the assigned QR to the real HttpOnly owner cookie and survives restart', async () => {
    const f = await fixture();
    expect(f.publicConfig.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(f.publicConfig.headers['set-cookie'][0]).toContain('SameSite=Strict');
    expect(f.publicConfig.body.gifts).toEqual({ enabled: true });
    expect(f.publicConfig.text).not.toContain('synthetic-service-secret');
    for (const card of f.inventory.cards) expect(f.publicConfig.text).not.toContain(card.walletUri);
    expect((await f.owner.get('/api/gifts/current').expect(200)).body.card).toBeNull();
    const claimed = await f.owner.post('/api/gifts/claim').set('Origin', f.config.publicOrigin!).send({}).expect(200);
    expect(claimed.headers['cache-control']).toBe('private, no-store');
    expect(claimed.body.card.identityName).toBe('testcedar.vrsctest@');
    expect(claimed.body.card.walletUri).toBe(f.inventory.cards[0].walletUri);
    expect(claimed.text).not.toContain(f.inventory.cards[1].walletUri);
    expect((await f.stranger.get('/api/gifts/current').expect(200)).body.card).toBeNull();
    expect((await f.owner.get('/api/gifts/current').expect(200)).body.card).toEqual(claimed.body.card);
    const retry = await f.owner.post('/api/gifts/claim').send({}).expect(200);
    expect(retry.body.card).toEqual(claimed.body.card);
    await f.close();
    const restarted = await createApp(f.config, { worker: f.worker, adapter: f.adapter,
      gifts: new GiftService(f.config.gifts!, new LocalGiftStore(f.config.gifts!.stateFile)) });
    cleanups.push(restarted.close);
    const restored = await request(restarted.app).get('/api/gifts/current').set('Cookie', f.cookie).expect(200);
    expect(restored.body.card).toEqual(claimed.body.card);
    expect(f.worker.run).not.toHaveBeenCalled(); expect(f.adapter.createRequest).not.toHaveBeenCalled();
  });
  it('rejects cross-site claims and reveals no inventory routes', async () => {
    const f = await fixture();
    await f.owner.post('/api/gifts/claim').set('Origin', 'https://evil.example').send({}).expect(403);
    await f.owner.post('/api/gifts/claim').set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
    await f.owner.post('/api/gifts/claim').send({ id: f.inventory.cards[1].id }).expect(400);
    await f.owner.get('/api/gifts').expect(404);
    await f.owner.get(`/api/gifts/${f.inventory.cards[0].id}`).expect(404);
    await f.owner.post('/api/gifts/import').send(f.inventory).expect(404);
    expect(Object.keys((await f.store.read()).assignments)).toHaveLength(0);
  });
  it('serves distinct sessions on one proxy beyond former network, route, hourly, daily, and API limits', async () => {
    const f = await fixture(42);
    const first = await f.owner.post('/api/gifts/claim').send({}).expect(200);
    const ids = new Set([first.body.card.id]);
    // Every request has the same real socket address and a fresh owner cookie.
    // Neither normal nor malformed forwarding headers affect eligibility.
    for (let index = 0; index < 40; index++) {
      const fresh = await request(f.app).post('/api/gifts/claim')
        .set('X-Forwarded-For', index % 2 ? 'not-an-ip' : '203.0.113.24, 35.191.0.1')
        .set('Fastly-Client-IP', '203.0.113.24').send({}).expect(200);
      ids.add(fresh.body.card.id);
    }
    expect(ids.size).toBe(41);
    // Gift reads and retries also bypass the common 300/min API limiter.
    for (let index = 0; index < 301; index++) {
      const current = await f.owner.get('/api/gifts/current').expect(200);
      expect(current.body.card).toEqual(first.body.card);
    }
    for (let index = 0; index < 301; index++) {
      const retry = await f.owner.post('/api/gifts/claim').send({}).expect(200);
      expect(retry.body.card).toEqual(first.body.card);
    }
    const state = await f.store.read();
    expect(Object.keys(state.assignments)).toHaveLength(41);
    for (const assignment of Object.values(state.assignments)) expect(assignment).not.toHaveProperty('networkHash');
    expect((await f.stranger.get('/api/gifts/current').expect(200)).body.card).toBeNull();
    expect(f.worker.run).not.toHaveBeenCalled();
  });
  it('accepts only an empty JSON object and assigns without contacting an external service', async () => {
    const f = await fixture();
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected external request'); });
    try {
      await f.owner.post('/api/gifts/claim').send({ unexpected: 'field' }).expect(400);
      await f.owner.post('/api/gifts/claim').send([]).expect(400);
      await f.owner.post('/api/gifts/claim').expect(400);
      expect(Object.keys((await f.store.read()).assignments)).toHaveLength(0);
      const response = await f.owner.post('/api/gifts/claim').set('Origin', f.config.publicOrigin!).send({}).expect(200);
      expect(response.body.card.walletUri).toBe(f.inventory.cards[0].walletUri);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
