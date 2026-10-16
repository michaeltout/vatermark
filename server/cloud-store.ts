import { Storage } from '@google-cloud/storage';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { JobStore, type Job } from './jobs.js';
import { HttpError } from './errors.js';

export class StoreConflict extends HttpError {
  constructor() { super(409, 'JOB_CHANGED', 'This signing job changed. Refresh its status or retry the wallet response.'); }
}
export interface StoredObject { data: Buffer; revision: string }
/** The narrow adapter also permits deterministic concurrency tests without cloud credentials. */
export interface PrivateObjects {
  read(name: string): Promise<StoredObject | undefined>;
  write(name: string, data: Buffer, revision: string | 0): Promise<string>;
  list(prefix: string): Promise<string[]>;
  remove(name: string): Promise<void>;
  upload(name: string, filename: string): Promise<void>;
  download(name: string, filename: string): Promise<void>;
  stream(name: string): Promise<Readable>;
}
function isCode(error: unknown, code: number) { return !!error && typeof error === 'object' && 'code' in error && Number(error.code) === code; }
export class GcsObjects implements PrivateObjects {
  private bucket;
  constructor(bucket: string) {
    this.bucket = new Storage({ timeout: 10_000, retryOptions: { maxRetries: 1, totalTimeout: 15, maxRetryDelay: 1 } }).bucket(bucket);
  }
  async read(name: string): Promise<StoredObject | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [metadata] = await this.bucket.file(name).getMetadata();
        const revision = String(metadata.generation);
        // Pin the download to the exact generation used by the next CAS write.
        const [data] = await this.bucket.file(name, { generation: revision }).download();
        return { data, revision };
      } catch (error) {
        if (isCode(error, 404)) { if (attempt === 2) return undefined; continue; }
        throw error;
      }
    }
  }
  async write(name: string, data: Buffer, revision: string | 0): Promise<string> {
    try {
      await this.bucket.file(name).save(data, { resumable: false, contentType: 'application/json',
        metadata: { cacheControl: 'private, no-store' }, preconditionOpts: { ifGenerationMatch: revision } });
      const stored = await this.read(name);
      // A subsequent writer may already have advanced the generation. Never
      // lend that writer's generation to the stale in-memory job.
      if (!stored || !stored.data.equals(data)) throw new StoreConflict();
      return stored.revision;
    } catch (error) { if (isCode(error, 412)) throw new StoreConflict(); throw error; }
  }
  async list(prefix: string) { const [files] = await this.bucket.getFiles({ prefix }); return files.map(file => file.name); }
  async remove(name: string) { await this.bucket.file(name).delete({ ignoreNotFound: true }); }
  async upload(name: string, filename: string) {
    await this.bucket.upload(filename, { destination: name, resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'image/png', cacheControl: 'private, no-store' } });
  }
  async download(name: string, filename: string) { await this.bucket.file(name).download({ destination: filename }); fs.chmodSync(filename, 0o600); }
  async stream(name: string) {
    // Check before selecting the image content type so failures remain JSON.
    await this.bucket.file(name).getMetadata();
    return this.bucket.file(name).createReadStream();
  }
}

/** Private object storage; all job mutations require the generation last read. */
export class CloudJobStore {
  readonly cloud = true;
  private local: JobStore;
  private revisions = new WeakMap<Job, string | 0>();
  constructor(dataDir: string, private objects: PrivateObjects) { this.local = new JobStore(dataDir); }
  directory(id: string) { const directory = this.local.directory(id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory; }
  private key(id: string) { this.local.directory(id); return `jobs/${id}/job.json`; }
  async create(owner: string, ttl: number): Promise<Job> {
    const createdAt = Date.now();
    const job: Job = { id: randomBytes(16).toString('hex'), owner, status: 'preparing', createdAt,
      expiresAt: createdAt + ttl, deleteAt: createdAt + ttl + 60_000, requestIdHex: randomBytes(20).toString('hex') };
    this.revisions.set(job, 0); this.directory(job.id); await this.save(job); return job;
  }
  async get(id: string): Promise<Job | undefined> {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
    const stored = await this.objects.read(this.key(id));
    if (!stored) return undefined;
    const job = JSON.parse(stored.data.toString('utf8')) as Job;
    if (job.id !== id) throw new Error('Invalid persisted job');
    this.revisions.set(job, stored.revision); return job;
  }
  async save(job: Job) {
    const revision = this.revisions.get(job);
    if (revision === undefined) throw new StoreConflict();
    this.revisions.set(job, await this.objects.write(this.key(job.id), Buffer.from(JSON.stringify(job)), revision));
  }
  async all(): Promise<Job[]> {
    const names = (await this.objects.list('jobs/')).filter(name => /^jobs\/[a-f0-9]{32}\/job\.json$/.test(name));
    const jobs: Job[] = [];
    for (const name of names) { const job = await this.get(name.split('/')[1]); if (job) jobs.push(job); }
    return jobs;
  }
  async claim(job: Job, now = Date.now()): Promise<string | undefined> {
    if (job.status !== 'finalizing' || (job.lease && job.lease.until > now)) return undefined;
    const token = randomBytes(16).toString('hex');
    job.lease = { token, until: now + 120_000 };
    await this.save(job); return token;
  }
  async publish(job: Job, name: 'source.png' | 'output.png', filename: string) {
    const object = name === 'source.png' ? `jobs/${job.id}/source.png`
      : `jobs/${job.id}/output-${job.lease!.token}.png`;
    await this.objects.upload(object, filename);
    if (name === 'output.png') job.outputObject = object;
  }
  private imageKey(job: Job, name: 'source.png' | 'output.png') {
    if (name === 'source.png') return `jobs/${job.id}/source.png`;
    if (!job.outputObject || !new RegExp(`^jobs/${job.id}/output-[a-f0-9]{32}\\.png$`).test(job.outputObject)) throw new Error('Missing signed output');
    return job.outputObject;
  }
  async hydrate(job: Job, name: 'source.png' | 'output.png'): Promise<string> {
    const filename = path.join(this.directory(job.id), name);
    await this.objects.download(this.imageKey(job, name), filename);
    return filename;
  }
  stream(job: Job, name: 'source.png' | 'output.png') { return this.objects.stream(this.imageKey(job, name)); }
  async removeImages(job: Job) {
    job.prepared = undefined; job.accepted = undefined; job.requestHex = undefined; job.walletUri = undefined; job.metadata = undefined;
    job.lease = undefined; job.outputObject = undefined;
    // First win the terminal state transition. A stale cancelled/failed writer
    // must never erase the active finalizer's source or published output.
    await this.save(job);
    const images = (await this.objects.list(`jobs/${job.id}/`)).filter(name => name.endsWith('.png'));
    await Promise.all(images.map(name => this.objects.remove(name)));
    this.releaseLocal(job.id);
  }
  releaseLocal(id: string) { fs.rmSync(this.local.directory(id), { recursive: true, force: true }); }
  async cleanup(now = Date.now()) {
    for (const job of await this.all()) {
      if (job.status === 'finalizing') continue;
      if (job.deleteAt <= now || (job.expiresAt <= now && ['preparing', 'awaiting_signature'].includes(job.status))) {
        job.status = 'expired'; job.message = 'This signing job expired. Upload the image again.';
        try { await this.removeImages(job); } catch (error) { if (!(error instanceof StoreConflict)) throw error; }
      }
    }
  }
}
