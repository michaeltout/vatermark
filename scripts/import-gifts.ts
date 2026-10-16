import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { GenericRequest, SpendableKeyDetailsOrdinalVDXFObject, nameAndParentAddrToIAddr } from 'verus-typescript-primitives';
import { atomicWritePrivate, deriveGiftAddress } from './generate-gifts.js';
import { GIFT_TESTNET_SYSTEM } from './gift-referrals.js';
import { CloudGiftStore, LocalGiftStore, importGiftInventory, validateGiftInventory, type GiftCard, type GiftInventory, type GiftState, type GiftStore } from '../server/gifts.js';
import { StoreConflict, type StoredObject } from '../server/cloud-store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultStateFile = path.join(root, '.data', 'gifts', 'state.json');
const require = createRequire(import.meta.url);
class ImportError extends Error {}
// Google Cloud project IDs are 6–30 lowercase letters, digits, or hyphens.
const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export interface ImportOptions { file: string; state?: string; cloud: boolean; project?: string; bucket?: string; excludeAssignedState?: string; exportUnassigned?: string; help: boolean }
export function importOptions(args: string[]): ImportOptions {
  const values: Record<string, string> = {};
  let cloud = false; let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { help = true; continue; }
    if (arg === '--cloud') { if (cloud) throw new ImportError('Duplicate --cloud option.'); cloud = true; continue; }
    if (!['--file', '--state', '--project', '--bucket', '--exclude-assigned-state', '--export-unassigned'].includes(arg) || values[arg] !== undefined
      || !args[i + 1] || args[i + 1].startsWith('--')) throw new ImportError('Invalid options. Use --help.');
    values[arg] = args[++i];
  }
  if (help) return { file: '', cloud, help };
  if (!values['--file']) throw new ImportError('--file is required.');
  if (cloud && (values['--state'] || !values['--project'] || !values['--bucket'])) {
    throw new ImportError('Cloud import requires --cloud --project PROJECT_ID --bucket NAME and cannot use --state.');
  }
  if (!cloud && (values['--project'] || values['--bucket'])) throw new ImportError('Cloud options require explicit --cloud.');
  if (cloud && !projectIdPattern.test(values['--project'])) throw new ImportError('Invalid Google Cloud project ID. Use the project ID, not its display name or number.');
  if (values['--export-unassigned'] && (!values['--exclude-assigned-state'] || cloud || values['--state'])) {
    throw new ImportError('--export-unassigned requires --exclude-assigned-state and cannot import to --cloud or --state.');
  }
  return { file: path.resolve(values['--file']), state: values['--state'] ? path.resolve(values['--state']) : defaultStateFile,
    cloud, project: values['--project'], bucket: values['--bucket'],
    excludeAssignedState: values['--exclude-assigned-state'] ? path.resolve(values['--exclude-assigned-state']) : undefined,
    exportUnassigned: values['--export-unassigned'] ? path.resolve(values['--export-unassigned']) : undefined, help };
}

const cardFields = ['id', 'identityName', 'identityId', 'address', 'walletUri', 'fundingTxid', 'registrationTxid', 'amount'] as const;
const sameCard = (a: GiftCard, b: GiftCard) => cardFields.every(field => a[field] === b[field]);
/** A local assignment is permanent, even if its browser cookie has expired. */
export function excludeAssignedGiftCards(inventory: GiftInventory, source: GiftState) {
  if (!source.batches.includes(inventory.batchId)) throw new ImportError('The exclusion state does not contain this batch. Import refused.');
  const local = new Map(source.cards.map(card => [card.id, card]));
  for (const card of inventory.cards) {
    const existing = local.get(card.id);
    if (!existing || !sameCard(existing, card)) throw new ImportError('The exclusion state must contain identical records for every input card. Import refused.');
  }
  const assigned = new Set(Object.values(source.assignments).map(item => item.cardId));
  const excluded = inventory.cards.filter(card => assigned.has(card.id));
  const filtered = { ...inventory, cards: inventory.cards.filter(card => !assigned.has(card.id)) };
  if (!filtered.cards.length) throw new ImportError('No unassigned cards remain. Nothing was exported or imported.');
  return { inventory: filtered, excluded };
}
/** Never reintroduce a locally issued card; preserve every destination assignment. */
export async function importUnassignedGiftInventory(store: GiftStore, inventory: GiftInventory, excluded: GiftCard[]) {
  const guarded: GiftStore = { read: () => store.read(), update: change => store.update(state => {
    if (state.cards.some(card => excluded.some(item => ['id', 'identityName', 'identityId', 'address', 'walletUri']
      .some(key => card[key as keyof GiftCard] === item[key as keyof GiftCard])))) {
      throw new ImportError('The destination already contains a locally assigned card. Import refused; reconcile the existing allocations before retrying.');
    }
    return change(state);
  }) };
  return importGiftInventory(guarded, inventory);
}
/** Refuse accidental re-import of local claims when the exclusion flag is omitted. */
export function assertNoLocalGiftOverlap(inventory: GiftInventory, source: GiftState) {
  if (source.batches.includes(inventory.batchId) || source.cards.some(card => inventory.cards.some(item =>
    ['id', 'identityName', 'identityId', 'address', 'walletUri'].some(key => card[key as keyof GiftCard] === item[key as keyof GiftCard])))) {
    throw new ImportError('This inventory was used locally. Disable local gift issuance and specify --exclude-assigned-state with its private runtime state.');
  }
}
/** Hold the existing source lock throughout snapshot filtering and destination write. */
async function withPrivateGiftState<T>(filename: string, action: (state: GiftState) => Promise<T>): Promise<T> {
  let metadata: fs.Stats;
  try { metadata = fs.lstatSync(filename); }
  catch { throw new ImportError('The private exclusion state must exist. Do not substitute an empty runtime state.'); }
  if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024 || (metadata.mode & 0o077)) {
    throw new ImportError('Use a private runtime state file (chmod 600) no larger than 32 MiB.');
  }
  const lockPath = `${filename}.lock`;
  let descriptor: number;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); }
  catch { throw new ImportError('The local inventory is busy. Stop local gift issuance before migrating; never remove another process\'s lock.'); }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); fs.fsyncSync(descriptor);
    return await action(await new LocalGiftStore(filename).read());
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lockPath); }
}

function firebaseToolsDirectory(): string {
  const override = process.env.FIREBASE_TOOLS_DIR;
  const candidates: string[] = override ? [path.resolve(override)] : [];
  if (!override) {
    for (const folder of (process.env.PATH || '').split(path.delimiter)) {
      try {
        let current = path.dirname(fs.realpathSync(path.join(folder, 'firebase')));
        for (let count = 0; count < 5; count++) { candidates.push(current); current = path.dirname(current); }
      } catch { /* Try the next PATH entry. */ }
    }
  }
  for (const directory of candidates) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === 'firebase-tools'
        && fs.existsSync(path.join(directory, 'lib', 'auth.js'))) return directory;
    } catch { /* Not a Firebase CLI package. */ }
  }
  throw new ImportError('Firebase CLI is required for cloud import. Add firebase to PATH or set FIREBASE_TOOLS_DIR.');
}
async function firebaseToken(): Promise<string> {
  try {
    const directory = firebaseToolsDirectory();
    // Never execute login:list: some CLI versions print refresh/access tokens.
    // Disable library logging before loading authentication helpers.
    const { logger } = require(path.join(directory, 'lib', 'logger.js'));
    logger.silent = true;
    const auth = require(path.join(directory, 'lib', 'auth.js'));
    const account = auth.getProjectDefaultAccount(root);
    if (!account?.tokens?.refresh_token) throw new Error();
    const tokens = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token) throw new Error();
    return tokens.access_token;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('Firebase authentication failed. Run firebase login --reauth, then retry.');
  }
}
type CloudFetch = (url: string, options?: RequestInit) => Promise<Response>;
function authorizedFetch(token: string): CloudFetch {
  return (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000), redirect: 'error' });
}
async function jsonResponse(response: Response): Promise<any> {
  if (!response.ok) throw new ImportError(`Cloud storage operation failed (HTTP ${response.status}). No response details were logged.`);
  return response.json();
}
/** Gift assignments must outlive the short-lived image jobs stored in this bucket. */
export function assertGiftLifecycleSafe(value: unknown): void {
  if (value === undefined) return;
  const object = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const fail = () => { throw new ImportError('Bucket lifecycle rules could delete permanent gift inventory or are not recognized. Restrict deletion to jobs/ before importing.'); };
  if (!object(value) || Object.keys(value).some(key => key !== 'rule') || !Array.isArray(value.rule)) return fail();
  const fields = new Set(['age', 'createdBefore', 'isLive', 'matchesStorageClass', 'numNewerVersions', 'daysSinceCustomTime',
    'customTimeBefore', 'daysSinceNoncurrentTime', 'noncurrentTimeBefore', 'matchesPrefix', 'matchesSuffix']);
  const target = 'gifts/state-v1.json';
  for (const rule of value.rule) {
    if (!object(rule) || Object.keys(rule).some(key => !['action', 'condition'].includes(key)) || !object(rule.action)
      || !object(rule.condition) || Object.keys(rule.action).some(key => !['type', 'storageClass'].includes(key))
      || !['Delete', 'SetStorageClass', 'AbortIncompleteMultipartUpload'].includes(String(rule.action.type))
      || Object.keys(rule.condition).some(key => !fields.has(key))) return fail();
    for (const key of ['matchesPrefix', 'matchesSuffix']) {
      const constraint = rule.condition[key];
      if (constraint !== undefined && (!Array.isArray(constraint) || constraint.some(item => typeof item !== 'string'))) return fail();
    }
    if (rule.action.type !== 'Delete') continue;
    const prefixes = rule.condition.matchesPrefix as string[] | undefined;
    const suffixes = rule.condition.matchesSuffix as string[] | undefined;
    const prefixMatches = !prefixes?.length || prefixes.some(prefix => target.startsWith(prefix));
    const suffixMatches = !suffixes?.length || suffixes.some(suffix => target.endsWith(suffix));
    if (prefixMatches && suffixMatches) return fail();
  }
}
/** Refuse public storage or a bucket belonging to another project before writing. */
export async function verifyPrivateGiftBucket(project: string, bucket: string, fetcher: CloudFetch) {
  if (!projectIdPattern.test(project) || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new ImportError('Invalid Google Cloud project ID or bucket name.');
  const projectInfo = await jsonResponse(await fetcher(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}`));
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`;
  const metadata = await jsonResponse(await fetcher(url));
  if (!projectInfo.projectNumber || String(metadata.projectNumber) !== String(projectInfo.projectNumber)
    || metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
    || metadata.iamConfiguration?.publicAccessPrevention !== 'enforced') {
    throw new ImportError('The destination must belong to the selected project and enforce uniform access and public access prevention.');
  }
  assertGiftLifecycleSafe(metadata.lifecycle);
  const policy = await jsonResponse(await fetcher(`${url}/iam`));
  if (!Array.isArray(policy.bindings) || policy.bindings.some((binding: { members?: string[] }) => !Array.isArray(binding.members)
    || binding.members.some(member => member === 'allUsers' || member === 'allAuthenticatedUsers'))) {
    throw new ImportError('The gift bucket has public or unreadable access rules. Import refused.');
  }
}
/** Firebase CLI credentials stay in memory; generation CAS preserves active claims. */
export class FirebaseGiftObjects {
  constructor(private bucket: string, private fetcher: CloudFetch) {}
  private url(name: string) { return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}`; }
  async read(name: string): Promise<StoredObject | undefined> {
    const response = await this.fetcher(this.url(name));
    if (response.status === 404) return undefined;
    const metadata = await jsonResponse(response);
    const revision = String(metadata.generation || '');
    if (!/^\d+$/.test(revision)) throw new ImportError('Cloud object generation is missing.');
    const media = await this.fetcher(`${this.url(name)}?alt=media&generation=${revision}`);
    if (!media.ok) throw new ImportError('The private inventory could not be read at its pinned generation. Retry the import.');
    return { data: Buffer.from(await media.arrayBuffer()), revision };
  }
  async write(name: string, data: Buffer, revision: string | 0): Promise<string> {
    if (!/^\d+$/.test(String(revision))) throw new ImportError('Invalid cloud object generation.');
    const boundary = `vatermark-${randomBytes(16).toString('hex')}`;
    const metadata = { name, contentType: 'application/json', cacheControl: 'private, no-store' };
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await this.fetcher(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=multipart&ifGenerationMatch=${revision}`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body) });
    if (response.status === 412) throw new StoreConflict();
    const stored = await jsonResponse(response);
    if (!/^\d+$/.test(String(stored.generation || ''))) throw new ImportError('Cloud import acknowledgement is missing. Retry safely.');
    return String(stored.generation);
  }
}

export async function runGiftImport(args = process.argv.slice(2)) {
  const options = importOptions(args);
  if (options.help) {
    process.stdout.write('Usage:\n  tsx scripts/import-gifts.ts --file PRIVATE_BATCH.json [--state PRIVATE_STATE.json]\n  tsx scripts/import-gifts.ts --file PRIVATE_BATCH.json --exclude-assigned-state PRIVATE_STATE.json --export-unassigned PRIVATE_HOSTED.inventory.json\n  tsx scripts/import-gifts.ts --file PRIVATE_BATCH.json --exclude-assigned-state PRIVATE_STATE.json --cloud --project PROJECT_ID --bucket PRIVATE_BUCKET\n\nLocal is the default. Stop local gift issuance before migration and leave it disabled. --export-unassigned writes only a private filtered file. --cloud explicitly writes private inventory only; it never deploys code or changes IAM. Existing destination claims are preserved.\n');
    return;
  }
  const stat = fs.statSync(options.file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o077)) throw new ImportError('Use a private inventory file (chmod 600) no larger than 16 MiB.');
  const inventory = validateGiftInventory(JSON.parse(fs.readFileSync(options.file, 'utf8')));
  const parentId = GIFT_TESTNET_SYSTEM;
  for (const card of inventory.cards) {
    const request = GenericRequest.fromWalletDeeplinkUri(card.walletUri);
    const entropy = (request.details[0] as SpendableKeyDetailsOrdinalVDXFObject).data.data;
    if (deriveGiftAddress(entropy) !== card.address
      || nameAndParentAddrToIAddr(card.identityName.split('.')[0], parentId) !== card.identityId) {
      throw new ImportError('A gift key/address or identity name/id does not match. Import refused.');
    }
  }
  if (options.exportUnassigned && [options.file, options.excludeAssignedState].includes(options.exportUnassigned)) {
    throw new ImportError('The filtered export must not overwrite the original inventory or exclusion state.');
  }
  if (!options.cloud && !options.exportUnassigned && [options.file, options.excludeAssignedState].includes(options.state)) {
    throw new ImportError('The input batch, exclusion state, and destination must use different files.');
  }
  const perform = async (candidate: GiftInventory, excluded: GiftCard[]) => {
    if (options.exportUnassigned) {
      await atomicWritePrivate(options.exportUnassigned, candidate);
      process.stdout.write(`${JSON.stringify({ exported: candidate.cards.length, excluded: excluded.length, destination: options.exportUnassigned })}\n`);
      return;
    }
    let result: { added: number; total: number };
    if (options.cloud) {
      const fetcher = authorizedFetch(await firebaseToken());
      await verifyPrivateGiftBucket(options.project!, options.bucket!, fetcher);
      result = await importUnassignedGiftInventory(new CloudGiftStore(new FirebaseGiftObjects(options.bucket!, fetcher)), candidate, excluded);
    } else {
      result = await importUnassignedGiftInventory(new LocalGiftStore(options.state!), candidate, excluded);
    }
    process.stdout.write(`${JSON.stringify({ ...result, excluded: excluded.length, destination: options.cloud ? 'private Firebase inventory' : options.state })}\n`);
  };
  if (options.excludeAssignedState) {
    await withPrivateGiftState(options.excludeAssignedState, async source => {
      const filtered = excludeAssignedGiftCards(inventory, source);
      await perform(filtered.inventory, filtered.excluded);
    });
  } else {
    if (options.cloud && fs.existsSync(defaultStateFile)) {
      await withPrivateGiftState(defaultStateFile, async source => { assertNoLocalGiftOverlap(inventory, source); });
    }
    await perform(inventory, []);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGiftImport().catch(error => {
    // RPC, OAuth, JSON parser, and storage errors may embed secret data. Only
    // messages created by this CLI are safe to print; never dump error objects.
    process.stderr.write(`${error instanceof ImportError ? error.message : 'Gift import failed. Check the private file, schema, permissions, and destination; no secret details were logged.'}\n`);
    process.exitCode = 1;
  });
}
