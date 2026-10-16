import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import type { AppConfig } from './config.js';

/** Vite's default deny list does not include our secret inventory or image
 * storage. Keep both HTTP path checks and Vite's own loader policy in place. */
const DEFAULT_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'];
const PRIVATE_DENY = ['**/.data/**', '**/*.inventory.json', '**/*.state.json', '**/certs/**'];
const normalized = (value: string) => path.resolve(value).replaceAll('\\', '/');
const escapedGlob = (value: string) => value.replace(/[()[\]{}!*?+@]/g, '\\$&');
function real(value: string) { try { return normalized(fs.realpathSync(value)); } catch { return normalized(value); } }
function inside(candidate: string, directory: string) {
  const lower = candidate.toLowerCase(); const parent = directory.toLowerCase();
  return lower === parent || lower.startsWith(`${parent}/`);
}
function privateName(candidate: string) {
  return /(?:^|\/)(?:\.data|\.git|certs)(?:\/|$)/i.test(candidate)
    || /(?:^|\/)\.env(?:\.[^/]*)?$/i.test(candidate)
    || /(?:^|\/)(?:\.npmrc|\.yarnrc\.yml)$/i.test(candidate)
    || /\.(?:inventory|state)\.json(?:\.[^/]*)?$/i.test(candidate)
    || /\.(?:crt|pem|key|p12|pfx|cer|der)$/i.test(candidate);
}
function decodedPath(url: string): string | undefined {
  let result = url.split(/[?#]/, 1)[0];
  for (let index = 0; index < 6; index++) {
    try {
      const next = decodeURIComponent(result);
      if (next === result) return /[\0\r\n]/.test(result) ? undefined : result.replaceAll('\\', '/').split(/[?#]/, 1)[0];
      result = next;
    } catch { return undefined; }
  }
  // Fail closed on excessive nested encoding rather than disagreeing with a
  // later middleware about which path the browser requested.
  return undefined;
}
export function devPrivateFiles(config: Pick<AppConfig, 'root' | 'dataDir' | 'gifts' | 'tlsCertPath' | 'tlsKeyPath'>) {
  const directories = [...new Set([normalized(config.dataDir), real(config.dataDir)])];
  const privateFiles = [config.gifts?.stateFile, config.tlsCertPath, config.tlsKeyPath].filter((value): value is string => !!value)
    .flatMap(value => [normalized(value), real(value)]);
  const deny = [...DEFAULT_DENY, ...PRIVATE_DENY,
    ...directories.flatMap(directory => [escapedGlob(directory), `${escapedGlob(directory)}/**`]),
    ...privateFiles.flatMap(filename => [escapedGlob(filename), `${escapedGlob(filename)}.*`])];
  function forbidden(candidate: string) {
    return privateName(candidate) || directories.some(directory => inside(candidate, directory))
      || privateFiles.some(filename => candidate.toLowerCase() === filename.toLowerCase()
        || candidate.toLowerCase().startsWith(`${filename.toLowerCase()}.`));
  }
  const middleware: RequestHandler = (req, res, next) => {
    const decoded = decodedPath(req.originalUrl || req.url);
    if (decoded !== undefined) {
      const candidate = decoded.startsWith('/@fs/')
        ? normalized(`/${decoded.slice('/@fs/'.length)}`) : normalized(path.resolve(config.root, `.${decoded}`));
      if (!forbidden(candidate) && !forbidden(real(candidate))) return next();
    }
    res.status(403).set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).type('text').send('Private file access is not permitted.');
  };
  return {
    middleware,
    // publicDir deliberately disabled by the caller: Vite serves it without
    // applying fs.deny. This app imports its public assets from source instead.
    fs: { strict: true, allow: [config.root], deny },
    watch: { ignored: deny },
  };
}
