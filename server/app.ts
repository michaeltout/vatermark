import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';
import { HttpError } from './errors.js';
import { CloudJobStore, GcsObjects, StoreConflict } from './cloud-store.js';
import { pipeline } from 'node:stream/promises';
import { JobStore, ownerHash, type Job, type Prepared } from './jobs.js';
import { RustWorker, WorkerError, type Worker } from './worker.js';
import { VerusAdapter, VerusError, GENERIC_RESPONSE_QUERY_KEY, type IdentityQuery } from './verus.js';
import { MetadataVerusAdapter } from './metadata-verus.js';
import { MetadataService, MAX_METADATA_BYTES, metadataView, type MetadataAdapter } from './metadata.js';
import { mountMetadataRoutes, expireMetadata } from './metadata-routes.js';
import { CloudGiftStore, GiftService, LocalGiftStore, loadGiftConfig } from './gifts.js';
import { mountGiftRoutes } from './gift-routes.js';
import { mountCaseRoutes } from './cases/index.js';

export type Adapter = Pick<VerusAdapter, 'status' | 'createRequest' | 'resolveIdentity' | 'verifyResponse'>;
export async function createApp(config: AppConfig, dependencies: { worker?: Worker; adapter?: Adapter; metadataAdapter?: MetadataAdapter; store?: JobStore | CloudJobStore; gifts?: GiftService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const worker = dependencies.worker ?? new RustWorker(config.workerBinary, config.workerConcurrency, config.workerTimeoutMs, config.jobStorageBucket ? 0 : 8);
  const adapter = dependencies.adapter ?? new VerusAdapter(config);
  const metadataAdapter = dependencies.metadataAdapter ?? (!dependencies.adapter && config.serviceId ? new MetadataVerusAdapter(config) : undefined);
  const metadata = metadataAdapter ? new MetadataService(worker, metadataAdapter) : undefined;
  const store = dependencies.store ?? (config.jobStorageBucket
    ? new CloudJobStore(config.dataDir, new GcsObjects(config.jobStorageBucket)) : new JobStore(config.dataDir));
  const giftConfig = config.gifts ?? loadGiftConfig({}, config);
  const gifts = dependencies.gifts ?? new GiftService(giftConfig, config.jobStorageBucket
    ? new CloudGiftStore(new GcsObjects(config.jobStorageBucket)) : new LocalGiftStore(giftConfig.stateFile));
  const cloud = store instanceof CloudJobStore;
  const cookieName = cloud ? '__session' : 'vatermark_owner';
  const uploads = path.join(config.dataDir, cloud ? `uploads-${randomBytes(8).toString('hex')}` : 'uploads');
  fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
  // A single service process owns this directory. Interrupted uploads have no owner.
  for (const file of fs.readdirSync(uploads)) fs.rmSync(path.join(uploads, file), { force: true });
  const upload = multer({ dest: uploads, limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 1 } }).single('image');
  const callbackLocks = new Set<string>();
  const finalizing = new Map<string, Promise<void>>();
  const rates = new Map<string, { until: number; count: number }>();
  let activeImageRequests = 0;
  const allowedOrigins = new Set([
    `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`,
    `https://localhost:${config.port}`, `https://127.0.0.1:${config.port}`,
    ...(config.publicOrigin ? [config.publicOrigin] : []),
  ]);

  function rateLimit(req: Request, scope: string, maximum: number) {
    const now = Date.now();
    // Do not trust client-supplied forwarding headers. This MVP has one local
    // process; a reverse proxy shares its address's budget across its clients.
    const session = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const key = `${scope}:${cloud && session && /^[a-f0-9]{64}$/.test(session) ? ownerHash(session) : req.socket.remoteAddress || 'local'}`;
    let rate = rates.get(key);
    if (!rate || rate.until <= now) {
      for (const [stored, value] of rates) if (value.until <= now) rates.delete(stored);
      if (rates.size >= 4096 && !rate) throw new HttpError(503, 'BUSY', 'The app is busy. Please try again shortly.');
      rate = { until: now + 60_000, count: 0 }; rates.set(key, rate);
    }
    if (++rate.count > maximum) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  function imageAdmission(req: Request, res: Response, next: express.NextFunction) {
    rateLimit(req, 'image', 40);
    if (activeImageRequests >= 8) throw new HttpError(503, 'BUSY', 'The image processor is busy. Please try again shortly.');
    activeImageRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; activeImageRequests--; } };
    res.once('finish', release); res.once('close', release);
    next();
  }

  app.use('/api', (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    // Gift allocation has no network or request-rate gates. Keep the common
    // session and origin checks so assigned bearer keys stay private.
    const giftRoute = /^\/gifts\/(?:current|claim)\/?$/i.test(req.path);
    if (!giftRoute) rateLimit(req, 'api', 300);
    const callback = ['GET', 'POST'].includes(req.method) && /^\/sign-jobs\/[^/]+\/(?:metadata\/)?response$/.test(req.path);
    if (!callback && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if ((origin && !allowedOrigins.has(origin)) || req.get('sec-fetch-site') === 'cross-site') {
        return next(new HttpError(403, 'ORIGIN_REJECTED', 'This request must come from the Vatermark app.'));
      }
    }
    // A wallet redirect may omit a SameSite=Strict cookie even in the original
    // browser. Never replace it here, and never grant ownership via a signature.
    if (callback) return next();
    let token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      token = randomBytes(32).toString('hex');
      const publicUrl = config.publicOrigin ? new URL(config.publicOrigin) : undefined;
      const secure = cloud || req.secure || (publicUrl?.protocol === 'https:' && req.get('host') === publicUrl.host);
      res.cookie(cookieName, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 24 * 60 * 60 * 1000 });
    }
    res.locals.owner = ownerHash(token);
    next();
  });

  async function owned(req: Request, res: Response): Promise<Job> {
    const job = await store.get(String(req.params.id));
    if (!job || job.owner !== res.locals.owner) throw new HttpError(404, 'NOT_FOUND', 'Signing job not found.');
    return job;
  }
  async function expire(job: Job): Promise<Job> {
    if (job.status === 'complete' && job.deleteAt <= Date.now()) {
      job.status = 'expired'; job.message = 'This signed image has expired. Upload the original image to create a new request.';
      await store.removeImages(job);
    } else if (job.expiresAt <= Date.now() && ['preparing', 'awaiting_signature'].includes(job.status)) {
      job.status = 'expired'; job.message = 'This signing request expired. Upload the image again to create a new request.';
      await store.removeImages(job);
    }
    if (job.status === 'complete') await expireMetadata(job, store);
    return job;
  }
  function view(job: Job) {
    return {
      id: job.id, status: job.status, expiresAt: new Date(job.expiresAt).toISOString(), message: job.message,
      qrText: job.status === 'awaiting_signature' ? job.walletUri : undefined,
      walletUri: job.status === 'awaiting_signature' ? job.walletUri : undefined,
      previewUrl: ['awaiting_signature', 'finalizing', 'complete'].includes(job.status)
        ? `/api/sign-jobs/${job.id}/preview?version=${job.status === 'complete' ? 'signed' : 'source'}` : undefined,
      width: job.prepared?.width, height: job.prepared?.height,
      identity: job.accepted?.displayIdentity,
      downloadUrl: job.status === 'complete' ? `/api/sign-jobs/${job.id}/image` : undefined,
      verification: job.verification,
      metadata: metadataView(job.metadata),
    };
  }
  async function signingStatus() {
    if (!config.publicOrigin) return { enabled: false, reason: 'Set PUBLIC_ORIGIN to a phone-reachable HTTPS origin for POST callbacks, or use WALLET_RESPONSE_MODE=redirect for local HTTP testing.' };
    return adapter.status();
  }
  function failureMessage(error: unknown): string {
    if (error instanceof WorkerError || error instanceof VerusError || error instanceof HttpError) return error.message;
    return 'The operation could not be completed. Please try again.';
  }
  function finalize(jobId: string): Promise<void> {
    const running = finalizing.get(jobId);
    if (running) return running;
    const task = (async () => {
      const job = await store.get(jobId);
      if (!job || job.status !== 'finalizing' || !job.prepared || !job.accepted) return;
      let lease: string | undefined;
      try {
        if (store instanceof CloudJobStore) {
          lease = await store.claim(job);
          if (!lease) return; // Another instance owns the unexpired finalizer lease.
        }
        const accepted = job.accepted;
        const current = await adapter.resolveIdentity({ identityId: accepted.identityId, systemId: accepted.systemId,
          testnet: true, signingHeight: accepted.identity.height });
        if (!current.currentActive) throw new HttpError(422, 'REVOKED_IDENTITY', 'The signing identity is no longer active.');
        const input = store instanceof CloudJobStore ? await store.hydrate(job, 'source.png') : path.join(store.directory(job.id), 'source.png');
        const output = path.join(store.directory(job.id), lease ? `output-${lease}.png` : 'output.png');
        fs.rmSync(output, { force: true });
        const result = await worker.run<{ verification: unknown }>({ cmd: 'finalize', input, output, prepared: job.prepared,
          identityId: accepted.identityId, nativeSignature: accepted.nativeSignature, identity: current.identity });
        if (store instanceof CloudJobStore) await store.publish(job, 'output.png', output);
        job.status = 'complete'; job.verification = result.verification;
        job.accepted.displayIdentity = current.displayIdentity;
        job.message = 'Your signed image is ready.'; job.deleteAt = Date.now() + config.outputTtlMs;
        job.lease = undefined;
        await store.save(job);
      } catch (error) {
        if (error instanceof StoreConflict) return;
        const latest = await store.get(jobId);
        if (!latest || latest.status !== 'finalizing' || (cloud && latest.lease?.token !== lease)) return;
        if (cloud && error instanceof HttpError && error.code === 'BUSY') {
          latest.lease = undefined; latest.message = 'The image processor is busy. Waiting to retry.'; await store.save(latest);
        } else {
          latest.status = 'failed'; latest.message = failureMessage(error); await store.removeImages(latest);
        }
      } finally {
        if (store instanceof CloudJobStore && lease) store.releaseLocal(jobId);
      }
    })().catch(() => {
      // The accepted state is durable. Storage outages leave the lease for a
      // later authenticated poll or repeated signed callback to recover.
    }).finally(() => finalizing.delete(jobId));
    finalizing.set(jobId, task); return task;
  }

  app.get('/api/config', async (_req, res) => {
    const signing = await signingStatus();
    res.json({ network: 'VRSCTEST', signing, responseMode: config.responseMode, maxUploadBytes: config.maxUploadBytes, maxPixels: config.maxPixels,
      metadata: { enabled: !!metadata && signing.enabled, maxBytes: MAX_METADATA_BYTES }, gifts: gifts.publicConfig() });
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, network: 'VRSCTEST', workerReady: fs.existsSync(config.workerBinary) }));

  app.post('/api/verify', imageAdmission, upload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'MISSING_IMAGE', 'Choose a PNG or JPEG image.');
    try {
      fs.chmodSync(req.file.path, 0o600);
      const inspection = await worker.run<IdentityQuery & { profile: number }>({ cmd: 'inspect', input: req.file.path });
      const authority = await adapter.resolveIdentity(inspection);
      const result = await worker.run<{ verification: unknown; nativeSignature: string }>({ cmd: 'verify', input: req.file.path, identity: authority.identity });
      const details = metadata ? await metadata.lookup({ profile: inspection.profile, identityId: inspection.identityId,
        systemId: inspection.systemId, nativeSignature: result.nativeSignature }) : undefined;
      res.json({ status: authority.currentActive ? 'verified' : 'revoked',
        message: authority.currentActive ? 'The image matches its signed fingerprint and the signing identity is active.'
          : 'The historical signature is valid, but this identity is currently revoked or inactive.',
        identity: authority.displayIdentity, verification: result.verification, metadata: details });
    } catch (error) {
      if (error instanceof WorkerError || error instanceof VerusError) {
        const code = error.code;
        const status = code === 'no_watermark' ? 'unmarked'
          : ['unsupported_network', 'unsupported_profile', 'UNSUPPORTED_NETWORK'].includes(code) ? 'unsupported'
            : ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'timeout', 'unavailable', 'invalid_response', 'io_error'].includes(code) ? 'unavailable' : 'invalid';
        res.json({ status, message: failureMessage(error) });
      } else throw error;
    } finally { fs.rmSync(req.file.path, { force: true }); }
  });

  app.post('/api/sign-jobs', imageAdmission, async (_req, _res, next) => {
    try {
      const status = await signingStatus();
      if (!status.enabled) throw new HttpError(503, 'SIGNING_UNAVAILABLE', status.reason || 'Signing has not been configured.');
      next();
    } catch (error) { next(error); }
  }, upload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'MISSING_IMAGE', 'Choose a PNG or JPEG image.');
    let job: Job | undefined;
    try {
      const active = (await store.all()).filter(j => j.status === 'finalizing' || (j.status === 'complete' ? j.deleteAt > Date.now()
        : ['preparing', 'awaiting_signature'].includes(j.status) && j.expiresAt > Date.now()));
      if (active.length >= 64 || active.filter(j => j.owner === res.locals.owner && j.status !== 'complete').length >= 4) {
        throw new HttpError(429, 'TOO_MANY_JOBS', 'Too many signing jobs are open. Cancel an existing request or try again later.');
      }
      fs.chmodSync(req.file.path, 0o600);
      job = await store.create(res.locals.owner, config.jobTtlMs);
      const prepared = await worker.run<{ prepared: Prepared }>({ cmd: 'prepare', input: req.file.path,
        normalized_output: path.join(store.directory(job.id), 'source.png') });
      // Work may have waited for a worker or an RPC call past the approval
      // window. Never resurrect a cancelled/expired job from this stale object.
      const isPreparing = async () => {
        const current = await store.get(job!.id);
        if (!current || (await expire(current)).status !== 'preparing') {
          throw new HttpError(409, 'JOB_CLOSED', 'This request expired or was cancelled during preparation. Please try again.');
        }
        return current;
      };
      await isPreparing();
      const signed = await adapter.createRequest({ message: prepared.prepared.message,
        callbackUrl: `${config.publicOrigin}/api/sign-jobs/${job.id}/response`, requestIdHex: job.requestIdHex,
        responseMode: config.responseMode });
      job = await isPreparing();
      if (store instanceof CloudJobStore) await store.publish(job, 'source.png', path.join(store.directory(job.id), 'source.png'));
      job.prepared = prepared.prepared;
      job.requestHex = signed.requestHex; job.walletUri = signed.walletUri;
      job.status = 'awaiting_signature'; await store.save(job);
      if (store instanceof CloudJobStore) store.releaseLocal(job.id);
      res.status(201).json(view(job));
    } catch (error) {
      const current = job && await store.get(job.id);
      if (current && ['preparing', 'failed', 'expired', 'cancelled'].includes(current.status)) {
        if (current.status === 'preparing') { current.status = 'failed'; current.message = failureMessage(error); }
        await store.removeImages(current);
      }
      throw error;
    } finally { fs.rmSync(req.file.path, { force: true }); }
  });
  app.get('/api/sign-jobs/:id', async (req, res) => {
    let job = await expire(await owned(req, res));
    if (cloud && job.status === 'finalizing') { await finalize(job.id); job = (await store.get(job.id))!; }
    job = await metadataRoutes.refresh(job);
    res.json(view(job));
  });
  app.delete('/api/sign-jobs/:id', async (req, res) => {
    const job = await expire(await owned(req, res));
    if (job.status === 'finalizing') throw new HttpError(409, 'FINALIZING', 'The approved image is being finalized.');
    job.status = 'cancelled'; job.message = 'Signing cancelled.'; await store.removeImages(job);
    res.json(view(job));
  });
  async function imageResponse(job: Job, res: Response, name: 'source.png' | 'output.png', download = false) {
    if (store instanceof CloudJobStore) {
      const stream = await store.stream(job, name);
      res.type('png');
      if (download) res.attachment('vatermark-signed.png');
      // Stream instead of buffering: Cloud Run has a 32 MiB non-streamed
      // response limit, and normalized PNGs may be larger than their input.
      await pipeline(stream, res);
    } else if (download) res.download(name, 'vatermark-signed.png', { root: store.directory(job.id) });
    else res.type('png').sendFile(name, { root: store.directory(job.id) });
  }
  app.get('/api/sign-jobs/:id/preview', async (req, res) => {
    const job = await expire(await owned(req, res));
    if (!['awaiting_signature', 'finalizing', 'complete'].includes(job.status)) throw new HttpError(404, 'NOT_FOUND', 'Preview no longer available.');
    await imageResponse(job, res, job.status === 'complete' ? 'output.png' : 'source.png');
  });
  app.get('/api/sign-jobs/:id/image', async (req, res) => {
    const job = await expire(await owned(req, res));
    if (job.status !== 'complete') throw new HttpError(409, 'NOT_READY', 'The signed image is not ready.');
    await imageResponse(job, res, 'output.png', true);
  });

  async function acceptResponse(id: string, body: Buffer) {
    const job = await store.get(id);
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Signing job not found.');
    if (!body.length || body.length > 65_536) throw new HttpError(400, 'INVALID_CALLBACK', 'Invalid wallet response size.');
    await expire(job);
    const digest = createHash('sha256').update(body).digest('hex');
    if (job.acceptedHash === digest && ['finalizing', 'complete'].includes(job.status)) {
      if (cloud && job.status === 'finalizing') await finalize(id);
      return;
    }
    if (job.status !== 'awaiting_signature' || !job.requestHex || !job.prepared) throw new HttpError(409, 'JOB_CLOSED', 'This request is no longer accepting a signature.');
    if (callbackLocks.has(id)) throw new HttpError(409, 'CALLBACK_BUSY', 'Another response is being validated. Retry shortly.');
    if (callbackLocks.size >= 4) throw new HttpError(503, 'BUSY', 'Wallet response validation is busy. Please retry shortly.');
    callbackLocks.add(id);
    try {
      const accepted = await adapter.verifyResponse({ body, requestHex: job.requestHex,
        message: job.prepared.message, requestIdHex: job.requestIdHex });
      const current = await store.get(id);
      if (!current || (await expire(current)).status !== 'awaiting_signature') throw new HttpError(409, 'JOB_CLOSED', 'This request is no longer accepting a signature.');
      current.accepted = accepted; current.acceptedHash = digest; current.status = 'finalizing';
      await store.save(current); // durable acceptance before acknowledging the wallet
      if (cloud) await finalize(id); else void finalize(id);
    } finally { callbackLocks.delete(id); }
  }

  app.post('/api/sign-jobs/:id/response', express.raw({ type: 'application/octet-stream', limit: '64kb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'INVALID_CALLBACK', 'Send a binary GenericResponse as application/octet-stream.');
    await acceptResponse(String(req.params.id), req.body);
    res.json({ accepted: true });
  });

  app.get('/api/sign-jobs/:id/response', async (req, res) => {
    const id = String(req.params.id);
    const destination = new URLSearchParams();
    // Only our own app receives the redirect. Response data and arbitrary error
    // messages must not be copied into the destination URL or browser assets.
    if (/^[a-f0-9]{32}$/.test(id)) destination.set('walletReturn', id);
    else destination.set('walletReturn', 'invalid');
    try {
      const query = new URL(req.originalUrl, 'http://callback.invalid').searchParams;
      const values = query.getAll(GENERIC_RESPONSE_QUERY_KEY);
      const encoded = values[0] || '';
      if (values.length !== 1 || encoded.length > 87_382 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw new HttpError(400, 'INVALID_CALLBACK', 'Invalid wallet response encoding.');
      }
      const body = Buffer.from(encoded, 'base64url');
      if (body.toString('base64url') !== encoded) throw new HttpError(400, 'INVALID_CALLBACK', 'Noncanonical wallet response encoding.');
      await acceptResponse(id, body);
    } catch (error) {
      const code = error instanceof HttpError || error instanceof VerusError ? error.code : 'INTERNAL_ERROR';
      destination.set('returnError', code);
    }
    // The same-browser return can resume its private job. A different browser
    // gets guidance to return to the original tab, not image access.
    res.redirect(303, `/?${destination.toString()}`);
  });

  const metadataRoutes = mountMetadataRoutes(app, { config, store, service: metadata, owned, expire, view, rateLimit });
  // Gift routes use the common private session and CSRF middleware.
  mountGiftRoutes(app, { service: gifts });
  // Cases (beta) is an addition on top: it only reuses the middleware, worker and adapter above. See CASES.md.
  mountCaseRoutes(app, { config, worker, adapter, upload, imageAdmission, rateLimit, signingStatus });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'API route not found.')));
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    if (res.headersSent) return next(error);
    let status = 500; let code = 'INTERNAL_ERROR'; let message = 'The operation could not be completed. Please try again.';
    if (error instanceof HttpError) ({ status, code, message } = error);
    else if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400; code = error.code;
      message = error.code === 'LIMIT_FILE_SIZE' ? `The upload exceeds ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MiB.` : 'Upload exactly one PNG or JPEG image.';
    } else if (error instanceof WorkerError) {
      status = ['unavailable', 'timeout', 'io_error', 'invalid_response'].includes(error.code) ? 503 : 422;
      code = error.code; message = error.message;
    } else if (error instanceof VerusError) {
      status = ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(error.code) ? 503 : 422;
      code = error.code; message = error.message;
    } else if (error?.type === 'entity.too.large') {
      status = 413; code = 'REQUEST_TOO_LARGE'; message = 'The request exceeds the permitted size.';
    } else if (error?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Send valid JSON image details.'; }
    // A failed preview may already have selected image/png. Errors must never
    // masquerade as PNG bytes or retain an attachment disposition.
    res.removeHeader('Content-Disposition');
    res.status(status).type('json').json({ error: { code, message } });
  };
  app.use(errors);
  // Local recovery can run in the background. Cloud Run recovery runs during
  // callbacks/polls so request-scoped CPU remains allocated for the worker.
  if (!cloud) {
    await store.cleanup();
    for (const job of await store.all()) {
      if (job.status === 'finalizing') void finalize(job.id);
      else if (job.status === 'preparing') {
        job.status = 'failed'; job.message = 'Preparation was interrupted. Upload the image again.'; await store.removeImages(job);
      } else if (job.metadata?.status === 'preparing') {
        job.metadata.status = 'failed'; job.metadata.message = 'Image details preparation was interrupted. Your signed image is still available.';
        await store.save(job);
      }
    }
  }
  const cleanup = !cloud ? setInterval(() => { void store.cleanup(); }, 30_000) : undefined;
  cleanup?.unref();
  return { app, close: async () => {
    if (cleanup) clearInterval(cleanup);
    await Promise.allSettled(finalizing.values());
    if (cloud) fs.rmSync(uploads, { recursive: true, force: true });
  } };
}
