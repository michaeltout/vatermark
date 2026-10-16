import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RustIdentity, DisplayIdentity } from './verus.js';
import type { MetadataJob } from './metadata.js';

export type JobStatus = 'preparing' | 'awaiting_signature' | 'finalizing' | 'complete' | 'failed' | 'expired' | 'cancelled';
export interface Prepared {
  profile: number; flags: number; systemId: string; width: number; height: number;
  helperHex: string; quantized: number[]; message: string; commitment: string; sourceSha256: string;
}
export interface AcceptedSignature {
  identityId: string; systemId: string; nativeSignature: string;
  identity: RustIdentity; displayIdentity: DisplayIdentity;
}
export interface Job {
  id: string; owner: string; status: JobStatus; createdAt: number; expiresAt: number; deleteAt: number;
  requestIdHex: string; prepared?: Prepared; requestHex?: string; walletUri?: string;
  acceptedHash?: string; accepted?: AcceptedSignature; message?: string; verification?: unknown;
  lease?: { token: string; until: number }; outputObject?: string;
  metadata?: MetadataJob;
}
export function ownerHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

/** A single-process local MVP store. Writes are atomic; the data directory is private. */
export class JobStore {
  readonly cloud = false;
  readonly jobsDir: string;
  constructor(private dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.jobsDir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }
  directory(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid job identifier');
    return path.join(this.jobsDir, id);
  }
  create(owner: string, ttl: number): Job {
    const createdAt = Date.now();
    const job: Job = { id: randomBytes(16).toString('hex'), owner, status: 'preparing', createdAt,
      expiresAt: createdAt + ttl, deleteAt: createdAt + ttl + 60_000, requestIdHex: randomBytes(20).toString('hex') };
    fs.mkdirSync(this.directory(job.id), { mode: 0o700 }); this.save(job); return job;
  }
  get(id: string): Job | undefined {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
    try { return JSON.parse(fs.readFileSync(path.join(this.directory(id), 'job.json'), 'utf8')) as Job; }
    catch { return undefined; }
  }
  save(job: Job) {
    const dir = this.directory(job.id);
    const temp = path.join(dir, `job-${randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(temp, path.join(dir, 'job.json'));
  }
  all(): Job[] {
    return fs.readdirSync(this.jobsDir).map(id => this.get(id)).filter((x): x is Job => !!x);
  }
  cleanup(now = Date.now()) {
    for (const job of this.all()) {
      if (job.status === 'finalizing') continue;
      if (job.deleteAt <= now) fs.rmSync(this.directory(job.id), { recursive: true, force: true });
      else if (job.expiresAt <= now && ['preparing', 'awaiting_signature'].includes(job.status)) {
        job.status = 'expired'; job.message = 'This signing request expired. Upload the image again to create a new request.'; this.save(job);
        this.removeImages(job);
      }
    }
  }
  removeImages(job: Job) {
    for (const name of ['source.png', 'output.png']) fs.rmSync(path.join(this.directory(job.id), name), { force: true });
    // Signed requests, fingerprints and accepted signatures also expire with the image.
    job.prepared = undefined; job.accepted = undefined; job.requestHex = undefined; job.walletUri = undefined; job.metadata = undefined;
    this.save(job);
  }
}
