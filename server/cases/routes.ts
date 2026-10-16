import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { HttpError } from '../errors.js';
import { WorkerError, type Worker } from '../worker.js';
import { GENERIC_RESPONSE_QUERY_KEY, VerusError, type DisplayIdentity, type IdentityQuery, type VerusAdapter } from '../verus.js';
import { UnconfiguredAnchorer, pendingAnchor, type Anchorer } from './anchor.js';
import {
  BLOCK_TOLERANCE, CaseStore, EVENT_TYPES, allowedSteps, buildStatement, caseView, eventHash, expireStep, exportAttestationStatement, exportPackage,
  isoTime, nextFields, normalizeCaseNumber, parseIsoTime, project, type ArtifactManifest, type CaseEvent, type CaseRecord, type EventType, type IdentityRef,
} from './protocol.js';
import { CasesVerusAdapter, isCasesAdapter, keyStateOf, type CasesAdapter } from './verus.js';

/**
 * The Cases HTTP API. The app mounts it with one call after its own routes,
 * so every request has already passed the app's session, origin and
 * rate-limit middleware, and the routes reuse the app's upload admission, Rust
 * worker and chain adapter untouched. Clinicians sign every event in Verus
 * Mobile; the server only issues statements, verifies signatures and appends
 * events. See CASES.md for the protocol and the routes.
 */
type VerifyStatus = 'verified' | 'revoked' | 'unmarked' | 'invalid' | 'unsupported' | 'unavailable';
interface Ticket { id: string; owner: string; expiresAt: number; artifact: ArtifactManifest }
interface Inspection extends IdentityQuery { width: number; height: number; profile: number; signatureHex: string }
export interface CaseRouteOptions {
  config: AppConfig; worker: Worker;
  /**
   * The app's chain adapter. A CasesVerusAdapter (or a double with the same
   * methods) is used as it is; the app's plain adapter keeps serving the
   * watermark check of presented copies, and a Cases adapter is created beside it.
   */
  adapter: Pick<VerusAdapter, 'resolveIdentity'>;
  upload: express.RequestHandler; imageAdmission: express.RequestHandler;
  rateLimit(req: Request, scope: string, maximum: number): void;
  signingStatus(): Promise<{ enabled: boolean; reason?: string }>;
  ticketTtlMs?: number; sweepMs?: number; draftTtlMs?: number; anchorer?: Anchorer;
}
export interface CaseRoutes { store: CaseStore; cases: CasesAdapter }

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
/** Media type from the bytes themselves, never from the client; dimensions for PNG/JPEG. File names are never read. */
export function describeArtifact(file: string, bytes: number): ArtifactManifest {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(bytes, 4 * 1024 * 1024));
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const sample = head.subarray(0, read);
    const manifest: ArtifactManifest = { digestAlgorithm: 'sha-256', digest: '', bytes, mediaType: 'application/octet-stream', manifestVersion: 1 };
    if (sample.length >= 24 && sample.subarray(0, 8).equals(PNG) && sample.toString('latin1', 12, 16) === 'IHDR') {
      manifest.mediaType = 'image/png'; manifest.width = sample.readUInt32BE(16); manifest.height = sample.readUInt32BE(20);
    } else if (sample.length >= 4 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
      manifest.mediaType = 'image/jpeg';
      let offset = 2;
      while (offset + 9 < sample.length && sample[offset] === 0xff) {
        const marker = sample[offset + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
        const length = sample.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          manifest.height = sample.readUInt16BE(offset + 5); manifest.width = sample.readUInt16BE(offset + 7); break;
        }
        if (marker === 0xda || length < 2) break;
        offset += 2 + length;
      }
    } else if (sample.length >= 132 && sample.toString('latin1', 128, 132) === 'DICM') manifest.mediaType = 'application/dicom';
    return manifest;
  } finally { fs.closeSync(fd); }
}
async function digestFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
/** Map worker/chain failures to the public verification outcome; undefined for unexpected errors. */
function classifyVerification(error: unknown): VerifyStatus | undefined {
  if (!(error instanceof WorkerError || error instanceof VerusError)) return undefined;
  const code = error.code;
  return code === 'no_watermark' ? 'unmarked'
    : ['unsupported_network', 'unsupported_profile', 'UNSUPPORTED_NETWORK'].includes(code) ? 'unsupported'
      : ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'timeout', 'unavailable', 'invalid_response', 'io_error'].includes(code) ? 'unavailable' : 'invalid';
}
/** Decode the single canonical base64url GenericResponse a wallet redirect carries in its query string. */
function decodeRedirectResponse(originalUrl: string): Buffer {
  const values = new URL(originalUrl, 'http://callback.invalid').searchParams.getAll(GENERIC_RESPONSE_QUERY_KEY);
  const encoded = values[0] || '';
  if (values.length !== 1 || encoded.length > 87_382 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new HttpError(400, 'INVALID_CALLBACK', 'Invalid wallet response encoding.');
  const body = Buffer.from(encoded, 'base64url');
  if (body.toString('base64url') !== encoded) throw new HttpError(400, 'INVALID_CALLBACK', 'Noncanonical wallet response encoding.');
  return body;
}

export function mountCaseRoutes(app: express.Express, options: CaseRouteOptions): CaseRoutes {
  const { config, worker, adapter, upload, imageAdmission, rateLimit, signingStatus } = options;
  const cases: CasesAdapter = isCasesAdapter(adapter) ? adapter : new CasesVerusAdapter(config);
  const records = new CaseStore(config.dataDir);
  const anchorer = options.anchorer ?? new UnconfiguredAnchorer();
  const tickets = new Map<string, Ticket>();
  const locks = new Set<string>();
  const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const present = (record: CaseRecord, res: Response) => caseView(record, { viewer: res.locals.owner, related: records.numbersByDigest(record.artifact.digest) });
  function caseNumber(req: Request): string {
    const value = normalizeCaseNumber(req.params.number);
    if (!value) throw new HttpError(404, 'NOT_FOUND', 'That is not a case number.');
    return value;
  }
  function refresh(record: CaseRecord): CaseRecord {
    if (expireStep(record)) records.save(record);
    return record;
  }
  function chainError(error: unknown): never {
    if (error instanceof VerusError) throw new HttpError(error.code === 'CHAIN_UNAVAILABLE' || error.code === 'SERVICE_UNAVAILABLE' ? 503 : 422, error.code, error.message);
    throw error;
  }
  async function resolve(query: string, role: string): Promise<IdentityRef> {
    if (!query || query.length > 80) throw new HttpError(400, 'INVALID_IDENTITY', `Enter the ${role}’s VerusID, like name@ or an i-address.`);
    let found: { id: string; name: string; active: boolean };
    try { found = await cases.lookupIdentity(query); } catch (error) { chainError(error); }
    if (!found.active) throw new HttpError(422, 'INACTIVE_IDENTITY', `${found.name}@ isn’t an active VRSCTEST identity.`);
    return { id: found.id, name: found.name };
  }
  async function manifestOf(file: Express.Multer.File): Promise<ArtifactManifest> {
    fs.chmodSync(file.path, 0o600);
    const manifest = describeArtifact(file.path, file.size);
    manifest.digest = await digestFile(file.path);
    return manifest;
  }
  /** Issue the next statement as a wallet request. The case must be locked by the caller and signing must be enabled. */
  async function issue(record: CaseRecord, input: { type: EventType; actor?: IdentityRef; to?: IdentityRef; deadline?: number }, proposer: string) {
    const requestIdHex = randomBytes(20).toString('hex');
    const attestationId = randomBytes(16).toString('hex');
    let block: { height: number; hash: string };
    try { block = await cases.chainBlock(); } catch (error) { chainError(error); }
    let built: ReturnType<typeof nextFields>;
    try { built = nextFields(record, { ...input, block, nonce: requestIdHex }); }
    catch (error) { throw new HttpError(409, 'NOT_ALLOWED', (error as Error).message); }
    const statement = buildStatement(built.fields);
    let signed: { requestHex: string; walletUri: string };
    try {
      signed = await cases.createCaseRequest({ message: statement, requestIdHex, responseMode: config.responseMode,
        callbackUrl: `${config.publicOrigin}/api/cases/attestations/${attestationId}/response` });
    } catch (error) { chainError(error); }
    const now = Date.now();
    record.pending = { id: attestationId, type: input.type, statement, fields: built.fields, expectedSigner: built.expectedSigner, to: input.to,
      proposer, createdAt: now, expiresAt: now + config.jobTtlMs, requestIdHex, requestHex: signed.requestHex, walletUri: signed.walletUri };
    record.names[built.expectedSigner.id] = built.expectedSigner.name;
    if (input.to) record.names[input.to.id] = input.to.name;
    records.save(record);
  }

  /**
   * Housekeeping runs on demand, throttled, instead of on a timer: nothing
   * runs in the background and there is nothing to stop on shutdown. Steps and
   * tickets also expire whenever they are read, so this only drops abandoned
   * drafts and advances anchoring once an anchorer is configured.
   */
  let lastSweep = 0;
  async function sweep() {
    const now = Date.now();
    const draftTtl = options.draftTtlMs ?? 24 * 60 * 60_000;
    try {
      for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
      for (const stored of records.all()) {
        const abandoned = !stored.events.length && !stored.pending && stored.createdAt + draftTtl <= now;
        if (!stored.pending && !abandoned && !(anchorer.configured && stored.events.some(e => e.anchor.status === 'pending'))) continue;
        await records.withCase(stored.number, async record => {
          if (!record) return;
          if (!record.events.length && !record.pending && record.createdAt + draftTtl <= now) { records.remove(record); return; }
          let changed = expireStep(record, now);
          if (anchorer.configured) {
            for (const event of record.events) {
              if (event.anchor.status !== 'pending') continue;
              try {
                if (!event.anchor.txid) { const submitted = await anchorer.submit(event.hash); event.anchor = { ...event.anchor, txid: submitted.txid, height: submitted.height, updatedAt: Date.now(), detail: undefined }; }
                else { const status = await anchorer.status(event.anchor.txid); if (status.height) event.anchor = { ...event.anchor, status: 'anchored', height: status.height, confirmations: status.confirmations, updatedAt: Date.now() }; }
                changed = true;
              } catch (error) { event.anchor = { ...event.anchor, status: event.anchor.txid ? 'pending' : 'failed', updatedAt: Date.now(), detail: (error as Error).message }; changed = true; }
            }
          }
          if (changed) records.save(record);
        });
      }
    } catch { /* retried on a later request */ }
  }
  app.use('/api/cases', (_req, _res, next) => {
    const now = Date.now();
    if (now - lastSweep >= (options.sweepMs ?? 60_000)) { lastSweep = now; void sweep(); }
    next();
  });

  app.get('/api/cases/:number', async (req, res) => {
    const number = caseNumber(req);
    res.json(await records.withCase(number, record => {
      if (!record) throw new HttpError(404, 'NOT_FOUND', 'There’s no case with this number.');
      return present(refresh(record), res);
    }));
  });

  // Open a draft case from an image. Only the fingerprint manifest is kept; the file is deleted once digested.
  app.post('/api/cases', imageAdmission, upload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'MISSING_ARTIFACT', 'Choose the image to open the case for.');
    try {
      const record = records.create({ creator: res.locals.owner, artifact: await manifestOf(req.file) });
      res.status(201).json(present(record, res));
    } finally { fs.rmSync(req.file.path, { force: true }); }
  });

  // Present any copy of a file: an exact match finds its cases; otherwise a short-lived ticket lets the holder open one.
  app.post('/api/cases/check', imageAdmission, upload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'MISSING_ARTIFACT', 'Choose the file to check.');
    try {
      const artifact = await manifestOf(req.file);
      const numbers = records.numbersByDigest(artifact.digest);
      let derivative: { status: VerifyStatus; message: string; identity?: DisplayIdentity } | undefined;
      if (!numbers.length && (artifact.mediaType === 'image/png' || artifact.mediaType === 'image/jpeg')) {
        // Not an original: see whether it is a Vatermark distribution copy sealed by someone.
        // A copy without a recoverable seal (unmarked, too small, unsupported) says nothing and reports nothing.
        let inspection: Inspection | undefined;
        try { inspection = await worker.run<Inspection>({ cmd: 'inspect', input: req.file.path }); }
        catch (error) { if (!classifyVerification(error)) throw error; }
        if (inspection) {
          try {
            const authority = await adapter.resolveIdentity(inspection);
            await worker.run({ cmd: 'verify', input: req.file.path, identity: authority.identity });
            derivative = { status: authority.currentActive ? 'verified' : 'revoked', identity: authority.displayIdentity,
              message: authority.currentActive ? 'This copy carries a valid Vatermark signature.' : 'This copy was signed with Vatermark, but that identity has since been revoked.' };
          } catch (error) {
            const status = classifyVerification(error);
            if (!status) throw error;
            derivative = { status, message: error instanceof WorkerError || error instanceof VerusError ? error.message : 'The watermark could not be checked.' };
          }
        }
      }
      let ticket: { id: string; expiresAt: number } | undefined;
      if (!numbers.length) {
        const id = randomBytes(16).toString('hex');
        const expiresAt = Date.now() + (options.ticketTtlMs ?? 15 * 60_000);
        tickets.set(id, { id, owner: res.locals.owner, expiresAt, artifact });
        ticket = { id, expiresAt };
      }
      res.json({ artifact, cases: numbers, ticket, derivative });
    } finally { fs.rmSync(req.file.path, { force: true }); }
  });
  app.post('/api/cases/from-ticket', express.json({ limit: '2kb' }), async (req, res) => {
    rateLimit(req, 'cases', 60);
    const id = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    const ticket = /^[a-f0-9]{32}$/.test(id) ? tickets.get(id) : undefined;
    if (!ticket || ticket.owner !== res.locals.owner || ticket.expiresAt <= Date.now()) throw new HttpError(404, 'TICKET_EXPIRED', 'That check has expired. Drop the file again to open a case for it.');
    tickets.delete(id);
    const record = records.create({ creator: res.locals.owner, artifact: ticket.artifact });
    res.status(201).json(present(record, res));
  });

  // Propose the next step: the server issues the statement; only the identity it names can make it take effect.
  app.post('/api/cases/:number/steps', express.json({ limit: '4kb' }), async (req, res) => {
    rateLimit(req, 'cases', 60);
    const number = caseNumber(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = typeof body.type === 'string' && (EVENT_TYPES as readonly string[]).includes(body.type) ? body.type as EventType : undefined;
    if (!type) throw new HttpError(400, 'INVALID_STEP', 'Unknown step.');
    let deadline: number | undefined;
    if (body.deadline !== undefined && body.deadline !== '') {
      deadline = typeof body.deadline === 'string' ? (parseIsoTime(body.deadline) ?? Date.parse(body.deadline)) : NaN;
      if (!Number.isFinite(deadline) || type !== 'TASK_ASSIGNED') throw new HttpError(400, 'INVALID_DEADLINE', 'Enter the deadline as a date and time.');
      if (deadline <= Date.now()) throw new HttpError(400, 'INVALID_DEADLINE', 'The deadline needs to be in the future.');
    }
    const signing = await signingStatus();
    if (!signing.enabled) throw new HttpError(503, 'SIGNING_UNAVAILABLE', signing.reason || 'Steps can’t be issued for signing until the service identity is set up.');
    const view = await records.withCase(number, async record => {
      if (!record) throw new HttpError(404, 'NOT_FOUND', 'There’s no case with this number.');
      refresh(record);
      // Refuse impossible transitions before resolving anyone on chain.
      const projection = project(record.events, record.names);
      if (!allowedSteps(projection).some(step => step.type === type)) {
        throw new HttpError(409, 'NOT_ALLOWED', `${type.replace(/_/g, ' ').toLowerCase()} isn’t possible while the case is ${projection.status}.`);
      }
      const actorQuery = typeof body.actor === 'string' ? body.actor.trim() : '';
      let actor: IdentityRef | undefined;
      if (!record.events.length) {
        // The opening statement names its signer; that identity becomes the owner.
        if (!actorQuery) throw new HttpError(400, 'INVALID_IDENTITY', 'Name the VerusID that will own this case.');
        actor = await resolve(actorQuery, 'owner');
      } else if (actorQuery) {
        // Among entitled identities (owner or responsible), pick by id or name without a chain round trip.
        const known = Object.entries(record.names).find(([id, name]) => id === actorQuery || name === actorQuery || `${name}@` === actorQuery || name === actorQuery.replace(/@$/, ''));
        if (!known) throw new HttpError(422, 'NOT_ENTITLED', 'That identity can’t sign this step.');
        actor = { id: known[0], name: known[1] };
      }
      const to = type === 'TASK_ASSIGNED' ? await resolve(typeof body.to === 'string' ? body.to.trim() : '', 'reviewer') : undefined;
      await issue(record, { type, actor, to, deadline }, res.locals.owner);
      return present(record, res);
    });
    res.status(201).json(view);
  });
  app.delete('/api/cases/:number/step', async (req, res) => {
    const number = caseNumber(req);
    const view = await records.withCase(number, record => {
      if (!record) throw new HttpError(404, 'NOT_FOUND', 'There’s no case with this number.');
      refresh(record);
      if (!record.pending) throw new HttpError(409, 'NO_STEP', 'Nothing is waiting to be signed.');
      if (record.pending.proposer !== res.locals.owner) throw new HttpError(403, 'NOT_PROPOSER', 'Only the browser that started this step can take it back. Starting another step replaces it.');
      record.pending = undefined;
      records.save(record);
      return present(record, res);
    });
    res.json(view);
  });

  app.get('/api/cases/:number/export', async (req, res) => {
    rateLimit(req, 'cases', 60);
    const number = caseNumber(req);
    const pkg = await records.withCase(number, async record => {
      if (!record) throw new HttpError(404, 'NOT_FOUND', 'There’s no case with this number.');
      const exportedAt = isoTime(Date.now());
      let attestation;
      if ((await signingStatus()).enabled) {
        try {
          const statement = exportAttestationStatement(record, exportedAt);
          attestation = { statement, ...(await cases.signStatement(statement)) };
        } catch (error) { chainError(error); }
      }
      return exportPackage(record, { exportedAt, attestation });
    });
    res.attachment(`${number}.json`).type('json').send(JSON.stringify(pkg, null, 2));
  });

  async function acceptAttestation(attestationId: string, body: Buffer): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(attestationId)) throw new HttpError(404, 'NOT_FOUND', 'Step not found.');
    if (!body.length || body.length > 65_536) throw new HttpError(400, 'INVALID_CALLBACK', 'Invalid wallet response size.');
    const number = records.numberByAttestation(attestationId);
    if (!number) throw new HttpError(404, 'NOT_FOUND', 'Step not found.');
    await records.withCase(number, async record => {
      if (!record) throw new HttpError(404, 'NOT_FOUND', 'Step not found.');
      const digest = sha256(body);
      if (record.attestations[attestationId] === digest) return; // exact wallet retry
      if (record.attestations[attestationId]) throw new HttpError(409, 'JOB_CLOSED', 'This step was already signed with a different response.');
      refresh(record);
      const step = record.pending;
      if (!step || step.id !== attestationId) throw new HttpError(409, 'JOB_CLOSED', 'This step is no longer waiting for a signature.');
      if (locks.has(attestationId)) throw new HttpError(409, 'CALLBACK_BUSY', 'Another response is being checked. Retry shortly.');
      if (locks.size >= 4) throw new HttpError(503, 'BUSY', 'Wallet responses are being checked. Please retry shortly.');
      locks.add(attestationId);
      try {
        const verified = await cases.verifyCaseResponse({ body, requestHex: step.requestHex, message: step.statement, requestIdHex: step.requestIdHex });
        if (verified.identityId !== step.expectedSigner.id) {
          throw new HttpError(422, 'WRONG_IDENTITY', `This step has to be signed by ${step.fields.actorName}. Pick that identity in Verus Mobile and sign again.`);
        }
        const height = verified.identity.height;
        const last = record.events.at(-1);
        if (height < step.fields.block.height - BLOCK_TOLERANCE) throw new HttpError(422, 'STALE_SIGNATURE', 'The wallet signed with a block height older than this step. Let it sync, then sign again.');
        if (last && height < last.signature.height) throw new HttpError(422, 'STALE_SIGNATURE', 'The wallet signed with a block height older than the previous step. Let it sync, then sign again.');
        if (step.expiresAt <= Date.now()) throw new HttpError(409, 'JOB_CLOSED', 'This step expired before the signature arrived.');
        if (step.fields.seq !== record.events.length + 1 || step.fields.prev !== (last?.hash ?? '0'.repeat(64))) throw new HttpError(409, 'JOB_CLOSED', 'The case changed while this step was open.');
        let evidence: { atHeight: unknown; current: unknown };
        try { evidence = await cases.identityEvidence(verified.identityId, height); } catch (error) { chainError(error); }
        const now = Date.now();
        const hash = eventHash(step.statement, verified.nativeSignature);
        const event: CaseEvent = {
          seq: step.fields.seq, type: step.type, statement: step.statement, fields: step.fields, hash, prev: step.fields.prev,
          signature: { native: verified.nativeSignature, identityId: verified.identityId, name: verified.displayIdentity.name, height, systemId: verified.systemId },
          acceptedAt: now, anchor: pendingAnchor(hash, anchorer, now),
          identity: { atHeight: evidence.atHeight, current: evidence.current, keyState: keyStateOf(evidence.atHeight, evidence.current), currentActive: verified.displayIdentity.currentStatus === 'active' },
        };
        record.events.push(event);
        record.names[verified.identityId] = verified.displayIdentity.name;
        record.pending = undefined;
        record.attestations[attestationId] = digest;
        records.save(record);
      } finally { locks.delete(attestationId); }
    });
    return number;
  }
  /**
   * Wallet callbacks arrive without the app's SameSite=Strict session cookie,
   * so the app's session middleware queues a fresh one. Dropping it keeps the
   * same rule the app applies to its own callbacks: a wallet return never
   * replaces the browser's session, and a signature never grants ownership.
   */
  const noSession = (res: Response) => res.removeHeader('Set-Cookie');
  app.post('/api/cases/attestations/:id/response', express.raw({ type: 'application/octet-stream', limit: '64kb' }), async (req, res) => {
    noSession(res);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'INVALID_CALLBACK', 'Send a binary GenericResponse as application/octet-stream.');
    await acceptAttestation(String(req.params.id), req.body);
    res.json({ accepted: true });
  });
  app.get('/api/cases/attestations/:id/response', async (req, res) => {
    noSession(res);
    const id = String(req.params.id);
    const destination = new URLSearchParams();
    // Only the Cases page receives the redirect. Response data and error text never travel in the URL.
    const number = /^[a-f0-9]{32}$/.test(id) ? records.numberByAttestation(id) : undefined;
    destination.set('caseReturn', number ?? 'invalid');
    try { await acceptAttestation(id, decodeRedirectResponse(req.originalUrl)); }
    catch (error) {
      const code = error instanceof HttpError || error instanceof VerusError ? error.code : 'INTERNAL_ERROR';
      destination.set('returnError', code);
    }
    res.redirect(303, `/cases?${destination.toString()}`);
  });

  return { store: records, cases };
}
