import { spawn } from 'node:child_process';
import { HttpError } from './errors.js';

export interface Worker {
  run<T = Record<string, unknown>>(command: Record<string, unknown>): Promise<T>;
}
export class WorkerError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export class RustWorker implements Worker {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private executable: string, private concurrency = 2, private timeoutMs = 60_000, private maxWaiting = 8) {}
  async run<T = Record<string, unknown>>(command: Record<string, unknown>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw new HttpError(503, 'BUSY', 'The image processor is busy. Please try again shortly.');
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else { this.active++; }
    try { return await this.execute<T>(command); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
  private execute<T>(command: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      // Never inherit the server WIF (or any application secrets) into the worker.
      const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
      let output = ''; let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value as T);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new WorkerError('timeout', 'Image processing timed out. Try a smaller image.'));
      }, this.timeoutMs);
      child.on('error', () => finish(new WorkerError('unavailable', 'Image processor unavailable. Run pnpm build:engine.')));
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 1024 * 1024) {
          child.kill('SIGKILL'); finish(new WorkerError('invalid_response', 'Image processor returned an oversized response.'));
        }
      });
      // Consume diagnostics without returning filesystem paths or data to clients.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('close', code => {
        if (settled) return;
        try {
          const value = JSON.parse(output);
          if (value.ok !== true || code !== 0) {
            finish(new WorkerError(value.error?.code || 'processing_failed', value.error?.message || 'Image processing failed.'));
          } else { finish(undefined, value as T); }
        } catch { finish(new WorkerError('invalid_response', 'Image processor did not return a valid response.')); }
      });
      child.stdin.end(JSON.stringify(command));
    });
  }
}
