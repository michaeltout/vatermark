import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import express from 'express';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { devPrivateFiles } from './dev-private-files.js';

const config = loadConfig();
const { app, close } = await createApp(config);
if (!!config.tlsCertPath !== !!config.tlsKeyPath) throw new Error('Set both TLS_CERT_PATH and TLS_KEY_PATH for HTTPS.');
const server = config.tlsCertPath && config.tlsKeyPath
  ? https.createServer({ cert: fs.readFileSync(config.tlsCertPath), key: fs.readFileSync(config.tlsKeyPath) }, app)
  : http.createServer(app);
let closeVite: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const privateFiles = devPrivateFiles(config);
  // This guard must precede Vite's raw-file and transform middleware.
  app.use(privateFiles.middleware);
  const vite = await createServer({ root: config.root, publicDir: false, server: {
    fs: privateFiles.fs, watch: privateFiles.watch,
    middlewareMode: true, hmr: { server },
    allowedHosts: config.publicOrigin ? [new URL(config.publicOrigin).hostname] : [],
  }, appType: 'spa' });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
} else {
  app.use(express.static(path.join(config.root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(config.root, 'dist/index.html')));
}
server.requestTimeout = 120_000;
server.listen(config.port, config.host, () => {
  const scheme = config.tlsCertPath ? 'https' : 'http';
  console.log(`Vatermark is running at ${scheme}://${config.host}:${config.port}`);
  console.log(`Network: VRSCTEST. ${config.jobStorageBucket ? 'Private cloud' : 'Local'} image storage.`);
});
async function shutdown() {
  server.close();
  await close();
  await closeVite?.();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
