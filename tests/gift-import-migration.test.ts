import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeGiftCard } from '../scripts/generate-gifts.js';
import { GIFT_TESTNET_SYSTEM } from '../scripts/gift-referrals.js';
import { assertGiftLifecycleSafe, assertNoLocalGiftOverlap, excludeAssignedGiftCards, importOptions, importUnassignedGiftInventory, runGiftImport } from '../scripts/import-gifts.js';
import { CloudGiftStore, LocalGiftStore, importGiftInventory, type GiftInventory, type GiftState } from '../server/gifts.js';
import { StoreConflict, type StoredObject } from '../server/cloud-store.js';

const cleanup: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const folder of cleanup.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
const owner = 'a'.repeat(64);
function inventory(): GiftInventory {
  return { format: 'vatermark-gift-inventory', version: 1, network: 'VRSCTEST', parent: 'vrsctest@',
    batchId: '1'.repeat(32), createdAt: '2026-10-14T00:00:00.000Z',
    cards: ['brightotter', 'calmfox', 'wiseowl'].map((leaf, index) => {
      const card = makeGiftCard(leaf, GIFT_TESTNET_SYSTEM, Buffer.alloc(32, index + 1));
      return { id: (index + 1).toString(16).padStart(32, '0'), identityName: card.identityName, identityId: card.identityId,
        address: card.address, walletUri: card.walletUri, amount: '1.00000000', fundingTxid: '3'.repeat(64), registrationTxid: String(index + 4).repeat(64) };
    }) };
}
function sourceState(source = inventory()): GiftState {
  return { format: 'vatermark-gift-state', version: 1, salt: 'b'.repeat(64), batches: [source.batchId], cards: source.cards,
    assignments: { [owner]: { cardId: source.cards[0].id, assignedAt: 1, networkHash: 'c'.repeat(64) } } };
}
class Objects {
  value?: StoredObject; revision = 0;
  async read() { return this.value && { data: Buffer.from(this.value.data), revision: this.value.revision }; }
  async write(_name: string, data: Buffer, revision: string | 0) {
    if ((this.value?.revision ?? 0) !== revision) throw new StoreConflict();
    this.value = { data: Buffer.from(data), revision: String(++this.revision) }; return this.value.revision;
  }
}
function privateFiles() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-gift-migration-')); cleanup.push(folder);
  const input = path.join(folder, 'original.inventory.json'), state = path.join(folder, 'state.json'), output = path.join(folder, 'hosted.inventory.json');
  const source = inventory();
  fs.writeFileSync(input, JSON.stringify(source), { mode: 0o600 });
  fs.writeFileSync(state, JSON.stringify(sourceState(source)), { mode: 0o600 });
  return { folder, input, state, output, source };
}

describe('gift inventory migration', () => {
  it('requires an explicit exclusion state for an offline export and forbids simultaneous import', () => {
    expect(() => importOptions(['--file', 'batch.json', '--export-unassigned', 'hosted.json'])).toThrow('requires --exclude-assigned-state');
    expect(() => importOptions(['--file', 'batch.json', '--exclude-assigned-state', 'state.json', '--export-unassigned', 'hosted.json', '--state', 'other.json'])).toThrow('cannot import');
    const parsed = importOptions(['--file', 'batch.json', '--exclude-assigned-state', 'state.json', '--export-unassigned', 'hosted.json']);
    expect(parsed.cloud).toBe(false); expect(parsed.exportUnassigned).toBe(path.resolve('hosted.json'));
  });
  it('excludes local assignments permanently, including expired browser sessions', () => {
    const source = inventory(); const state = sourceState(source); const before = structuredClone(state);
    const filtered = excludeAssignedGiftCards(source, state);
    expect(filtered.excluded.map(card => card.id)).toEqual([source.cards[0].id]);
    expect(filtered.inventory.cards).toEqual(source.cards.slice(1));
    expect(filtered.inventory.batchId).toBe(source.batchId); expect(state).toEqual(before);
  });
  it('requires matching local batch membership and every exact original card record', () => {
    const source = inventory(); const state = sourceState(source);
    expect(() => excludeAssignedGiftCards(source, { ...state, batches: [] })).toThrow('does not contain this batch');
    expect(() => excludeAssignedGiftCards(source, { ...state, cards: state.cards.slice(1) })).toThrow('identical records');
    const altered = structuredClone(state); altered.cards[0].fundingTxid = 'f'.repeat(64);
    expect(() => excludeAssignedGiftCards(source, altered)).toThrow('identical records');
  });
  it('refuses an empty candidate when every card was already allocated', () => {
    const source = inventory(); const state = sourceState(source);
    for (let i = 1; i < source.cards.length; i++) state.assignments[String(i).repeat(64)] = { cardId: source.cards[i].id, assignedAt: 1, networkHash: 'c'.repeat(64) };
    expect(() => excludeAssignedGiftCards(source, state)).toThrow('No unassigned cards');
  });
  it('preserves existing cloud claims and makes repeated filtered imports idempotent', async () => {
    const source = inventory(); const filtered = excludeAssignedGiftCards(source, sourceState(source));
    const store = new CloudGiftStore(new Objects());
    await importGiftInventory(store, { ...filtered.inventory, cards: [filtered.inventory.cards[0]] });
    await store.update(state => { state.assignments[owner] = { cardId: filtered.inventory.cards[0].id, assignedAt: 123, networkHash: 'd'.repeat(64) }; });
    const assigned = (await store.read()).assignments;
    expect(await importUnassignedGiftInventory(store, filtered.inventory, filtered.excluded)).toEqual({ added: 1, total: 2 });
    expect(await importUnassignedGiftInventory(store, filtered.inventory, filtered.excluded)).toEqual({ added: 0, total: 2 });
    expect((await store.read()).assignments).toEqual(assigned);
    expect((await store.read()).cards.some(card => card.id === source.cards[0].id)).toBe(false);
  });
  it('refuses a locally assigned card already present in the destination without changing existing claims', async () => {
    const source = inventory(); const filtered = excludeAssignedGiftCards(source, sourceState(source));
    const store = new CloudGiftStore(new Objects()); await importGiftInventory(store, source);
    await store.update(state => { state.assignments[owner] = { cardId: source.cards[2].id, assignedAt: 123, networkHash: 'd'.repeat(64) }; });
    const before = await store.read();
    await expect(importUnassignedGiftInventory(store, filtered.inventory, filtered.excluded)).rejects.toThrow('already contains a locally assigned card');
    expect(await store.read()).toEqual(before);
  });
  it('requires the exclusion option for a batch already present in default local runtime state', () => {
    const source = inventory(); const state = sourceState(source);
    expect(() => assertNoLocalGiftOverlap(source, state)).toThrow('--exclude-assigned-state');
    const renamedBatch = { ...source, batchId: '2'.repeat(32) };
    expect(() => assertNoLocalGiftOverlap(renamedBatch, state)).toThrow('--exclude-assigned-state');
    expect(() => assertNoLocalGiftOverlap(source, { ...state, batches: [], cards: [], assignments: {} })).not.toThrow();
  });
  it('exports a private repeatable candidate without changing source records or contacting cloud services', async () => {
    const f = privateFiles(); const before = fs.readFileSync(f.state);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network call'); });
    const args = ['--file', f.input, '--exclude-assigned-state', f.state, '--export-unassigned', f.output];
    await runGiftImport(args); const first = fs.readFileSync(f.output); await runGiftImport(args);
    expect(fs.readFileSync(f.output)).toEqual(first); expect(fs.readFileSync(f.state)).toEqual(before);
    expect(JSON.parse(first.toString()).cards).toHaveLength(2); expect(fs.statSync(f.output).mode & 0o077).toBe(0);
    expect(fs.existsSync(`${f.state}.lock`)).toBe(false); expect(network).not.toHaveBeenCalled();
    const text = output.mock.calls.map(call => String(call[0])).join('');
    expect(text).toContain('"exported":2,"excluded":1');
    for (const card of f.source.cards) expect(text).not.toContain(card.walletUri);
  });
  it('fails closed if the source is missing, public, or locked by another process', async () => {
    const f = privateFiles();
    const args = ['--file', f.input, '--exclude-assigned-state', f.state, '--export-unassigned', f.output];
    fs.writeFileSync(`${f.state}.lock`, 'other-process', { mode: 0o600 });
    await expect(runGiftImport(args)).rejects.toThrow('inventory is busy');
    expect(fs.readFileSync(`${f.state}.lock`, 'utf8')).toBe('other-process');
    fs.unlinkSync(`${f.state}.lock`); fs.chmodSync(f.state, 0o644);
    await expect(runGiftImport(args)).rejects.toThrow('chmod 600'); fs.unlinkSync(f.state);
    await expect(runGiftImport(args)).rejects.toThrow('must exist'); expect(fs.existsSync(f.output)).toBe(false);
  });
  it('refuses to overwrite the original inventory or runtime state during export', async () => {
    const f = privateFiles();
    for (const output of [f.input, f.state]) {
      await expect(runGiftImport(['--file', f.input, '--exclude-assigned-state', f.state, '--export-unassigned', output])).rejects.toThrow('must not overwrite');
    }
  });
  it('supports the same filtered merge into a separate local runtime for offline review', async () => {
    const f = privateFiles(); const destination = path.join(f.folder, 'review-state.json');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runGiftImport(['--file', f.input, '--exclude-assigned-state', f.state, '--state', destination]);
    const result = await new LocalGiftStore(destination).read();
    expect(result.cards.map(card => card.id)).toEqual(f.source.cards.slice(1).map(card => card.id)); expect(result.assignments).toEqual({});
  });
});


describe('permanent gift inventory lifecycle protection', () => {
  it('allows no lifecycle policy or deletion restricted to unrelated jobs', () => {
    expect(() => assertGiftLifecycleSafe(undefined)).not.toThrow();
    expect(() => assertGiftLifecycleSafe({ rule: [] })).not.toThrow();
    expect(() => assertGiftLifecycleSafe({ rule: [{ action: { type: 'Delete' }, condition: { age: 1, matchesPrefix: ['jobs/'] } }] })).not.toThrow();
  });
  it('rejects unrestricted deletion and any prefix or suffix matching permanent gift state', () => {
    for (const condition of [{ age: 1 }, { age: 1, matchesPrefix: ['jobs/', 'gifts/'] },
      { isLive: false, numNewerVersions: 2 }, { matchesSuffix: ['.json'] }, { matchesPrefix: [] }]) {
      expect(() => assertGiftLifecycleSafe({ rule: [{ action: { type: 'Delete' }, condition }] })).toThrow('could delete permanent gift inventory');
    }
  });
  it('requires both prefix and suffix to match and rejects unknown lifecycle fields', () => {
    expect(() => assertGiftLifecycleSafe({ rule: [{ action: { type: 'Delete' }, condition: { matchesPrefix: ['jobs/'], matchesSuffix: ['.json'] } }] })).not.toThrow();
    expect(() => assertGiftLifecycleSafe({ rule: [{ action: { type: 'Delete' }, condition: { matchesPrefix: ['jobs/'], unknownCondition: true } }] })).toThrow('not recognized');
    expect(() => assertGiftLifecycleSafe({ rule: [{ action: { type: 'UnknownAction' }, condition: { matchesPrefix: ['jobs/'] } }] })).toThrow('not recognized');
  });
});
