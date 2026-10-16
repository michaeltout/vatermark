import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TESTNET_SYSTEM_ID } from '../verus.js';
import {
  BLOCK_TOLERANCE, EXPORT_SCHEMA, ZERO_HASH, allowedSteps, eventHash, nativeSignatureBytes, parseIsoTime, parseStatement, project,
  type CaseEvent, type EventType, type ExportPackage, type IdentityRef, type Projection,
} from './protocol.js';
import { CasesVerusAdapter, EXPORT_ATTESTATION, keyStateOf, type StatementCheck } from './verus.js';

/**
 * Independent verifier for clinical-workflow-export/v1 packages. It needs no
 * application database: every check is recomputed from the package, and
 * identity state comes from VRSCTEST (or, offline, from the package's own
 * snapshots, clearly labelled). See CASES.md, "Verify an export anywhere".
 *
 *   pnpm cases:verify <file> [--offline] [--rpc https://api.verustest.net]
 */
export type Outcome = 'ok' | 'fail' | 'unverified';
export interface Check { outcome: Outcome; detail: string }
export interface EventReport {
  seq: number; type: string; actor: string; actorName: string;
  structure: Check; workflow: Check; signature: Check; block: Check;
  identityNow: string; keyState: string; anchor: string;
}
export interface Report {
  schema: string; caseNumber: string; eventCount: number; headHash: string; exportedAt: string; mode: 'online' | 'offline';
  policy: Check; attestation: Check; derived: { status: string; owner?: IdentityRef; assignee?: IdentityRef; responsible?: IdentityRef };
  events: EventReport[]; ok: boolean;
}
export interface VerifierAdapter {
  verifyStatement: CasesVerusAdapter['verifyStatement'];
  chainBlock?: CasesVerusAdapter['chainBlock'];
}
const ok = (detail: string): Check => ({ outcome: 'ok', detail });
const fail = (detail: string): Check => ({ outcome: 'fail', detail });
const unverified = (detail: string): Check => ({ outcome: 'unverified', detail });
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type PackageEvent = ExportPackage['events'][number];
function isPackage(value: unknown): value is ExportPackage {
  const v = value as ExportPackage;
  return !!v && v.schema === EXPORT_SCHEMA && !!v.case && typeof v.case.number === 'string' && Array.isArray(v.events) && !!v.case.policy && !!v.case.artifact;
}

export async function verifyPackage(input: unknown, adapter: VerifierAdapter, options: { offline?: boolean } = {}): Promise<Report> {
  if (!isPackage(input)) throw new Error(`Not a ${EXPORT_SCHEMA} package.`);
  const pkg = input;
  const mode = options.offline ? 'offline' : 'online';
  const headHash = pkg.events.length ? String(pkg.events.at(-1)!.hash) : ZERO_HASH;
  const report: Report = {
    schema: pkg.schema, caseNumber: pkg.case.number, eventCount: pkg.events.length, headHash, exportedAt: String(pkg.exportedAt), mode,
    policy: sha256(pkg.case.policy.text) === pkg.case.policy.hash ? ok(`${pkg.case.policy.id} text matches its digest`) : fail('policy text does not match the digest statements bind'),
    attestation: unverified('no export attestation in the package'),
    derived: { status: 'draft' }, events: [], ok: true,
  };
  const nonces = new Set<string>();
  const accepted: CaseEvent[] = [];
  let projection: Projection = { status: 'draft' };
  let previousHeight = 0; let previousBlock = 0;
  for (let index = 0; index < pkg.events.length; index++) {
    const e = pkg.events[index] as PackageEvent;
    const entry: EventReport = { seq: Number(e.seq), type: String(e.type), actor: '', actorName: '',
      structure: ok('consistent'), workflow: ok('allowed'), signature: unverified('not checked'), block: unverified('not checked'), identityNow: 'unknown', keyState: 'unknown', anchor: 'unknown' };
    report.events.push(entry);
    const problems: string[] = [];
    const fields = parseStatement(String(e.statement));
    if (!fields) { problems.push('statement does not parse canonically'); }
    else {
      entry.actor = fields.actor; entry.actorName = fields.actorName;
      if (fields.type !== e.type) problems.push('type differs from statement');
      if (fields.case !== pkg.case.number) problems.push('case number differs from statement');
      if (fields.seq !== index + 1 || Number(e.seq) !== index + 1) problems.push(`sequence is not ${index + 1}`);
      const expectedPrev = index ? String(pkg.events[index - 1].hash) : ZERO_HASH;
      if (fields.prev !== expectedPrev || String(e.prev) !== expectedPrev) problems.push('prev does not link to the previous event');
      if (fields.artifact !== pkg.case.artifact.digest) problems.push('artifact digest differs from the case manifest');
      if (fields.policy !== pkg.case.policy.id || fields.policyHash !== pkg.case.policy.hash) problems.push('policy binding differs from the case policy');
      if (nonces.has(fields.nonce)) problems.push('nonce reused'); nonces.add(fields.nonce);
      if (e.signature?.identityId !== fields.actor) problems.push('signature.identityId differs from the actor line');
      if (e.signature?.systemId !== TESTNET_SYSTEM_ID) problems.push('signature.systemId is not VRSCTEST');
      let embeddedHeight: number | undefined;
      try {
        const bytes = nativeSignatureBytes(String(e.signature?.native));
        if (bytes[0] !== 2 || bytes[1] !== 5 || bytes[6] !== 1 || bytes[7] !== 65) problems.push('native signature is not a single v2/SHA256 compact signature');
        embeddedHeight = bytes.readUInt32LE(2);
        if (embeddedHeight !== Number(e.signature?.height)) problems.push('signature.height differs from the height embedded in the signature');
        if (eventHash(String(e.statement), String(e.signature.native)) !== String(e.hash)) problems.push('event hash does not match statement and signature');
      } catch { problems.push('native signature encoding is invalid'); }
      if (fields.block.height < previousBlock) problems.push('issuing block height decreased');
      previousBlock = fields.block.height;
      if (embeddedHeight !== undefined) {
        if (embeddedHeight < fields.block.height - BLOCK_TOLERANCE) problems.push('signature height precedes the issuing block');
        if (embeddedHeight < previousHeight) problems.push('signature height precedes the previous event');
        previousHeight = embeddedHeight;
      }
      if (parseIsoTime(fields.at) === undefined) problems.push('issue time is not canonical');
    }
    if (problems.length) { entry.structure = fail(problems.join('; ')); report.ok = false; }
    // Workflow: the transition must be allowed and the actor entitled, judged from the accepted prefix.
    if (fields) {
      const type = fields.type as EventType;
      const step = allowedSteps(projection).find(s => s.type === type);
      const issues: string[] = [];
      if (!step) issues.push(`${type} is not allowed while the case is ${projection.status}`);
      else if (step.signers !== 'any' && !step.signers.some(who => who.id === fields.actor)) issues.push(`${fields.actor} may not sign ${type} here`);
      if (type === 'TASK_ACCEPTED' || type === 'TASK_REJECTED') {
        if (fields.task !== projection.openTask?.id) issues.push('answers a task that is not open');
        if (projection.openTask && fields.actor !== projection.openTask.to.id) issues.push('actor is not the assignee');
      }
      if (type === 'TASK_WITHDRAWN' && (fields.task !== projection.openTask?.id || fields.to !== projection.openTask?.to.id)) issues.push('withdraws a task that is not open');
      if (type === 'REVIEW_COMPLETED' && fields.task !== projection.acceptedTask?.id) issues.push('completes a task that was not accepted');
      if (issues.length) { entry.workflow = fail(issues.join('; ')); report.ok = false; }
      const event: CaseEvent = { seq: fields.seq, type, statement: String(e.statement), fields, hash: String(e.hash), prev: String(e.prev),
        signature: { native: String(e.signature?.native), identityId: fields.actor, name: fields.actorName, height: Number(e.signature?.height), systemId: TESTNET_SYSTEM_ID },
        acceptedAt: Number(e.acceptedAt), anchor: e.anchor, identity: { atHeight: undefined, current: undefined, keyState: 'unchanged', currentActive: true } };
      accepted.push(event);
      projection = project(accepted);
    }
    // Signature and identity state.
    if (fields) {
      const snapshot = pkg.identities?.[fields.actor]?.snapshots?.find(s => Number(s.height) === Number(e.signature?.height))?.record;
      let check: StatementCheck | undefined;
      try {
        check = await adapter.verifyStatement({ identityId: fields.actor, statement: String(e.statement), nativeSignature: String(e.signature?.native),
          record: options.offline ? snapshot : undefined });
      } catch (error) { entry.signature = options.offline && !snapshot ? unverified('no identity snapshot for this height in the package') : fail(`could not verify: ${(error as Error).message}`); if (!options.offline || snapshot) report.ok = false; }
      if (check) {
        entry.signature = check.valid ? ok(check.source === 'chain' ? `valid for ${fields.actor} at height ${check.height} (identity state from VRSCTEST)` : `valid against the package's own identity snapshot at height ${check.height} (self-reported)`)
          : fail(`signature does not verify for ${fields.actor} at height ${check.height}`);
        if (!check.valid) report.ok = false;
        if (check.source === 'chain') {
          entry.identityNow = check.currentActive ? 'active' : 'revoked';
          entry.keyState = check.current !== undefined ? keyStateOf(check.record, check.current) : 'unknown';
        } else {
          entry.identityNow = 'unknown (offline)';
          const current = pkg.identities?.[fields.actor]?.current;
          entry.keyState = current !== undefined ? `${keyStateOf(check.record, current)} (package-asserted)` : 'unknown (offline)';
        }
      }
      if (!options.offline && adapter.chainBlock) {
        try { const block = await adapter.chainBlock(fields.block.height); entry.block = block.hash === fields.block.hash ? ok(`issuing block ${fields.block.height} is on VRSCTEST`) : fail(`issuing block ${fields.block.height} has a different hash on VRSCTEST`); if (entry.block.outcome === 'fail') report.ok = false; }
        catch (error) { entry.block = unverified(`could not fetch block ${fields.block.height}: ${(error as Error).message}`); }
      } else entry.block = unverified('offline: issuing block not checked against the chain');
    }
    entry.anchor = `${e.anchor?.status ?? 'unknown'} (recorded by the server, not verified)${e.anchor?.txid ? ` txid ${e.anchor.txid}` : ''}`;
  }
  report.derived = { status: projection.status, owner: projection.owner, assignee: projection.assignee, responsible: projection.responsible };
  // Export attestation: the service identity's statement that it held exactly this log at exportedAt.
  const attestation = pkg.attestation;
  if (attestation) {
    const expected = ['clinical-workflow-export-attestation/v1', `case:${pkg.case.number}`, `events:${pkg.events.length}`, `head:${headHash}`, `at:${pkg.exportedAt}`].join('\n');
    if (!EXPORT_ATTESTATION.test(String(attestation.statement)) || attestation.statement !== expected) { report.attestation = fail('attestation statement does not describe this package'); report.ok = false; }
    else {
      try {
        const check = await adapter.verifyStatement({ identityId: String(attestation.identityId), statement: attestation.statement, nativeSignature: String(attestation.native) });
        report.attestation = check.valid ? ok(`server-attested by ${attestation.identityId} at height ${check.height}${options.offline ? '' : ' (identity state from VRSCTEST)'}`) : fail('attestation signature does not verify');
        if (!check.valid) report.ok = false;
      } catch (error) { report.attestation = options.offline ? unverified('offline: attestation not checked') : fail(`attestation could not be verified: ${(error as Error).message}`); if (!options.offline) report.ok = false; }
    }
  }
  return report;
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  const mark = (check: Check) => check.outcome === 'ok' ? 'OK  ' : check.outcome === 'fail' ? 'FAIL' : '--  ';
  lines.push(`${report.schema} · case ${report.caseNumber} · ${report.eventCount} events · head ${report.headHash}`);
  lines.push(`exported ${report.exportedAt} · mode ${report.mode}`);
  lines.push(`policy      ${mark(report.policy)} ${report.policy.detail}`);
  lines.push(`attestation ${mark(report.attestation)} ${report.attestation.detail}`);
  lines.push(`derived     status ${report.derived.status}${report.derived.owner ? ` · owner ${report.derived.owner.name}` : ''}${report.derived.assignee ? ` · assignee ${report.derived.assignee.name}` : ''}${report.derived.responsible ? ` · responsible ${report.derived.responsible.name}` : ''}`);
  lines.push('A package proves the events it contains, never that no later event exists; compare head hash and count with an independent reference.');
  for (const e of report.events) {
    lines.push('');
    lines.push(`#${e.seq} ${e.type} by ${e.actorName || e.actor} (${e.actor})`);
    lines.push(`  structure ${mark(e.structure)} ${e.structure.detail}`);
    lines.push(`  workflow  ${mark(e.workflow)} ${e.workflow.detail}`);
    lines.push(`  signature ${mark(e.signature)} ${e.signature.detail}`);
    lines.push(`  block     ${mark(e.block)} ${e.block.detail}`);
    lines.push(`  identity now: ${e.identityNow} · keys since signing: ${e.keyState}`);
    lines.push(`  anchor: ${e.anchor}`);
  }
  lines.push('');
  lines.push(report.ok ? 'RESULT: every structural, workflow and signature check passed.' : 'RESULT: FAILED. See the checks marked FAIL.');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && /verify-package\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const offline = args.includes('--offline');
  const rpcIndex = args.indexOf('--rpc');
  const rpcUrl = rpcIndex >= 0 ? args[rpcIndex + 1] : 'https://api.verustest.net';
  if (!file) { console.error('usage: pnpm cases:verify <export.json> [--offline] [--rpc <https url>]'); process.exit(2); }
  const adapter = new CasesVerusAdapter({ rpcUrl });
  verifyPackage(JSON.parse(fs.readFileSync(file, 'utf8')), adapter, { offline })
    .then(report => { console.log(formatReport(report)); process.exit(report.ok ? 0 : 1); })
    .catch(error => { console.error(`verification could not run: ${(error as Error).message}`); process.exit(2); });
}
