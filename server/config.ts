import { loadGiftConfig, type GiftConfig } from './gifts.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  gifts?: GiftConfig;
  root: string; dataDir: string; host: string; port: number; rpcUrl: string;
  publicOrigin?: string; serviceId?: string; serviceWif?: string;
  responseMode: 'redirect' | 'post'; jobStorageBucket?: string;
  workerBinary: string; workerConcurrency: number; workerTimeoutMs: number;
  maxUploadBytes: number; maxPixels: number; jobTtlMs: number; outputTtlMs: number;
  tlsCertPath?: string; tlsKeyPath?: string;
}
const root = fileURLToPath(new URL('..', import.meta.url));
function number(value: string | undefined, fallback: number, min: number, max: number) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid numeric server configuration.');
  return result;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jobStorageBucket = env.JOB_STORAGE_BUCKET?.trim() || undefined;
  const responseMode = env.WALLET_RESPONSE_MODE?.trim() || 'redirect';
  if (responseMode !== 'redirect' && responseMode !== 'post') throw new Error('WALLET_RESPONSE_MODE must be redirect or post.');
  const port = number(env.PORT, jobStorageBucket ? 8080 : 5173, 1, 65535);
  let publicOrigin: string | undefined;
  const origin = env.PUBLIC_ORIGIN?.trim() || (responseMode === 'redirect'
    ? `${env.TLS_CERT_PATH && env.TLS_KEY_PATH ? 'https' : 'http'}://127.0.0.1:${port}` : undefined);
  if (jobStorageBucket && !env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required for hosted storage.');
  if (origin) {
    const url = new URL(origin);
    if (!(url.protocol === 'https:' || (responseMode === 'redirect' && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment. POST mode requires HTTPS.');
    }
    if (jobStorageBucket && url.protocol !== 'https:') throw new Error('Hosted PUBLIC_ORIGIN requires HTTPS.');
    publicOrigin = url.origin;
  }
  const rpcUrl = env.VERUS_RPC_URL || 'https://api.verustest.net';
  if (new URL(rpcUrl).protocol !== 'https:') throw new Error('VERUS_RPC_URL must use HTTPS.');
  const config: AppConfig = {
    root, dataDir: path.resolve(root, env.DATA_DIR || '.data'), host: env.HOST || (jobStorageBucket ? '0.0.0.0' : '127.0.0.1'),
    port, rpcUrl, publicOrigin, responseMode, jobStorageBucket,
    serviceId: env.VATERMARK_SERVICE_ID?.trim() || undefined,
    serviceWif: env.VATERMARK_SERVICE_WIF?.trim() || undefined,
    workerBinary: path.resolve(root, env.VATERMARK_WORKER || 'bin/vatermark-worker'),
    workerConcurrency: number(env.WORKER_CONCURRENCY, 2, 1, 8), workerTimeoutMs: jobStorageBucket ? 35_000 : 60_000,
    maxUploadBytes: number(env.MAX_UPLOAD_BYTES, (jobStorageBucket ? 30 : 96) * 1024 * 1024, 1024, (jobStorageBucket ? 30 : 96) * 1024 * 1024),
    maxPixels: 24_000_000,
    jobTtlMs: number(env.SIGN_JOB_TTL_MINUTES, 15, 1, 60) * 60_000,
    outputTtlMs: number(env.OUTPUT_TTL_MINUTES, 60, 1, 1440) * 60_000,
    tlsCertPath: env.TLS_CERT_PATH ? path.resolve(root, env.TLS_CERT_PATH) : undefined,
    tlsKeyPath: env.TLS_KEY_PATH ? path.resolve(root, env.TLS_KEY_PATH) : undefined,
  };
  config.gifts = loadGiftConfig(env, config);
  return config;
}
