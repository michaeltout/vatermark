import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AnchorRecord } from './anchor.js';
import { POLICY_HASH, POLICY_ID, POLICY_TEXT } from './policy.js';
import { CASE_NUMBER, CASE_STATEMENT, IDENTITY_ADDRESS } from './verus.js';

/**
 * Vatermark Cases: the clinical-workflow event protocol (CASES.md).
 * A case is one workflow against one artifact manifest. Every transition is a
 * signed event over a canonical statement; the event log is the source of
 * truth and the status is a projection of it. This module holds the pure
 * protocol (statements, projection, hashes), the private store, the public
 * view and the export package. Wallet interaction lives in routes.ts.
 */
export const SCHEMA = 'clinical-workflow-event/v1';
export const EXPORT_SCHEMA = 'clinical-workflow-export/v1';
export const ZERO_HASH = '0'.repeat(64);
/** A wallet's node may trail the server's: a signature may sit this many blocks before the issuing block. */
export const BLOCK_TOLERANCE = 5;
export const EVENT_TYPES = ['CASE_CREATED', 'TASK_ASSIGNED', 'TASK_ACCEPTED', 'TASK_REJECTED', 'TASK_WITHDRAWN', 'REVIEW_COMPLETED', 'CASE_CLOSED', 'CASE_REOPENED'] as const;
export type EventType = typeof EVENT_TYPES[number];
/** Fixed per type and part of the protocol: the signer reads in plain language what they attest to. */
export const MEANINGS: Record<EventType, string> = {
  CASE_CREATED: 'I open this case and take ownership of its workflow.',
  TASK_ASSIGNED: 'I ask the named identity to take responsibility for reviewing this artifact.',
  TASK_ACCEPTED: 'I accept responsibility for reviewing this artifact under the named policy.',
  TASK_REJECTED: 'I decline the requested review responsibility.',
  TASK_WITHDRAWN: 'I withdraw the review request I made to the named identity.',
  REVIEW_COMPLETED: 'I attest that I completed the assigned review of this artifact under the named policy.',
  CASE_CLOSED: 'I close this case.',
  CASE_REOPENED: 'I reopen this case.',
};
const WITH_RECIPIENT = new Set<EventType>(['TASK_ASSIGNED', 'TASK_WITHDRAWN']);
const TASK_SCOPED = new Set<EventType>(['TASK_ASSIGNED', 'TASK_ACCEPTED', 'TASK_REJECTED', 'TASK_WITHDRAWN', 'REVIEW_COMPLETED']);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface IdentityRef { id: string; name: string }
export interface ArtifactManifest {
  digestAlgorithm: 'sha-256'; digest: string; bytes: number; mediaType: string; width?: number; height?: number; manifestVersion: 1;
}
export interface BlockRef { height: number; hash: string }
export interface StatementFields {
  type: EventType; case: string; seq: number; prev: string; artifact: string;
  actor: string; actorName: string; to?: string; toName?: string; task?: string; deadline?: string;
  policy: string; policyHash: string; block: BlockRef; at: string; nonce: string;
}
export interface EventSignature { native: string; identityId: string; name: string; height: number; systemId: string }
/** How the signer's keys relate to the signing-height record, as the server saw it when accepting the event. */
export type KeyState = 'unchanged' | 'rotated' | 'revoked' | 'recovered';
export interface IdentityEvidence { atHeight: unknown; current: unknown; keyState: KeyState; currentActive: boolean }
export interface CaseEvent {
  seq: number; type: EventType; statement: string; fields: StatementFields; hash: string; prev: string;
  signature: EventSignature; acceptedAt: number; anchor: AnchorRecord; identity: IdentityEvidence;
}
export interface PendingStep {
  id: string; type: EventType; statement: string; fields: StatementFields; expectedSigner: IdentityRef; to?: IdentityRef;
  proposer: string; createdAt: number; expiresAt: number; requestIdHex: string; requestHex: string; walletUri: string;
}
export interface CaseRecord {
  number: string; createdAt: number; updatedAt: number;
  /** Session hash of the creator (the browser that uploaded the artifact). */
  creator: string;
  policy: { id: string; hash: string; text: string };
  artifact: ArtifactManifest; events: CaseEvent[]; pending?: PendingStep;
  /** Display names learned for identities from chain lookups and signatures. */
  names: Record<string, string>;
  /** Accepted attestation callbacks (id -> body digest) so an exact wallet retry is acknowledged idempotently. */
  attestations: Record<string, string>;
}
export type CaseStatus = 'draft' | 'open' | 'assigned' | 'rejected' | 'accepted' | 'completed' | 'closed' | 'reopened';
export interface TaskRef { id: string; to: IdentityRef; by: IdentityRef; seq: number; deadline?: string; resume: CaseStatus }
export interface Projection {
  status: CaseStatus; owner?: IdentityRef; assignee?: IdentityRef; responsible?: IdentityRef;
  openTask?: TaskRef; acceptedTask?: TaskRef; completedTask?: TaskRef;
}
/** A transition the state machine currently allows, with the identities entitled to sign it. */
export interface AllowedStep { type: EventType; signers: IdentityRef[] | 'any' }

// ---------------------------------------------------------------- numbers, times and helpers
export function newCaseNumber(): string {
  let value = BigInt(`0x${randomBytes(8).toString('hex')}`) & ((1n << 60n) - 1n);
  let chars = '';
  for (let i = 0; i < 12; i++) { chars = CROCKFORD[Number(value & 31n)] + chars; value >>= 5n; }
  return `VC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
/** Accept typed variants (lower case, missing dashes, Crockford look-alikes) and return the canonical form. */
export function normalizeCaseNumber(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > 40) return undefined;
  const text = input.toUpperCase().replace(/[\s_-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!text.startsWith('VC')) return undefined;
  const body = text.slice(2);
  if (body.length !== 12 || [...body].some(c => !CROCKFORD.includes(c))) return undefined;
  const number = `VC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
  return CASE_NUMBER.test(number) ? number : undefined;
}
/** Canonical UTC time with second precision, as it appears in statements. */
export function isoTime(ms: number): string { return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z'); }
export function parseIsoTime(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && isoTime(ms) === text ? ms : undefined;
}
export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function nativeSignatureBytes(native: string): Buffer {
  const bytes = Buffer.from(native, 'base64');
  if (bytes.length !== 73 || bytes.toString('base64') !== native) throw new Error('Unexpected native signature encoding');
  return bytes;
}
/** event_hash = SHA256(UTF8(statement) || 0x0A || native_signature_bytes). */
export function eventHash(statement: string, native: string): string {
  return createHash('sha256').update(Buffer.from(statement, 'utf8')).update(Buffer.from([0x0a])).update(nativeSignatureBytes(native)).digest('hex');
}
/** A VerusID name as shown to signers: the chain's base name with the @ suffix. */
export function displayName(name: string | undefined, id: string): string {
  const base = (name ?? '').trim();
  if (!base || base === id) return id;
  return base.endsWith('@') ? base : `${base}@`;
}

// ---------------------------------------------------------------- statements
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[^\n:]{1,100}$/;
function validateFields(f: StatementFields): void {
  const fail = (message: string) => { throw new Error(`Invalid statement: ${message}`); };
  if (!EVENT_TYPES.includes(f.type)) fail('unknown type');
  if (!CASE_NUMBER.test(f.case)) fail('case number');
  if (!Number.isInteger(f.seq) || f.seq < 1 || f.seq > 999_999_999) fail('sequence');
  if (!HEX64.test(f.prev) || (f.seq === 1) !== (f.prev === ZERO_HASH)) fail('previous hash');
  if (!HEX64.test(f.artifact)) fail('artifact digest');
  if (!IDENTITY_ADDRESS.test(f.actor) || !NAME.test(f.actorName)) fail('actor');
  if (WITH_RECIPIENT.has(f.type) ? !(f.to && IDENTITY_ADDRESS.test(f.to) && f.toName && NAME.test(f.toName)) : (f.to !== undefined || f.toName !== undefined)) fail('recipient');
  if (TASK_SCOPED.has(f.type) ? !(f.task && /^[0-9a-f]{16}$/.test(f.task)) : f.task !== undefined) fail('task');
  if (f.deadline !== undefined && (f.type !== 'TASK_ASSIGNED' || parseIsoTime(f.deadline) === undefined)) fail('deadline');
  if (!/^[a-z0-9.-]{1,64}$/.test(f.policy) || !HEX64.test(f.policyHash)) fail('policy');
  if (!Number.isInteger(f.block.height) || f.block.height < 1 || f.block.height > 0xffff_ffff || !HEX64.test(f.block.hash)) fail('block');
  if (parseIsoTime(f.at) === undefined) fail('time');
  if (!/^[0-9a-f]{40}$/.test(f.nonce)) fail('nonce');
}
/** The exact UTF-8 text the signer sees: LF-joined, no trailing newline, canonical values. */
export function buildStatement(f: StatementFields): string {
  validateFields(f);
  const lines = [SCHEMA, MEANINGS[f.type], `type:${f.type}`, `case:${f.case}`, `seq:${f.seq}`, `prev:${f.prev}`, `artifact:sha-256:${f.artifact}`,
    `actor:${f.actor}`, `actor-name:${f.actorName}`];
  if (f.to) lines.push(`to:${f.to}`, `to-name:${f.toName}`);
  if (f.task) lines.push(`task:${f.task}`);
  if (f.deadline !== undefined) lines.push(`deadline:${f.deadline}`);
  lines.push(`policy:${f.policy}`, `policy-hash:${f.policyHash}`, `block:${f.block.height}:${f.block.hash}`, `at:${f.at}`, `nonce:${f.nonce}`);
  return lines.join('\n');
}
/** Strict inverse of buildStatement: anything that does not round-trip byte for byte is rejected. */
export function parseStatement(text: string): StatementFields | undefined {
  if (typeof text !== 'string' || text.length > 4096 || !CASE_STATEMENT.test(text)) return undefined;
  const lines = text.split('\n');
  const values = new Map<string, string>();
  for (const line of lines.slice(2)) {
    const index = line.indexOf(':');
    if (index <= 0 || values.has(line.slice(0, index))) return undefined;
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  const type = values.get('type') as EventType;
  if (!EVENT_TYPES.includes(type) || lines[1] !== MEANINGS[type]) return undefined;
  const block = /^([1-9][0-9]{0,9}):([0-9a-f]{64})$/.exec(values.get('block') ?? '');
  if (!block) return undefined;
  const fields: StatementFields = {
    type, case: values.get('case') ?? '', seq: Number(values.get('seq')), prev: values.get('prev') ?? '',
    artifact: (values.get('artifact') ?? '').replace(/^sha-256:/, ''), actor: values.get('actor') ?? '', actorName: values.get('actor-name') ?? '',
    to: values.get('to'), toName: values.get('to-name'), task: values.get('task'), deadline: values.get('deadline'),
    policy: values.get('policy') ?? '', policyHash: values.get('policy-hash') ?? '', block: { height: Number(block[1]), hash: block[2] },
    at: values.get('at') ?? '', nonce: values.get('nonce') ?? '',
  };
  try { return buildStatement(fields) === text ? fields : undefined; } catch { return undefined; }
}

// ---------------------------------------------------------------- projection (state machine)
const ASSIGNABLE: CaseStatus[] = ['open', 'rejected', 'accepted', 'completed', 'reopened', 'assigned'];
const CLOSABLE: CaseStatus[] = ['open', 'rejected', 'completed', 'reopened'];
export function project(events: readonly CaseEvent[], names: Record<string, string> = {}): Projection {
  const ref = (id: string, name?: string): IdentityRef => ({ id, name: name || names[id] || id });
  let p: Projection = { status: 'draft' };
  for (const e of events) {
    const actor = ref(e.signature.identityId, e.fields.actorName);
    switch (e.type) {
      case 'CASE_CREATED': p = { status: 'open', owner: actor }; break;
      case 'TASK_ASSIGNED': {
        // Where the case returns if this request is declined or withdrawn.
        const resume: CaseStatus = p.status === 'assigned' && p.openTask ? p.openTask.resume : p.status === 'open' || p.status === 'reopened' ? 'rejected' : p.status;
        const to = ref(e.fields.to!, e.fields.toName);
        p = { ...p, status: 'assigned', assignee: to, openTask: { id: e.fields.task!, to, by: actor, seq: e.seq, deadline: e.fields.deadline, resume } };
        break;
      }
      case 'TASK_ACCEPTED':
        p = { ...p, status: 'accepted', responsible: actor, acceptedTask: p.openTask, openTask: undefined, assignee: undefined, completedTask: undefined };
        break;
      case 'TASK_REJECTED': case 'TASK_WITHDRAWN':
        p = { ...p, status: p.openTask?.resume ?? 'rejected', openTask: undefined, assignee: undefined };
        break;
      case 'REVIEW_COMPLETED':
        p = { ...p, status: 'completed', completedTask: p.acceptedTask, acceptedTask: undefined };
        break;
      case 'CASE_CLOSED': p = { ...p, status: 'closed', openTask: undefined, assignee: undefined }; break;
      case 'CASE_REOPENED': p = { ...p, status: 'reopened' }; break;
    }
  }
  return p;
}
/** What may happen next and who may sign it. The server offers only these statements; the verifier re-checks them. */
export function allowedSteps(p: Projection): AllowedStep[] {
  if (p.status === 'draft') return [{ type: 'CASE_CREATED', signers: 'any' }];
  const steps: AllowedStep[] = [];
  const owner = p.owner!;
  const distinct = (list: IdentityRef[]) => list.filter((who, index) => list.findIndex(other => other.id === who.id) === index);
  if (ASSIGNABLE.includes(p.status)) {
    // The owner may always (re)assign; whoever currently holds responsibility may hand the task on.
    const holder = p.status === 'accepted' || p.status === 'completed' || p.status === 'assigned' ? p.responsible : undefined;
    steps.push({ type: 'TASK_ASSIGNED', signers: distinct([owner, ...(holder ? [holder] : [])]) });
  }
  if (p.status === 'assigned' && p.openTask) {
    steps.push({ type: 'TASK_ACCEPTED', signers: [p.openTask.to] }, { type: 'TASK_REJECTED', signers: [p.openTask.to] }, { type: 'TASK_WITHDRAWN', signers: [owner] });
  }
  if (p.status === 'accepted' && p.responsible) steps.push({ type: 'REVIEW_COMPLETED', signers: [p.responsible] });
  if (CLOSABLE.includes(p.status)) steps.push({ type: 'CASE_CLOSED', signers: [owner] });
  if (p.status === 'closed') steps.push({ type: 'CASE_REOPENED', signers: [owner] });
  return steps;
}
/** Is `signerId` entitled to sign `type` in the projected state? Checked when a step is proposed and again when a signature arrives. */
export function entitled(p: Projection, type: EventType, signerId: string): boolean {
  const step = allowedSteps(p).find(s => s.type === type);
  return !!step && (step.signers === 'any' || step.signers.some(who => who.id === signerId));
}

// ---------------------------------------------------------------- building the next statement
export interface StepRequest { type: EventType; actor?: IdentityRef; to?: IdentityRef; deadline?: number; block: BlockRef; nonce: string; now?: number }
/** Fields for the next event, validated against the accepted history. Throws a descriptive Error when the transition is not allowed. */
export function nextFields(record: CaseRecord, request: StepRequest): { fields: StatementFields; expectedSigner: IdentityRef } {
  const p = project(record.events, record.names);
  const step = allowedSteps(p).find(s => s.type === request.type);
  if (!step) throw new Error(`${request.type.replace(/_/g, ' ').toLowerCase()} is not possible while the case is ${p.status}.`);
  let expectedSigner: IdentityRef;
  if (step.signers === 'any') {
    if (!request.actor) throw new Error('Name the identity that will sign.');
    expectedSigner = request.actor;
  } else {
    const chosen = request.actor ? step.signers.find(who => who.id === request.actor!.id) : step.signers.length === 1 ? step.signers[0] : undefined;
    if (!chosen) throw new Error(step.signers.length > 1 && !request.actor ? 'Choose which entitled identity will sign this step.' : 'That identity may not sign this step.');
    expectedSigner = chosen;
  }
  const last = record.events.at(-1);
  const fields: StatementFields = {
    type: request.type, case: record.number, seq: record.events.length + 1, prev: last ? last.hash : ZERO_HASH, artifact: record.artifact.digest,
    actor: expectedSigner.id, actorName: displayName(expectedSigner.name, expectedSigner.id),
    policy: record.policy.id, policyHash: record.policy.hash, block: request.block, at: isoTime(request.now ?? Date.now()), nonce: request.nonce,
  };
  if (request.type === 'TASK_ASSIGNED') {
    if (!request.to) throw new Error('Name the identity that should take responsibility.');
    fields.to = request.to.id; fields.toName = displayName(request.to.name, request.to.id);
    fields.task = randomBytes(8).toString('hex');
    if (request.deadline !== undefined) fields.deadline = isoTime(request.deadline);
  } else if (request.type === 'TASK_WITHDRAWN') {
    const task = p.openTask!;
    fields.to = task.to.id; fields.toName = displayName(task.to.name, task.to.id); fields.task = task.id;
  } else if (request.type === 'TASK_ACCEPTED' || request.type === 'TASK_REJECTED') fields.task = p.openTask!.id;
  else if (request.type === 'REVIEW_COMPLETED') fields.task = p.acceptedTask!.id;
  validateFields(fields);
  return { fields, expectedSigner };
}

// ---------------------------------------------------------------- store
export class CaseStore {
  readonly dir: string;
  private byDigest = new Map<string, Set<string>>();
  private byAttestation = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'cases');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const record of this.all()) this.index(record);
  }
  private file(number: string) {
    if (!CASE_NUMBER.test(number)) throw new Error('Invalid case number');
    return path.join(this.dir, `${number}.json`);
  }
  private index(record: CaseRecord) {
    let set = this.byDigest.get(record.artifact.digest);
    if (!set) { set = new Set(); this.byDigest.set(record.artifact.digest, set); }
    set.add(record.number);
    if (record.pending) this.byAttestation.set(record.pending.id, record.number);
    for (const id of Object.keys(record.attestations)) this.byAttestation.set(id, record.number);
  }
  get(number: string): CaseRecord | undefined {
    if (!CASE_NUMBER.test(number)) return undefined;
    try { return JSON.parse(fs.readFileSync(this.file(number), 'utf8')) as CaseRecord; } catch { return undefined; }
  }
  save(record: CaseRecord) {
    record.updatedAt = Date.now();
    const file = this.file(record.number);
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, file);
    this.index(record);
  }
  remove(record: CaseRecord) {
    fs.rmSync(this.file(record.number), { force: true });
    this.byDigest.get(record.artifact.digest)?.delete(record.number);
    if (record.pending) this.byAttestation.delete(record.pending.id);
  }
  all(): CaseRecord[] {
    return fs.readdirSync(this.dir).filter(name => name.endsWith('.json'))
      .map(name => this.get(name.slice(0, -5))).filter((record): record is CaseRecord => !!record);
  }
  create(input: { creator: string; artifact: ArtifactManifest }): CaseRecord {
    for (let attempt = 0; attempt < 8; attempt++) {
      const number = newCaseNumber();
      if (fs.existsSync(this.file(number))) continue;
      const now = Date.now();
      const record: CaseRecord = { number, createdAt: now, updatedAt: now, creator: input.creator,
        policy: { id: POLICY_ID, hash: POLICY_HASH, text: POLICY_TEXT }, artifact: input.artifact, events: [], names: {}, attestations: {} };
      this.save(record);
      return record;
    }
    throw new Error('Could not allocate a case number');
  }
  numbersByDigest(digest: string): string[] { return [...(this.byDigest.get(digest) ?? [])]; }
  numberByAttestation(id: string) { return this.byAttestation.get(id); }
  /** Run a read-modify-write cycle on one case; concurrent cycles for the same case wait their turn. */
  async withCase<T>(number: string, work: (record: CaseRecord | undefined) => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(number) ?? Promise.resolve();
    const run = previous.then(() => work(this.get(number)));
    const settled = run.then(() => undefined, () => undefined);
    this.queues.set(number, settled);
    try { return await run; }
    finally { if (this.queues.get(number) === settled) this.queues.delete(number); }
  }
}

// ---------------------------------------------------------------- views
export function expireStep(record: CaseRecord, now = Date.now()): boolean {
  if (!record.pending || record.pending.expiresAt > now) return false;
  record.pending = undefined;
  return true;
}
export const headHash = (record: CaseRecord) => record.events.at(-1)?.hash ?? ZERO_HASH;
export interface ViewOptions { viewer?: string; related?: string[] }
export function caseView(record: CaseRecord, options: ViewOptions = {}) {
  const p = project(record.events, record.names);
  const pending = record.pending;
  const name = (id: string) => record.names[id] || id;
  return {
    number: record.number, status: p.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    policy: { id: record.policy.id, hash: record.policy.hash, text: record.policy.text },
    artifact: record.artifact, headHash: headHash(record),
    owner: p.owner, assignee: p.assignee, responsible: p.responsible,
    openTask: p.openTask ? { id: p.openTask.id, to: p.openTask.to, by: p.openTask.by, deadline: p.openTask.deadline, since: record.events.find(e => e.type === 'TASK_ASSIGNED' && e.fields.task === p.openTask!.id)?.acceptedAt } : undefined,
    acceptedTask: p.acceptedTask ? { id: p.acceptedTask.id, by: p.responsible } : undefined,
    events: record.events.map(e => ({
      seq: e.seq, type: e.type, at: e.acceptedAt, issuedAt: e.fields.at,
      actor: { id: e.signature.identityId, name: e.fields.actorName },
      to: e.fields.to ? { id: e.fields.to, name: e.fields.toName || name(e.fields.to) } : undefined,
      task: e.fields.task, deadline: e.fields.deadline, hash: e.hash, prev: e.prev,
      signingHeight: e.signature.height, block: e.fields.block, keyState: e.identity.keyState, anchor: e.anchor, statement: e.statement,
    })),
    pending: pending ? { id: pending.id, type: pending.type, statement: pending.statement, expectedSigner: pending.expectedSigner, to: pending.to,
      walletUri: pending.walletUri, expiresAt: pending.expiresAt, issuedAt: pending.fields.at, deadline: pending.fields.deadline,
      proposedHere: !!options.viewer && pending.proposer === options.viewer } : undefined,
    actions: allowedSteps(p),
    isCreator: !!options.viewer && record.creator === options.viewer,
    exportUrl: record.events.length ? `/api/cases/${record.number}/export` : undefined,
    related: (options.related ?? []).filter(number => number !== record.number),
  };
}
export type CaseView = ReturnType<typeof caseView>;

export const EXPORT_ATTESTATION_SCHEMA = 'clinical-workflow-export-attestation/v1';
/** What the service identity signs over an export: the exact log it held for this case at that moment. */
export function exportAttestationStatement(record: CaseRecord, exportedAt: string): string {
  return [EXPORT_ATTESTATION_SCHEMA, `case:${record.number}`, `events:${record.events.length}`, `head:${headHash(record)}`, `at:${exportedAt}`].join('\n');
}
export interface ExportAttestation { statement: string; native: string; identityId: string; name: string; height: number }
/** clinical-workflow-export/v1: everything an independent verifier needs, nothing identifying a patient. */
export function exportPackage(record: CaseRecord, options: { exportedAt?: string; attestation?: ExportAttestation } = {}) {
  const identities: Record<string, { name: string; snapshots: Array<{ height: number; record: unknown }>; current?: unknown }> = {};
  for (const e of record.events) {
    const entry = identities[e.signature.identityId] ??= { name: e.fields.actorName, snapshots: [] };
    entry.snapshots.push({ height: e.signature.height, record: e.identity.atHeight });
    entry.current = e.identity.current;
  }
  return {
    schema: EXPORT_SCHEMA, network: 'VRSCTEST', exportedAt: options.exportedAt ?? isoTime(Date.now()),
    case: { number: record.number, policy: record.policy, artifact: record.artifact },
    events: record.events.map(e => ({ seq: e.seq, type: e.type, statement: e.statement, hash: e.hash, prev: e.prev,
      signature: { ...e.signature }, acceptedAt: e.acceptedAt, anchor: e.anchor })),
    identities,
    attestation: options.attestation,
  };
}
export type ExportPackage = ReturnType<typeof exportPackage>;
