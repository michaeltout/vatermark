import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { GenericRequest, SpendableKeyDetailsOrdinalVDXFObject } from 'verus-typescript-primitives';
import type { AppConfig } from './config.js';
import { HttpError } from './errors.js';
import { StoreConflict, type PrivateObjects } from './cloud-store.js';

export const GIFT_STATE_OBJECT = 'gifts/state-v1.json';
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{26,40}$/;

export interface GiftCard {
  id: string; identityName: string; identityId: string; address: string; walletUri: string;
  fundingTxid: string; registrationTxid: string; amount: '1.00000000';
}
export interface GiftInventory {
  format: 'vatermark-gift-inventory'; version: 1; network: 'VRSCTEST'; parent: 'vrsctest@';
  batchId: string; createdAt: string; cards: GiftCard[];
}
// Legacy network hashes remain readable, but new assignments store no network data.
interface Assignment { cardId: string; assignedAt: number; networkHash?: string }
export interface GiftState {
  format: 'vatermark-gift-state'; version: 1; salt: string; batches: string[];
  cards: GiftCard[]; assignments: Record<string, Assignment>;
}
export interface GiftStore {
  read(): Promise<GiftState>;
  update<T>(change: (state: GiftState) => T): Promise<T>;
}
export interface GiftConfig {
  enabled: boolean;
  stateFile: string;
}
function unavailable() { return new HttpError(503, 'GIFTS_UNAVAILABLE', 'Test IDs are not available right now.'); }
function invalidInventory(): never { throw new Error('Invalid gift inventory. No gift data was imported.'); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
export function loadGiftConfig(env: NodeJS.ProcessEnv, app: AppConfig): GiftConfig {
  if (env.GIFTS_ENABLED && !['true', 'false'].includes(env.GIFTS_ENABLED)) throw new Error('GIFTS_ENABLED must be true or false.');
  return { enabled: env.GIFTS_ENABLED === 'true',
    stateFile: path.resolve(app.root, env.GIFTS_STATE_FILE || path.join(app.dataDir, 'gifts', 'state.json')) };
}
function checkCard(value: unknown, parseWallet = false): GiftCard {
  if (!record(value) || !keys(value, ['id', 'identityName', 'identityId', 'address', 'walletUri', 'fundingTxid', 'registrationTxid', 'amount'])
    || typeof value.id !== 'string' || !HEX32.test(value.id)
    || typeof value.identityName !== 'string' || !/^[a-z]{4,48}\.vrsctest@$/.test(value.identityName)
    || typeof value.identityId !== 'string' || !value.identityId.startsWith('i') || !BASE58.test(value.identityId)
    || typeof value.address !== 'string' || !value.address.startsWith('R') || !BASE58.test(value.address)
    || typeof value.walletUri !== 'string' || value.walletUri.length > 8192
    || typeof value.fundingTxid !== 'string' || !HEX64.test(value.fundingTxid)
    || typeof value.registrationTxid !== 'string' || !HEX64.test(value.registrationTxid) || value.amount !== '1.00000000') invalidInventory();
  if (parseWallet) {
    try {
      const request = GenericRequest.fromWalletDeeplinkUri(value.walletUri);
      if (!request.isTestnet() || !request.flags.eq(GenericRequest.FLAG_IS_TESTNET) || !request.isValidVersion() || request.details.length !== 1 || request.responseURIs?.length
        || !(request.details[0] instanceof SpendableKeyDetailsOrdinalVDXFObject)
        || request.details[0].data.isEncrypted() || !request.details[0].data.isBIP39()
        || !request.details[0].data.isValid() || request.details[0].data.data.length !== 32
        || !request.details[0].data.flags.isZero() || !request.details[0].data.encryptionFormat.isZero() || request.toWalletDeeplinkUri() !== value.walletUri) invalidInventory();
    } catch { invalidInventory(); }
  }
  return value as unknown as GiftCard;
}
export function validateGiftInventory(value: unknown): GiftInventory {
  if (!record(value) || !keys(value, ['format', 'version', 'network', 'parent', 'batchId', 'createdAt', 'cards'])
    || value.format !== 'vatermark-gift-inventory' || value.version !== 1 || value.network !== 'VRSCTEST'
    || value.parent !== 'vrsctest@' || typeof value.batchId !== 'string' || !HEX32.test(value.batchId)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 1000) invalidInventory();
  const cards = value.cards.map(card => checkCard(card, true));
  for (const key of ['id', 'identityName', 'identityId', 'address', 'walletUri'] as const) {
    if (new Set(cards.map(card => card[key])).size !== cards.length) invalidInventory();
  }
  return { ...value, cards } as unknown as GiftInventory;
}
function blankState(): GiftState {
  return { format: 'vatermark-gift-state', version: 1, salt: randomBytes(32).toString('hex'), batches: [], cards: [], assignments: {} };
}
function parseState(data: Buffer): GiftState {
  try {
    if (data.length > 32 * 1024 * 1024) throw new Error();
    const state = JSON.parse(data.toString('utf8')) as GiftState;
    if (state.format !== 'vatermark-gift-state' || state.version !== 1 || !HEX64.test(state.salt)
      || !Array.isArray(state.cards) || state.cards.length > 10_000 || !Array.isArray(state.batches)
      || !state.batches.every(id => HEX32.test(id)) || !record(state.assignments)) throw new Error();
    state.cards.forEach(card => checkCard(card));
    const ids = new Set(state.cards.map(card => card.id));
    const assigned = new Set<string>();
    if (ids.size !== state.cards.length) throw new Error();
    for (const [owner, item] of Object.entries(state.assignments)) {
      if (!HEX64.test(owner) || !item || !ids.has(item.cardId) || assigned.has(item.cardId)
        || (item.networkHash !== undefined && !HEX64.test(item.networkHash)) || !Number.isSafeInteger(item.assignedAt) || item.assignedAt <= 0) throw new Error();
      assigned.add(item.cardId);
    }
    return state;
  } catch { throw unavailable(); }
}
/** Merge is offline/admin-only: there is deliberately no HTTP inventory endpoint. */
export async function importGiftInventory(store: GiftStore, value: unknown) {
  const inventory = validateGiftInventory(value);
  return store.update(state => {
    let added = 0;
    for (const card of inventory.cards) {
      const existing = state.cards.find(item => item.id === card.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(card)) invalidInventory();
        continue;
      }
      if (state.cards.some(item => ['identityName', 'identityId', 'address', 'walletUri'].some(key => item[key as keyof GiftCard] === card[key as keyof GiftCard]))) invalidInventory();
      if (state.cards.length >= 10_000) throw new Error('Gift inventory capacity reached.');
      state.cards.push(card); added++;
    }
    if (!state.batches.includes(inventory.batchId)) state.batches.push(inventory.batchId);
    return { added, total: state.cards.length };
  });
}

/** A short, synchronous transaction under a cross-process exclusive lock. */
export class LocalGiftStore implements GiftStore {
  constructor(readonly filename: string) { fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); }
  async read(): Promise<GiftState> {
    try { return parseState(fs.readFileSync(this.filename)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return blankState(); throw error; }
  }
  async update<T>(change: (state: GiftState) => T): Promise<T> {
    const lock = `${this.filename}.lock`;
    let descriptor: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { descriptor = fs.openSync(lock, 'wx', 0o600); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await pause(20 + Math.random() * 20); }
    }
    // Never steal a lock by age: a paused writer could still own it. After an
    // interrupted process, an operator can remove the lock once it has stopped.
    if (descriptor === undefined) throw new HttpError(503, 'GIFTS_BUSY', 'Gift cards are busy. Please try again shortly.');
    const temp = `${this.filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); fs.fsyncSync(descriptor);
      const state = await this.read();
      const result = change(state);
      const data = Buffer.from(JSON.stringify(state));
      parseState(data);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.filename);
      const dir = fs.openSync(path.dirname(this.filename), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return result;
    } finally {
      fs.closeSync(descriptor); fs.rmSync(temp, { force: true }); fs.rmSync(lock, { force: true });
    }
  }
}
/** One private object and a generation precondition keep claims atomic across instances. */
export class CloudGiftStore implements GiftStore {
  constructor(private objects: Pick<PrivateObjects, 'read' | 'write'>, private objectName = GIFT_STATE_OBJECT) {}
  async read(): Promise<GiftState> { const stored = await this.objects.read(this.objectName); return stored ? parseState(stored.data) : blankState(); }
  async update<T>(change: (state: GiftState) => T): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const stored = await this.objects.read(this.objectName);
      const state = stored ? parseState(stored.data) : blankState();
      const result = change(state);
      const data = Buffer.from(JSON.stringify(state)); parseState(data);
      try { await this.objects.write(this.objectName, data, stored?.revision ?? 0); return result; }
      catch (error) { if (!(error instanceof StoreConflict)) throw error; await pause(5 + Math.random() * 15); }
    }
    throw new HttpError(503, 'GIFTS_BUSY', 'Gift cards are busy. Please try again shortly.');
  }
}

export interface GiftView {
  id: string; identityName: string; identityId: string; amount: '1.00000000'; network: 'VRSCTEST';
  walletUri: string; qrText: string; assignedAt: string;
}
function view(state: GiftState, assignment: Assignment): GiftView {
  const card = state.cards.find(item => item.id === assignment.cardId)!;
  return { id: card.id, identityName: card.identityName, identityId: card.identityId, amount: card.amount,
    network: 'VRSCTEST', walletUri: card.walletUri, qrText: card.walletUri, assignedAt: new Date(assignment.assignedAt).toISOString() };
}
function checkOwner(owner: string) { if (!HEX64.test(owner)) throw new HttpError(403, 'SESSION_REQUIRED', 'Open Vatermark before requesting a gift card.'); }
export class GiftService {
  private inFlight = new Map<string, Promise<GiftView>>();
  constructor(readonly config: GiftConfig, readonly store: GiftStore, private now = Date.now) {}
  publicConfig() { return { enabled: this.config.enabled }; }
  async current(owner: string): Promise<GiftView | undefined> {
    if (!this.config.enabled) throw unavailable(); checkOwner(owner);
    const state = await this.store.read();
    return state.assignments[owner] ? view(state, state.assignments[owner]) : undefined;
  }
  async claim(owner: string): Promise<GiftView> {
    if (!this.config.enabled) throw unavailable(); checkOwner(owner);
    const existing = await this.current(owner);
    if (existing) return existing;
    const pending = this.inFlight.get(owner);
    if (pending) return pending;
    const task = (async () => {
      return this.store.update(state => {
        const assigned = state.assignments[owner];
        if (assigned) return view(state, assigned);
        const now = this.now();
        const assignments = Object.values(state.assignments);
        const used = new Set(assignments.map(item => item.cardId));
        const card = state.cards.find(item => !used.has(item.id));
        if (!card) throw new HttpError(410, 'GIFTS_EMPTY', 'All test IDs have been given out. Please check back later.');
        const assignment = { cardId: card.id, assignedAt: now };
        state.assignments[owner] = assignment;
        return view(state, assignment);
      });
    })();
    this.inFlight.set(owner, task);
    try { return await task; } finally { this.inFlight.delete(owner); }
  }
}
