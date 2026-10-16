import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, isFileLoadingAllowed } from 'vite';
import { devPrivateFiles } from '../server/dev-private-files.js';
import type { GiftConfig } from '../server/gifts.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  // Never fetch a real journal: every denied file contains only this canary.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-private-serving-test-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'site'); fs.mkdirSync(root);
  const dataDir = path.join(root, 'custom storage [private]');
  const outsideState = path.join(directory, 'external-secret-state');
  const certPath = path.join(root, 'private-tls-certificate');
  const keyPath = path.join(root, 'private-tls-secret');
  const marker = 'SYNTHETIC_PRIVATE_CANARY_DO_NOT_SERVE';
  const sensitive = [path.join(root, '.data', 'gift-batches', 'batch.state.json'), path.join(dataDir, 'image.png'),
    path.join(root, 'batch.inventory.json'), outsideState, `${outsideState}.temporary`, certPath, keyPath,
    path.join(root, '.env'), path.join(root, '.env.local'), path.join(root, 'secret.key'),
    path.join(root, '.git', 'config'), path.join(root, 'certs', 'unexpected-name'), path.join(root, 'public', 'batch.inventory.json')];
  for (const filename of sensitive) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, marker, { mode: 0o600 }); }
  fs.writeFileSync(path.join(root, 'ordinary.txt'), 'public asset is readable');
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>Public app</body></html>');
  fs.symlinkSync(path.join(dataDir, 'image.png'), path.join(root, 'harmless-looking.txt'));
  const protection = devPrivateFiles({ root, dataDir, gifts: { stateFile: outsideState } as GiftConfig, tlsCertPath: certPath, tlsKeyPath: keyPath });
  const vite = await createServer({ configFile: false, root, publicDir: false, logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, fs: protection.fs, watch: protection.watch },
    optimizeDeps: { noDiscovery: true, entries: [] }, appType: 'spa' });
  cleanup.push(() => vite.close());
  const app = express(); app.use(protection.middleware); app.use(vite.middlewares);
  return { app, vite, root, marker, dataDir, outsideState, certPath, keyPath, sensitive, protection };
}

describe('private files behind the real Vite dev middleware', () => {
  it('blocks private storage via ordinary, @fs, encoded, raw, import, and URL requests', async () => {
    const f = await fixture();
    const privateFile = path.join(f.root, '.data/gift-batches/batch.state.json');
    const paths = ['/.data/gift-batches/batch.state.json', '/%2edata/gift-batches/batch.state.json',
      '/%252edata/gift-batches/batch.state.json', '/.DATA/gift-batches/batch.state.json',
      '/safe/../.data/gift-batches/batch.state.json', `/.data/gift-batches/batch.state.json%3Fraw`,
      `/@fs/${privateFile}`, `/@fs/${encodeURIComponent(privateFile)}`, `/%40fs/${privateFile}`,
      '/batch.inventory.json', '/public/batch.inventory.json', '/harmless-looking.txt'];
    for (const pathname of paths) for (const suffix of ['', '?raw', '?import&raw??', '?url&import']) {
      const response = await request(f.app).get(`${pathname}${suffix}`);
      expect(response.status, `${pathname}${suffix}`).toBe(403);
      expect(response.text).not.toContain(f.marker);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
  it('protects custom directories, exact outside-root state paths, temp siblings, and configured certificate files', async () => {
    const f = await fixture();
    for (const filename of f.sensitive) {
      const response = await request(f.app).get(`/@fs/${encodeURI(filename)}?raw`);
      expect(response.status, filename).toBe(403); expect(response.text).not.toContain(f.marker);
      // Defense in depth: Vite's loader policy also rejects the original
      // absolute file independently of the pre-middleware HTTP guard.
      expect(isFileLoadingAllowed(f.vite.config, filename), filename).toBe(false);
    }
    const alternate = await request(f.app).get('/custom%20storage%20%5Bprivate%5D/image.png?raw');
    expect(alternate.status).toBe(403); expect(alternate.text).not.toContain(f.marker);
  });
  it('retains normal source/static loading and fails malformed encodings closed without revealing paths', async () => {
    const f = await fixture();
    const publicFile = await request(f.app).get('/ordinary.txt').expect(200);
    expect(publicFile.text).toContain('public asset is readable');
    const rawFile = await request(f.app).get('/ordinary.txt?raw').expect(200);
    expect(rawFile.text).toContain('public asset is readable');
    for (const pathname of ['/%ZZ', '/.data%00/secret', '/%252525252525252edata/secret']) {
      const response = await request(f.app).get(pathname).expect(403);
      expect(response.text).toBe('Private file access is not permitted.');
      expect(response.text).not.toContain(f.root);
    }
    expect(f.vite.config.publicDir).toBe('');
    expect(f.protection.fs.strict).toBe(true);
  });
});
