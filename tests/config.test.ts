import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';

describe('wallet callback configuration', () => {
  it('defaults to local HTTP redirects and follows the configured port', () => {
    const config = loadConfig({ PORT: '5190' });
    expect(config.responseMode).toBe('redirect');
    expect(config.publicOrigin).toBe('http://127.0.0.1:5190');
  });
  it('supports a LAN HTTP origin for redirect mode', () => {
    expect(loadConfig({ PUBLIC_ORIGIN: 'http://192.168.1.42:5173' }).publicOrigin).toBe('http://192.168.1.42:5173');
  });
  it('keeps POST callbacks HTTPS-only and explicitly configured', () => {
    expect(loadConfig({ WALLET_RESPONSE_MODE: 'post' }).publicOrigin).toBeUndefined();
    expect(() => loadConfig({ WALLET_RESPONSE_MODE: 'post', PUBLIC_ORIGIN: 'http://localhost:5173' })).toThrow(/POST mode requires HTTPS/);
    expect(loadConfig({ WALLET_RESPONSE_MODE: 'post', PUBLIC_ORIGIN: 'https://wallet.example' }).responseMode).toBe('post');
  });
  it('rejects unknown transports and origins containing credentials or paths', () => {
    expect(() => loadConfig({ WALLET_RESPONSE_MODE: 'invalid' })).toThrow(/WALLET_RESPONSE_MODE/);
    for (const origin of ['javascript:alert(1)', 'http://a:b@localhost', 'http://localhost/path', 'http://localhost/?x=1', 'http://localhost/#x']) {
      expect(() => loadConfig({ PUBLIC_ORIGIN: origin })).toThrow();
    }
  });
});

describe('hosted configuration', () => {
  it('requires HTTPS callbacks and bounds uploads below the platform request limit', () => {
    expect(() => loadConfig({ JOB_STORAGE_BUCKET: 'private' })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ JOB_STORAGE_BUCKET: 'private', PUBLIC_ORIGIN: 'http://localhost:5173' })).toThrow(/HTTPS/);
    const config = loadConfig({ JOB_STORAGE_BUCKET: 'private', PUBLIC_ORIGIN: 'https://vatermark-9f27a.web.app' });
    expect(config.host).toBe('0.0.0.0'); expect(config.port).toBe(8080);
    expect(config.workerTimeoutMs).toBe(35_000); expect(config.maxUploadBytes).toBe(30 * 1024 * 1024);
    expect(() => loadConfig({ JOB_STORAGE_BUCKET: 'private', PUBLIC_ORIGIN: 'https://vatermark-9f27a.web.app', MAX_UPLOAD_BYTES: String(33 * 1024 * 1024) })).toThrow();
  });
});
