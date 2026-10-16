import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';

// .dockerignore is not applied when a source archive is uploaded to Cloud Build.
// Build this separate allowlist so local keys and uploaded images never leave here.
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const envIndex = args.indexOf('--env-file');
const envFile = envIndex < 0 ? path.join(root, '.env') : args[envIndex + 1];
if (envIndex >= 0) args.splice(envIndex, 2);
const archive = path.resolve(args[0] || path.join(os.tmpdir(), `vatermark-source-${Date.now()}.tgz`));
const configured = fs.existsSync(envFile) ? parse(fs.readFileSync(envFile)) : {};
const protectedValues = ['VATERMARK_SERVICE_WIF', 'VATERMARK_SERVICE_ID'].map(key => configured[key]?.trim()).filter(Boolean);
const files = [];
const forbidden = /(^|\/)(\.env[^/]*|\.git|\.data|node_modules|target|certs)(\/|$)|\.(pem|key|p12|pfx|log)$/i;
function add(relative) {
  if (forbidden.test(relative)) throw new Error(`Private or generated file under source directory: ${relative}`);
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink rejected: ${relative}`);
  if (stat.isDirectory()) { for (const name of fs.readdirSync(absolute).sort()) add(`${relative}/${name}`); return; }
  if (!stat.isFile()) throw new Error(`Non-regular source input: ${relative}`);
  const data = fs.readFileSync(absolute);
  if (protectedValues.some(value => data.includes(Buffer.from(value)))) throw new Error(`Configured credential found in source input: ${relative}`);
  files.push(relative);
}
for (const name of ['Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'index.html', 'src', 'server', 'tests', 'scripts/gift-referrals.ts', 'scripts/gift-registration.ts', 'scripts/gift-commitment.ts', 'scripts/generate-gifts.ts', 'scripts/import-gifts.ts', 'engine/Cargo.toml', 'engine/Cargo.lock', 'engine/src', 'engine/tests/fixtures/mobile-profile.json']) add(name);
execFileSync('tar', ['-czf', archive, ...files], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'pipe' });
fs.chmodSync(archive, 0o600);
console.log(JSON.stringify({ archive, sourceFiles: files.length, credentialChecks: protectedValues.length, sizeBytes: fs.statSync(archive).size }));
