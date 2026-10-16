import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../server/app.js';
import { loadConfig, type AppConfig } from '../../server/config.js';
import { WorkerError, type Worker } from '../../server/worker.js';
import { GENERIC_RESPONSE_QUERY_KEY, TESTNET_SYSTEM_ID, VerusAdapter, VerusError, type RustIdentity } from '../../server/verus.js';
import { CASE_STATEMENT } from '../../server/cases/verus.js';
import { SCHEMA, ZERO_HASH, parseStatement, type CaseView, type ExportPackage } from '../../server/cases/protocol.js';
import { verifyPackage } from '../../server/cases/verify-package.js';

// Case workflow API behaviour through the real app with a mocked image worker
// and a chain adapter double that provides the Cases methods. Real
// serialization and signature tests are in tests/cases/verus.test.ts.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const alice = { id: 'i3kT4uvcakroae5k6cLtWrG6BX34gAzxCp', name: 'alice' };
const bob = { id: 'iBobCustodyTestJdentityAbcdefghjk2', name: 'bob' };
const carol = { id: 'iCaroWorkfowTestJdentityAbcdefghj3', name: 'carol' };
const service = { id: 'iServiceJdentityForTestsAbcdefghj4', name: 'service' };
const people = [alice, bob, carol, service];
const FILL: Record<string, number> = { [alice.id]: 0x11, [bob.id]: 0x22, [carol.id]: 0x33, [service.id]: 0x55 };
const TIP = 5000;
const BLOCK_HASH = 'ab'.repeat(32);
function native(fill: number, height: number) {
  const h = Buffer.alloc(4); h.writeUInt32LE(height);
  return Buffer.concat([Buffer.from([2, 5]), h, Buffer.from([1, 65, 27]), Buffer.alloc(64, fill)]).toString('base64');
}
function decodeNative(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  return { height: bytes.readUInt32LE(2), signer: people.find(p => FILL[p.id] === bytes[9]) };
}
const record = (who: { id: string; name: string }, height: number, keys = ['RLocalKeyAlpha']) => ({
  identity: { identityaddress: who.id, name: who.name, systemid: TESTNET_SYSTEM_ID, version: 3, flags: 0, minimumsignatures: 1, primaryaddresses: keys },
  status: 'active', blockheight: height,
});
const rustIdentity = (height: number): RustIdentity => ({ id: Array(20).fill(3), system_id: Array(20).fill(4), testnet: true, height, min_sigs: 1, revoked: false, primary_addresses: ['RLocalKeyAlpha'] });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(overrides: Partial<AppConfig> = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatermark-cases-test-'));
  const dataDir = path.join(tempDir, '.data');
  const config = { ...loadConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'https://cases.example.test', VATERMARK_SERVICE_ID: service.id, VATERMARK_SERVICE_WIF: 'local-mock-secret-never-share' }), ...overrides };
  const workerRun = vi.fn(async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (command.cmd === 'inspect') throw new WorkerError('no_watermark', 'No supported watermark frame');
    throw new Error(`Unexpected worker command ${command.cmd}`);
  });
  let signer = alice;
  let signingHeight = TIP;
  let currentKeys: Record<string, string[]> = {};
  const adapter = {
    status: vi.fn(async (): Promise<{ enabled: boolean; reason?: string }> => ({ enabled: true })),
    resolveIdentity: vi.fn(async () => ({ identity: rustIdentity(TIP), currentActive: true, displayIdentity: { id: alice.id, name: alice.name, systemId: TESTNET_SYSTEM_ID, signingHeight: TIP, currentStatus: 'active' } })),
    createCaseRequest: vi.fn(async (input: { message: string }) => ({ requestHex: 'aabbcc', requestHashHex: 'ee'.repeat(32), walletUri: `verus://1/mock?${encodeURIComponent(input.message).slice(0, 40)}` })),
    verifyCaseResponse: vi.fn(async () => {
      const who = signer; const height = signingHeight;
      return { identityId: who.id, systemId: TESTNET_SYSTEM_ID, nativeSignature: native(FILL[who.id], height), identity: rustIdentity(height),
        displayIdentity: { id: who.id, name: who.name, systemId: TESTNET_SYSTEM_ID, signingHeight: height, currentStatus: 'active' } };
    }),
    identityEvidence: vi.fn(async (identityId: string, height: number) => {
      const who = people.find(p => p.id === identityId) ?? alice;
      return { atHeight: record(who, height), current: record(who, TIP, currentKeys[who.id]) };
    }),
    lookupIdentity: vi.fn(async (query: string) => {
      const known = people.find(who => who.name === query || `${who.name}@` === query || who.id === query);
      if (!known) throw new VerusError('CHAIN_UNAVAILABLE', 'That identity was not found on VRSCTEST, or the chain service is unavailable.');
      return { ...known, active: true };
    }),
    verifyStatement: vi.fn(async (input: { identityId: string; statement: string; nativeSignature: string; record?: unknown }) => {
      const { height, signer: who } = decodeNative(input.nativeSignature);
      const valid = !!who && who.id === input.identityId;
      return { valid, height, currentActive: input.record ? undefined : true, name: who?.name, record: input.record ?? record(who ?? alice, height),
        current: input.record ? undefined : record(who ?? alice, TIP, who ? currentKeys[who.id] : undefined), source: input.record ? 'supplied' as const : 'chain' as const };
    }),
    chainBlock: vi.fn(async (height?: number) => ({ height: height ?? TIP, hash: height === undefined || height === TIP ? BLOCK_HASH : 'cd'.repeat(32), time: 1_760_000_000 })),
    signStatement: vi.fn(async () => ({ native: native(FILL[service.id], TIP), identityId: service.id, name: service.name, height: TIP })),
  };
  const worker = { run: workerRun } as unknown as Worker;
  const created = await createApp(config, { worker, adapter: adapter as unknown as VerusAdapter });
  cleanups.push(async () => { await created.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const owner = request.agent(created.app);
  const stranger = request.agent(created.app);
  await owner.get('/api/config').expect(200);
  await stranger.get('/api/config').expect(200);
  return { ...created, owner, stranger, config, dataDir, workerRun, adapter,
    signAs: (who: typeof alice, height = TIP) => { signer = who; signingHeight = height; },
    rotateKeys: (who: typeof alice, keys: string[]) => { currentKeys = { ...currentKeys, [who.id]: keys }; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const attestationId = (f: Fixture) => {
  const calls = f.adapter.createCaseRequest.mock.calls as Array<[{ callbackUrl: string; message: string }]>;
  const input = calls.at(-1)![0];
  return { id: /attestations\/([a-f0-9]{32})\/response$/.exec(input.callbackUrl)![1], message: input.message };
};
const sign = (f: Fixture, id: string, body: string) =>
  request(f.app).post(`/api/cases/attestations/${id}/response`).set('Content-Type', 'application/octet-stream').send(Buffer.from(body));
async function draft(f: Fixture): Promise<CaseView> {
  const response = await f.owner.post('/api/cases').attach('image', png, { filename: 'retina-od.png', contentType: 'image/png' });
  expect(response.status, response.text).toBe(201);
  return response.body;
}
async function step(f: Fixture, number: string, body: Record<string, unknown>, agent = f.owner): Promise<CaseView> {
  const response = await agent.post(`/api/cases/${number}/steps`).send(body);
  expect(response.status, response.text).toBe(201);
  return response.body;
}
async function signedStep(f: Fixture, number: string, body: Record<string, unknown>, who: typeof alice, text = `${who.name} signs ${body.type}`): Promise<CaseView> {
  await step(f, number, body);
  f.signAs(who);
  await sign(f, attestationId(f).id, text).expect(200);
  return (await f.owner.get(`/api/cases/${number}`).expect(200)).body;
}
async function opened(f: Fixture): Promise<CaseView> {
  const created = await draft(f);
  return signedStep(f, created.number, { type: 'CASE_CREATED', actor: 'alice@' }, alice);
}

describe('opening a case', () => {
  it('keeps only the artifact manifest, names the opener, and accepts only that identity’s signature', async () => {
    const f = await fixture();
    const created = await draft(f);
    expect(created.number).toMatch(/^VC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(created.status).toBe('draft');
    expect(created.artifact).toMatchObject({ digestAlgorithm: 'sha-256', bytes: png.length, mediaType: 'image/png', width: 1, height: 1 });
    expect(created.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(created)).not.toContain('retina-od');
    expect(created.actions).toEqual([{ type: 'CASE_CREATED', signers: 'any' }]);
    expect(created.isCreator).toBe(true);
    expect(fs.readdirSync(path.join(f.dataDir, 'uploads'))).toEqual([]);
    expect((await f.owner.post(`/api/cases/${created.number}/steps`).send({ type: 'CASE_CREATED' })).status).toBe(400);
    expect((await f.owner.post(`/api/cases/${created.number}/steps`).send({ type: 'CASE_CREATED', actor: 'nobody@' })).status).toBe(503);
    const pending = await step(f, created.number, { type: 'CASE_CREATED', actor: 'alice@' });
    expect(pending.pending).toMatchObject({ type: 'CASE_CREATED', expectedSigner: { id: alice.id, name: 'alice' }, proposedHere: true });
    expect(pending.pending!.walletUri).toContain('verus://1/');
    const issued = attestationId(f);
    expect(issued.message).toMatch(CASE_STATEMENT);
    const fields = parseStatement(issued.message)!;
    expect(fields).toMatchObject({ type: 'CASE_CREATED', case: created.number, seq: 1, prev: ZERO_HASH, artifact: created.artifact.digest, actor: alice.id, actorName: 'alice@', policy: created.policy.id, policyHash: created.policy.hash, block: { height: TIP, hash: BLOCK_HASH } });
    expect(issued.message.split('\n')[1]).toBe('I open this case and take ownership of its workflow.');
    expect(f.adapter.createCaseRequest).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: `https://cases.example.test/api/cases/attestations/${issued.id}/response`, requestIdHex: fields.nonce }));
    // Anyone with the number sees the step and the statement; nobody else can withdraw it.
    const seen = await f.stranger.get(`/api/cases/${created.number}`).expect(200);
    expect(seen.body.pending.statement).toBe(issued.message);
    expect(seen.body.pending.proposedHere).toBe(false);
    expect(seen.body.isCreator).toBe(false);
    expect((await f.stranger.delete(`/api/cases/${created.number}/step`)).status).toBe(403);
    f.signAs(bob);
    const wrong = await sign(f, issued.id, 'bob signs');
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('WRONG_IDENTITY');
    f.signAs(alice, TIP - 50);
    const stale = await sign(f, issued.id, 'alice signs with an old height');
    expect(stale.status).toBe(422);
    expect(stale.body.error.code).toBe('STALE_SIGNATURE');
    f.signAs(alice, TIP - 3);
    await sign(f, issued.id, 'alice signs').expect(200);
    const open = (await f.owner.get(`/api/cases/${created.number}`).expect(200)).body as CaseView;
    expect(open.status).toBe('open');
    expect(open.owner).toEqual({ id: alice.id, name: 'alice@' });
    expect(open.pending).toBeUndefined();
    expect(open.events).toHaveLength(1);
    expect(open.events[0]).toMatchObject({ seq: 1, type: 'CASE_CREATED', actor: { id: alice.id, name: 'alice@' }, prev: ZERO_HASH, signingHeight: TIP - 3, keyState: 'unchanged', anchor: { status: 'pending' } });
    expect(open.events[0].anchor.detail).toMatch(/not configured/);
    expect(open.headHash).toBe(open.events[0].hash);
    expect(open.actions.map(a => a.type)).toEqual(['TASK_ASSIGNED', 'CASE_CLOSED']);
    expect((await sign(f, issued.id, 'alice signs')).status).toBe(200); // exact retry
    expect((await sign(f, issued.id, 'something else')).status).toBe(409);
    expect((await f.owner.get(`/api/cases/${created.number.toLowerCase().replace(/-/g, '')}`)).body.number).toBe(created.number);
    await f.owner.get('/api/cases/VC-0000-0000-0000').expect(404);
  });

  it('finds a case from the exact artifact bytes and offers a ticket for unknown files', async () => {
    const f = await fixture();
    const open = await opened(f);
    const found = await f.stranger.post('/api/cases/check').attach('image', png, 'copy.png').expect(200);
    expect(found.body.cases).toEqual([open.number]);
    expect(found.body.ticket).toBeUndefined();
    expect(found.body.artifact.digest).toBe(open.artifact.digest);
    const other = await f.owner.post('/api/cases/check').attach('image', Buffer.concat([png, Buffer.from([0])]), 'other.png').expect(200);
    expect(other.body.cases).toEqual([]);
    expect(other.body.ticket.id).toMatch(/^[a-f0-9]{32}$/);
    expect(other.body.derivative).toBeUndefined();
    expect(f.workerRun).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'inspect' }));
    expect((await f.stranger.post('/api/cases/from-ticket').send({ ticket: other.body.ticket.id })).status).toBe(404);
    const fromTicket = await f.owner.post('/api/cases/from-ticket').send({ ticket: other.body.ticket.id });
    expect(fromTicket.status, fromTicket.text).toBe(201);
    expect(fromTicket.body.status).toBe('draft');
    expect(fromTicket.body.artifact.digest).toBe(other.body.artifact.digest);
    expect((await f.owner.post('/api/cases/from-ticket').send({ ticket: other.body.ticket.id })).status).toBe(404);
  });
});

describe('assignment, acceptance, hand-off and completion', () => {
  it('walks the responsibility chain with the right signer at every step', async () => {
    const f = await fixture();
    const open = await opened(f);
    const n = open.number;
    expect((await f.owner.post(`/api/cases/${n}/steps`).send({ type: 'TASK_ACCEPTED' })).status).toBe(409);
    expect((await f.owner.post(`/api/cases/${n}/steps`).send({ type: 'TASK_ASSIGNED' })).status).toBe(400);
    expect((await f.owner.post(`/api/cases/${n}/steps`).send({ type: 'TASK_ASSIGNED', to: 'bob', deadline: '2020-01-01T00:00:00Z' })).status).toBe(400);
    const proposed = await step(f, n, { type: 'TASK_ASSIGNED', to: 'bob', deadline: '2030-01-01T09:00:00Z' });
    expect(proposed.pending).toMatchObject({ type: 'TASK_ASSIGNED', expectedSigner: { id: alice.id }, to: { id: bob.id, name: 'bob' }, deadline: '2030-01-01T09:00:00Z' });
    const assignStatement = attestationId(f).message;
    expect(assignStatement).toContain(`\nto:${bob.id}\nto-name:bob@\n`);
    expect(assignStatement).toContain('\ndeadline:2030-01-01T09:00:00Z\n');
    expect(parseStatement(assignStatement)!.prev).toBe(open.headHash);
    f.signAs(bob);
    expect((await sign(f, attestationId(f).id, 'bob signs the assignment')).body.error.code).toBe('WRONG_IDENTITY');
    f.signAs(alice);
    await sign(f, attestationId(f).id, 'alice assigns').expect(200);
    let view = (await f.stranger.get(`/api/cases/${n}`).expect(200)).body as CaseView;
    expect(view).toMatchObject({ status: 'assigned', assignee: { id: bob.id, name: 'bob@' }, openTask: { to: { id: bob.id }, by: { id: alice.id }, deadline: '2030-01-01T09:00:00Z' } });
    expect(view.actions.map(a => a.type)).toEqual(['TASK_ASSIGNED', 'TASK_ACCEPTED', 'TASK_REJECTED', 'TASK_WITHDRAWN']);
    // Bob accepts; Alice cannot accept for him.
    await step(f, n, { type: 'TASK_ACCEPTED' }, f.stranger);
    f.signAs(alice);
    expect((await sign(f, attestationId(f).id, 'alice accepts for bob')).body.error.code).toBe('WRONG_IDENTITY');
    f.signAs(bob);
    await sign(f, attestationId(f).id, 'bob accepts').expect(200);
    view = (await f.stranger.get(`/api/cases/${n}`).expect(200)).body;
    expect(view).toMatchObject({ status: 'accepted', responsible: { id: bob.id, name: 'bob@' } });
    expect(view.assignee).toBeUndefined();
    expect(view.actions.find(a => a.type === 'TASK_ASSIGNED')!.signers).toEqual([{ id: alice.id, name: 'alice@' }, { id: bob.id, name: 'bob@' }]);
    expect((await f.owner.post(`/api/cases/${n}/steps`).send({ type: 'CASE_CLOSED' })).status).toBe(409);
    // Two identities are entitled to assign now: the proposer must say which one signs.
    expect((await f.owner.post(`/api/cases/${n}/steps`).send({ type: 'TASK_ASSIGNED', to: 'carol' })).status).toBe(409);
    expect((await f.owner.post(`/api/cases/${n}/steps`).send({ type: 'TASK_ASSIGNED', to: 'carol', actor: 'carol@' })).status).toBe(422);
    view = await signedStep(f, n, { type: 'TASK_ASSIGNED', to: 'carol', actor: 'bob@' }, bob);
    expect(view).toMatchObject({ status: 'assigned', assignee: { id: carol.id }, responsible: { id: bob.id } });
    expect(attestationId(f).message).toContain(`\nactor:${bob.id}\nactor-name:bob@\nto:${carol.id}\n`);
    // Carol declines: Bob stays responsible and the case is back in review.
    view = await signedStep(f, n, { type: 'TASK_REJECTED' }, carol);
    expect(view).toMatchObject({ status: 'accepted', responsible: { id: bob.id } });
    expect(view.assignee).toBeUndefined();
    view = await signedStep(f, n, { type: 'REVIEW_COMPLETED' }, bob);
    expect(view.status).toBe('completed');
    expect(view.events.at(-1)).toMatchObject({ type: 'REVIEW_COMPLETED', actor: { id: bob.id }, task: view.events[1].task });
    view = await signedStep(f, n, { type: 'CASE_CLOSED' }, alice);
    expect(view.status).toBe('closed');
    expect(view.actions.map(a => a.type)).toEqual(['CASE_REOPENED']);
    view = await signedStep(f, n, { type: 'CASE_REOPENED' }, alice);
    expect(view.status).toBe('reopened');
    expect(view.events.map(e => e.type)).toEqual(['CASE_CREATED', 'TASK_ASSIGNED', 'TASK_ACCEPTED', 'TASK_ASSIGNED', 'TASK_REJECTED', 'REVIEW_COMPLETED', 'CASE_CLOSED', 'CASE_REOPENED']);
    for (let i = 1; i < view.events.length; i++) expect(view.events[i].prev).toBe(view.events[i - 1].hash);
    expect(view.events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('lets the owner withdraw an unanswered request, replaces a pending step with a newer proposal, and expires steps', async () => {
    const f = await fixture();
    const open = await opened(f);
    const n = open.number;
    let view = await signedStep(f, n, { type: 'TASK_ASSIGNED', to: 'bob' }, alice);
    const first = attestationId(f);
    view = await signedStep(f, n, { type: 'TASK_WITHDRAWN' }, alice);
    expect(view.status).toBe('rejected');
    expect(view.events.at(-1)).toMatchObject({ type: 'TASK_WITHDRAWN', to: { id: bob.id }, task: view.events[1].task });
    expect(attestationId(f).message).not.toBe(first.message);
    // A newer proposal replaces an unsigned step; the old request can no longer be used.
    await step(f, n, { type: 'TASK_ASSIGNED', to: 'bob' });
    const superseded = attestationId(f);
    await step(f, n, { type: 'TASK_ASSIGNED', to: 'carol' }, f.stranger);
    f.signAs(alice);
    expect((await sign(f, superseded.id, 'alice signs the superseded request')).status).toBe(409);
    const current = (await f.owner.get(`/api/cases/${n}`).expect(200)).body as CaseView;
    expect(current.pending!.to).toMatchObject({ id: carol.id });
    expect(current.pending!.proposedHere).toBe(false);
    expect((await f.owner.delete(`/api/cases/${n}/step`)).status).toBe(403);
    expect((await f.stranger.delete(`/api/cases/${n}/step`)).status).toBe(200);
    expect((await f.owner.get(`/api/cases/${n}`)).body.pending).toBeUndefined();
    await step(f, n, { type: 'TASK_ASSIGNED', to: 'bob' });
    const file = path.join(f.dataDir, 'cases', `${n}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.pending.expiresAt = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    expect((await f.owner.get(`/api/cases/${n}`)).body.pending).toBeUndefined();
    expect((await sign(f, attestationId(f).id, 'alice signs too late')).status).toBe(409);
  });

  it('refuses steps when the service identity is not configured', async () => {
    const f = await fixture();
    const created = await draft(f);
    f.adapter.status.mockResolvedValue({ enabled: false, reason: 'No service key' });
    const response = await f.owner.post(`/api/cases/${created.number}/steps`).send({ type: 'CASE_CREATED', actor: 'alice@' });
    expect(response.status).toBe(503);
    expect(f.adapter.createCaseRequest).not.toHaveBeenCalled();
  });
});

describe('export package and independent verification', () => {
  async function exported(f: Fixture, n: string): Promise<ExportPackage> {
    const response = await f.stranger.get(`/api/cases/${n}/export`).expect(200);
    expect(response.headers['content-disposition']).toContain(`${n}.json`);
    return JSON.parse(response.text);
  }
  it('exports a verifiable package with a service attestation, and the verifier catches tampering', async () => {
    const f = await fixture();
    const open = await opened(f);
    const n = open.number;
    await signedStep(f, n, { type: 'TASK_ASSIGNED', to: 'bob' }, alice);
    await signedStep(f, n, { type: 'TASK_ACCEPTED' }, bob);
    const view = await signedStep(f, n, { type: 'REVIEW_COMPLETED' }, bob);
    const pkg = await exported(f, n);
    expect(pkg.schema).toBe('clinical-workflow-export/v1');
    expect(pkg.case).toEqual({ number: n, policy: view.policy, artifact: view.artifact });
    expect(pkg.events.map(e => e.type)).toEqual(['CASE_CREATED', 'TASK_ASSIGNED', 'TASK_ACCEPTED', 'REVIEW_COMPLETED']);
    expect(pkg.attestation).toMatchObject({ identityId: service.id, height: TIP });
    expect(pkg.attestation!.statement).toBe(`clinical-workflow-export-attestation/v1\ncase:${n}\nevents:4\nhead:${view.headHash}\nat:${pkg.exportedAt}`);
    expect(Object.keys(pkg.identities).sort()).toEqual([alice.id, bob.id].sort());
    expect(pkg.identities[bob.id].snapshots).toHaveLength(2);
    expect(JSON.stringify(pkg)).not.toContain('retina-od');
    const report = await verifyPackage(pkg, f.adapter);
    expect(report.ok, JSON.stringify(report, null, 1)).toBe(true);
    expect(report.derived).toMatchObject({ status: 'completed', owner: { id: alice.id }, responsible: { id: bob.id } });
    expect(report.attestation.outcome).toBe('ok');
    expect(report.events.map(e => e.signature.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report.events.map(e => e.block.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report.events[0].identityNow).toBe('active');
    expect(report.events[0].keyState).toBe('unchanged');
    expect(report.events[0].anchor).toMatch(/^pending \(recorded by the server, not verified\)/);
    // Offline: signatures verify against the package's own snapshots, labelled as such; identity now is unknown.
    const offline = await verifyPackage(pkg, f.adapter, { offline: true });
    expect(offline.ok).toBe(true);
    expect(offline.events[0].signature.detail).toMatch(/self-reported/);
    expect(offline.events[0].identityNow).toBe('unknown (offline)');
    expect(offline.events[0].block.outcome).toBe('unverified');
    // Tampering: an edited statement, a swapped actor, a dropped middle event and a reordered pair all fail.
    const edited = structuredClone(pkg); edited.events[2].statement = edited.events[2].statement.replace('I accept responsibility', 'I decline responsibility');
    expect((await verifyPackage(edited, f.adapter)).events[2].structure.outcome).toBe('fail');
    const swapped = structuredClone(pkg); swapped.events[2].signature.identityId = alice.id;
    expect((await verifyPackage(swapped, f.adapter)).events[2].structure.detail).toMatch(/actor line/);
    const dropped = structuredClone(pkg); dropped.events.splice(1, 1);
    const droppedReport = await verifyPackage(dropped, f.adapter);
    expect(droppedReport.ok).toBe(false);
    expect(droppedReport.events[1].structure.detail).toMatch(/sequence|prev/);
    const reordered = structuredClone(pkg); [reordered.events[1], reordered.events[2]] = [reordered.events[2], reordered.events[1]];
    expect((await verifyPackage(reordered, f.adapter)).ok).toBe(false);
    const forgedAnchor = structuredClone(pkg); forgedAnchor.events[0].anchor = { status: 'anchored', commitment: pkg.events[0].hash, txid: 'ff'.repeat(32), height: 1, updatedAt: 0 };
    expect((await verifyPackage(forgedAnchor, f.adapter)).events[0].anchor).toMatch(/not verified/);
    // A truncated prefix is internally consistent: the verifier says so and the attestation no longer matches.
    const truncated = structuredClone(pkg); truncated.events.pop();
    const truncatedReport = await verifyPackage(truncated, f.adapter);
    expect(truncatedReport.events.every(e => e.structure.outcome === 'ok')).toBe(true);
    expect(truncatedReport.attestation.outcome).toBe('fail');
    expect(truncatedReport.ok).toBe(false);
    expect(truncatedReport.derived.status).toBe('accepted');
    // Key rotation after signing is reported, never hidden.
    f.rotateKeys(bob, ['RLocalKeyBeta']);
    const rotated = await verifyPackage(pkg, f.adapter);
    expect(rotated.events[2].keyState).toBe('rotated');
    expect(rotated.events[2].signature.outcome).toBe('ok');
  });

  it('rejects wallet returns for unknown steps and routes valid ones back to the case page', async () => {
    const f = await fixture();
    const created = await draft(f);
    await step(f, created.number, { type: 'CASE_CREATED', actor: 'alice' });
    const { id } = attestationId(f);
    f.signAs(alice);
    const url = `/api/cases/attestations/${id}/response?${GENERIC_RESPONSE_QUERY_KEY}=${Buffer.from('alice opened').toString('base64url')}`;
    const redirect = await request(f.app).get(url).set('Sec-Fetch-Site', 'cross-site').expect(303);
    expect(redirect.headers.location).toBe(`/cases?caseReturn=${created.number}`);
    // The app's session middleware queued a cookie for this cookie-less request; the callback must not send it.
    expect(redirect.headers['set-cookie']).toBeUndefined();
    expect((await f.owner.get(`/api/cases/${created.number}`)).body.status).toBe('open');
    await request(f.app).get(`/api/cases/attestations/${'0'.repeat(32)}/response?${GENERIC_RESPONSE_QUERY_KEY}=AA`).expect(303).expect('Location', '/cases?caseReturn=invalid&returnError=NOT_FOUND');
    await request(f.app).get(url).expect(303).expect('Location', `/cases?caseReturn=${created.number}`);
    expect(f.adapter.verifyCaseResponse).toHaveBeenCalledTimes(1);
    expect((await sign(f, 'a'.repeat(32), 'anything')).headers['set-cookie']).toBeUndefined();
  });
});
