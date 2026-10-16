import express, { type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';
import { HttpError } from './errors.js';
import type { Job, JobStore } from './jobs.js';
import { StoreConflict, type CloudJobStore } from './cloud-store.js';
import { MetadataService, validateMetadata, type MetadataContext } from './metadata.js';
import { GENERIC_RESPONSE_QUERY_KEY, VerusError } from './verus.js';

export function imageMetadataContext(job: Job): MetadataContext {
  if (job.status !== 'complete' || !job.accepted || !job.prepared) throw new HttpError(409, 'NOT_READY', 'Sign the image before adding image details.');
  return { profile: job.prepared.profile, identityId: job.accepted.identityId,
    systemId: job.accepted.systemId, nativeSignature: job.accepted.nativeSignature };
}

export async function expireMetadata(job: Job, store: JobStore | CloudJobStore) {
  // Local requests from the earlier pre-encryption implementation must be
  // recreated; do not continue presenting their old ciphertext-only QR.
  if (job.metadata && ['awaiting_approval', 'submitted', 'published'].includes(job.metadata.status) && !job.metadata.payloadHash) {
    const submitted = job.metadata.status !== 'awaiting_approval';
    job.metadata.status = submitted ? 'failed' : 'expired';
    job.metadata.message = submitted
      ? 'The image details format changed. Any previously submitted chain update is unaffected. Create a new details request.'
      : 'The image details request format changed. Create a new details request.';
    job.metadata.walletUri = undefined; job.metadata.requestHex = undefined;
    await store.save(job);
  }
  if (job.metadata && ['preparing', 'awaiting_approval'].includes(job.metadata.status) && job.metadata.expiresAt <= Date.now()) {
    job.metadata.status = 'expired'; job.metadata.message = 'The image details request expired. Your signed image is still available.';
    job.metadata.walletUri = undefined; job.metadata.requestHex = undefined;
    await store.save(job);
  }
}

/** This second approval has its own lifetime and never alters the image bytes. */
export function mountMetadataRoutes(app: express.Express, options: {
  config: AppConfig; store: JobStore | CloudJobStore; service?: MetadataService;
  owned(req: Request, res: Response): Promise<Job>;
  expire(job: Job): Promise<Job>;
  view(job: Job): unknown;
  rateLimit(req: Request, scope: string, maximum: number): void;
}) {
  const { config, store, service, owned, expire, view, rateLimit } = options;
  const preparing = new Set<string>();
  const callbacks = new Set<string>();
  const checking = new Set<string>();
  function enabled() {
    if (!service || !config.publicOrigin) throw new HttpError(503, 'METADATA_UNAVAILABLE', 'Identity metadata is not configured on this service.');
    return service;
  }
  async function refresh(job: Job, force = false): Promise<Job> {
    const pending = job.metadata;
    if (!service || job.status !== 'complete' || !pending || !['awaiting_approval', 'submitted'].includes(pending.status)
      || !pending.contentKey || !pending.payloadHash || checking.has(job.id)
      || (!force && (pending.status !== 'submitted' || Date.now() - (pending.checkedAt ?? 0) < 10_000))) return job;
    // Persist the throttle before RPC, so separate instances share its budget.
    if (Date.now() - (pending.checkedAt ?? 0) < 5_000) return job;
    checking.add(job.id);
    try {
      pending.checkedAt = Date.now(); await store.save(job);
      const result = await service.lookup(imageMetadataContext(job), {
        contentKey: pending.contentKey, payloadHash: pending.payloadHash, txid: pending.txid,
      });
      const current = await store.get(job.id);
      if (!current || (await expire(current)).status !== 'complete' || current.metadata?.requestIdHex !== pending.requestIdHex
        || !['awaiting_approval', 'submitted'].includes(current.metadata.status)) return current ?? job;
      if (result.status === 'decrypted') {
        current.metadata.status = 'published'; current.metadata.txid = result.txid;
        current.metadata.message = 'Your image details are confirmed on the signing identity.';
        current.metadata.walletUri = undefined;
      } else {
        current.metadata.message = result.status === 'not_found'
          ? 'Waiting for the identity update to appear in confirmed chain data.' : result.message;
      }
      await store.save(current); return current;
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
      return (await store.get(job.id)) ?? job;
    } finally { checking.delete(job.id); }
  }

  app.post('/api/sign-jobs/:id/metadata', express.json({ limit: '4kb' }), async (req, res) => {
    rateLimit(req, 'metadata-create', 12);
    const active = enabled();
    if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'metadata')) throw new HttpError(400, 'INVALID_METADATA', 'Provide image details.');
    const data = validateMetadata(req.body.metadata);
    const id = String(req.params.id);
    if (preparing.has(id)) throw new HttpError(409, 'METADATA_PENDING', 'Image details are already being prepared.');
    if (preparing.size >= 4) throw new HttpError(503, 'BUSY', 'Image details preparation is busy. Please retry shortly.');
    preparing.add(id);
    let requestId: string | undefined;
    try {
      const job = await expire(await owned(req, res));
      const context = imageMetadataContext(job);
      if (job.metadata && ['preparing', 'awaiting_approval', 'submitted'].includes(job.metadata.status)) throw new HttpError(409, 'METADATA_PENDING', 'Finish or cancel the existing image details request first.');
      requestId = randomBytes(20).toString('hex');
      const now = Date.now();
      job.metadata = { status: 'preparing', requestIdHex: requestId, createdAt: now,
        expiresAt: Math.min(job.deleteAt, now + config.jobTtlMs) };
      await store.save(job);
      const signed = await active.prepare(context, data, { requestIdHex: requestId,
        callbackUrl: `${config.publicOrigin}/api/sign-jobs/${job.id}/metadata/response`, responseMode: config.responseMode });
      const current = await store.get(id);
      if (!current || (await expire(current)).status !== 'complete' || current.metadata?.requestIdHex !== requestId
        || current.metadata.status !== 'preparing') throw new HttpError(409, 'METADATA_CLOSED', 'This image details request expired or was cancelled.');
      Object.assign(current.metadata, { status: 'awaiting_approval', requestHex: signed.requestHex,
        walletUri: signed.walletUri, contentKey: signed.contentKey, locator: signed.locator,
        payloadHash: signed.payloadHash, message: 'Approve the optional identity update in your wallet.' });
      await store.save(current);
      res.status(201).json(view(current));
    } catch (error) {
      const current = requestId ? await store.get(id) : undefined;
      if (current?.metadata?.requestIdHex === requestId && current?.metadata?.status === 'preparing') {
        current.metadata.status = 'failed'; current.metadata.message = 'Image details could not be prepared. Your signed image is still available.';
        try { await store.save(current); } catch (saveError) { if (!(saveError instanceof StoreConflict)) throw saveError; }
      }
      throw error;
    } finally { preparing.delete(id); }
  });
  app.post('/api/sign-jobs/:id/metadata/check', async (req, res) => {
    rateLimit(req, 'metadata-check', 20);
    enabled(); const job = await expire(await owned(req, res)); imageMetadataContext(job);
    res.json(view(await refresh(job, true)));
  });
  app.delete('/api/sign-jobs/:id/metadata', async (req, res) => {
    const job = await expire(await owned(req, res)); imageMetadataContext(job);
    if (job.metadata && ['submitted', 'published'].includes(job.metadata.status)) throw new HttpError(409, 'METADATA_SUBMITTED', 'A submitted identity update cannot be cancelled here.');
    job.metadata = undefined; await store.save(job); res.json(view(job));
  });

  async function accept(id: string, body: Buffer) {
    const active = enabled();
    if (!body.length || body.length > 65_536) throw new HttpError(400, 'INVALID_CALLBACK', 'Invalid wallet response size.');
    if (callbacks.has(id)) throw new HttpError(409, 'CALLBACK_BUSY', 'Another response is being validated. Retry shortly.');
    if (callbacks.size >= 4) throw new HttpError(503, 'BUSY', 'Wallet response validation is busy. Please retry shortly.');
    callbacks.add(id);
    try {
      const job = await store.get(id);
      if (!job) throw new HttpError(404, 'NOT_FOUND', 'Signing job not found.');
      await expire(job); imageMetadataContext(job);
      const digest = createHash('sha256').update(body).digest('hex');
      const pending = job.metadata;
      if (pending?.acceptedHash === digest && ['submitted', 'published'].includes(pending.status)) return;
      if (!pending?.requestHex || !['awaiting_approval', 'published'].includes(pending.status)) throw new HttpError(409, 'METADATA_CLOSED', 'This image details request is no longer accepting a response.');
      const accepted = await active.adapter.verifyMetadataResponse({ body, requestHex: pending.requestHex,
        requestIdHex: pending.requestIdHex, identityId: job.accepted!.identityId });
      const current = await store.get(id);
      if (!current || (await expire(current)).status !== 'complete' || current.metadata?.requestIdHex !== pending.requestIdHex
        || !['awaiting_approval', 'published'].includes(current.metadata.status)) throw new HttpError(409, 'METADATA_CLOSED', 'This image details request expired or was cancelled.');
      // An owner may confirm publication before the wallet returns. A matching
      // signed receipt is still accepted, without undoing that confirmation.
      const published = current.metadata.status === 'published';
      if (published && current.metadata.txid !== accepted.txid) throw new HttpError(409, 'METADATA_MISMATCH', 'The wallet response names a different identity update.');
      current.metadata.acceptedHash = digest; current.metadata.txid = accepted.txid;
      current.metadata.status = published ? 'published' : 'submitted'; current.metadata.walletUri = undefined;
      if (!published) current.metadata.message = 'Wallet response received. Waiting for the identity update to be confirmed.';
      await store.save(current); // Callback success alone never proves chain publication.
    } finally { callbacks.delete(id); }
  }
  app.post('/api/sign-jobs/:id/metadata/response', express.raw({ type: 'application/octet-stream', limit: '64kb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'INVALID_CALLBACK', 'Send a binary GenericResponse as application/octet-stream.');
    await accept(String(req.params.id), req.body); res.json({ accepted: true });
  });
  app.get('/api/sign-jobs/:id/metadata/response', async (req, res) => {
    const id = String(req.params.id);
    const destination = new URLSearchParams({ walletReturn: /^[a-f0-9]{32}$/.test(id) ? id : 'invalid', metadataReturn: '1' });
    try {
      const values = new URL(req.originalUrl, 'http://callback.invalid').searchParams.getAll(GENERIC_RESPONSE_QUERY_KEY);
      const encoded = values[0] || '';
      if (values.length !== 1 || encoded.length > 87_382 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new HttpError(400, 'INVALID_CALLBACK', 'Invalid wallet response encoding.');
      const body = Buffer.from(encoded, 'base64url');
      if (body.toString('base64url') !== encoded) throw new HttpError(400, 'INVALID_CALLBACK', 'Noncanonical wallet response encoding.');
      await accept(id, body);
    } catch (error) {
      destination.set('returnError', error instanceof HttpError || error instanceof VerusError ? error.code : 'INTERNAL_ERROR');
    }
    res.redirect(303, `/?${destination}`);
  });
  return { refresh };
}
