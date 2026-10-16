import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES, MEANINGS, SCHEMA, ZERO_HASH, allowedSteps, buildStatement, eventHash, isoTime, normalizeCaseNumber, parseIsoTime,
  parseStatement, project, type CaseEvent, type EventType, type StatementFields,
} from '../../server/cases/protocol.js';
import { POLICY_HASH, POLICY_ID, POLICY_TEXT, policyHash } from '../../server/cases/policy.js';
import { CASE_STATEMENT } from '../../server/cases/verus.js';

// Pure protocol rules: statements, hashes and the state machine. No I/O.
const alice = { id: 'i3kT4uvcakroae5k6cLtWrG6BX34gAzxCp', name: 'alice@' };
const bob = { id: 'iBobCustodyTestJdentityAbcdefghjk2', name: 'bob@' };
const carol = { id: 'iCaroWorkfowTestJdentityAbcdefghj3', name: 'carol@' };
const number = 'VC-7K3M-Q9ZD-4XHB';
const block = { height: 5000, hash: 'ab'.repeat(32) };
function fields(overrides: Omit<Partial<StatementFields>, 'actor'> & { type: EventType; seq: number; signer: typeof alice }): StatementFields {
  const { signer, ...rest } = overrides;
  return { case: number, prev: rest.seq === 1 ? ZERO_HASH : 'cd'.repeat(32), artifact: 'ef'.repeat(32), actorName: signer.name,
    policy: POLICY_ID, policyHash: POLICY_HASH, block, at: '2026-10-15T10:30:00Z', nonce: '12'.repeat(20), ...rest, actor: signer.id };
}
function native(fill: number, height = 5000) {
  const h = Buffer.alloc(4); h.writeUInt32LE(height);
  return Buffer.concat([Buffer.from([2, 5]), h, Buffer.from([1, 65, 27]), Buffer.alloc(64, fill)]).toString('base64');
}
let seq = 0; let prev = ZERO_HASH;
function event(type: EventType, actor: typeof alice, extra: Partial<StatementFields> = {}, fill = 0x11): CaseEvent {
  const f = fields({ type, seq: ++seq, prev, signer: actor, ...extra });
  const statement = buildStatement(f);
  const sig = native(fill);
  const hash = eventHash(statement, sig);
  prev = hash;
  return { seq: f.seq, type, statement, fields: f, hash, prev: f.prev,
    signature: { native: sig, identityId: actor.id, name: actor.name, height: 5000, systemId: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq' },
    acceptedAt: 0, anchor: { status: 'pending', commitment: hash, updatedAt: 0 }, identity: { atHeight: undefined, current: undefined, keyState: 'unchanged', currentActive: true } };
}

describe('canonical statements', () => {
  it('build and parse round-trip for every event type, and the coarse grammar agrees', () => {
    const samples: StatementFields[] = [
      fields({ type: 'CASE_CREATED', seq: 1, signer: alice }),
      fields({ type: 'TASK_ASSIGNED', seq: 2, signer: alice, to: bob.id, toName: bob.name, task: 'a1b2c3d4e5f60718', deadline: '2026-10-20T08:00:00Z' }),
      fields({ type: 'TASK_ACCEPTED', seq: 3, signer: bob, task: 'a1b2c3d4e5f60718' }),
      fields({ type: 'TASK_REJECTED', seq: 3, signer: bob, task: 'a1b2c3d4e5f60718' }),
      fields({ type: 'TASK_WITHDRAWN', seq: 3, signer: alice, to: bob.id, toName: bob.name, task: 'a1b2c3d4e5f60718' }),
      fields({ type: 'REVIEW_COMPLETED', seq: 4, signer: bob, task: 'a1b2c3d4e5f60718' }),
      fields({ type: 'CASE_CLOSED', seq: 5, signer: alice }),
      fields({ type: 'CASE_REOPENED', seq: 6, signer: alice }),
    ];
    expect(samples.map(s => s.type).sort()).toEqual([...EVENT_TYPES].sort());
    for (const sample of samples) {
      const text = buildStatement(sample);
      expect(text.startsWith(`${SCHEMA}\n${MEANINGS[sample.type]}\ntype:${sample.type}\ncase:${number}\n`)).toBe(true);
      expect(text.endsWith(`\nnonce:${sample.nonce}`)).toBe(true);
      expect(text).not.toMatch(/\r|\n$/);
      expect(CASE_STATEMENT.test(text)).toBe(true);
      expect(parseStatement(text)).toEqual(sample);
    }
  });

  it('rejects statements that are not byte-for-byte canonical or that break the per-type rules', () => {
    const text = buildStatement(fields({ type: 'TASK_ASSIGNED', seq: 2, signer: alice, to: bob.id, toName: bob.name, task: 'a1b2c3d4e5f60718' }));
    expect(parseStatement(text.replace('\n', '\r\n'))).toBeUndefined();
    expect(parseStatement(`${text}\n`)).toBeUndefined();
    expect(parseStatement(text.replace(MEANINGS.TASK_ASSIGNED, MEANINGS.TASK_ACCEPTED))).toBeUndefined();
    expect(parseStatement(text.replace('seq:2', 'seq:02'))).toBeUndefined();
    expect(parseStatement(text.replace(`to:${bob.id}\nto-name:${bob.name}\n`, ''))).toBeUndefined();
    expect(parseStatement(text.replace('policy-hash:', 'policyhash:'))).toBeUndefined();
    expect(() => buildStatement(fields({ type: 'CASE_CREATED', seq: 1, signer: alice, task: 'a1b2c3d4e5f60718' }))).toThrow(/task/);
    expect(() => buildStatement(fields({ type: 'TASK_ACCEPTED', seq: 2, signer: bob }))).toThrow(/task/);
    expect(() => buildStatement(fields({ type: 'TASK_ACCEPTED', seq: 2, signer: bob, task: 'a1b2c3d4e5f60718', deadline: '2026-10-20T08:00:00Z' }))).toThrow(/deadline/);
    expect(() => buildStatement(fields({ type: 'CASE_CREATED', seq: 1, signer: alice, prev: 'cd'.repeat(32) }))).toThrow(/previous/);
    expect(() => buildStatement(fields({ type: 'CASE_CLOSED', seq: 2, signer: alice, prev: ZERO_HASH }))).toThrow(/previous/);
    expect(() => buildStatement(fields({ type: 'CASE_CREATED', seq: 1, signer: alice, at: '2026-10-15T10:30:00.000Z' }))).toThrow(/time/);
    expect(() => buildStatement(fields({ type: 'CASE_CREATED', seq: 1, signer: { id: 'not-an-address', name: 'x@' } }))).toThrow(/actor/);
  });

  it('binds the policy by content and formats times canonically', () => {
    expect(POLICY_HASH).toBe(policyHash(POLICY_TEXT));
    expect(POLICY_TEXT).not.toMatch(/\r/);
    expect(isoTime(Date.UTC(2026, 9, 15, 10, 30, 0, 999))).toBe('2026-10-15T10:30:00Z');
    expect(parseIsoTime('2026-10-15T10:30:00Z')).toBe(Date.UTC(2026, 9, 15, 10, 30, 0));
    expect(parseIsoTime('2026-10-15T10:30:00+02:00')).toBeUndefined();
    expect(parseIsoTime('2026-13-15T10:30:00Z')).toBeUndefined();
  });

  it('hashes statement and signature bytes together and accepts typed case numbers', () => {
    const statement = buildStatement(fields({ type: 'CASE_CREATED', seq: 1, signer: alice }));
    const hash = eventHash(statement, native(0x11));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(eventHash(statement, native(0x12))).not.toBe(hash);
    expect(eventHash(`${statement} `, native(0x11))).not.toBe(hash);
    expect(() => eventHash(statement, Buffer.alloc(72).toString('base64'))).toThrow();
    expect(normalizeCaseNumber(' vc7k3mq9zd4xhb ')).toBe(number);
    expect(normalizeCaseNumber('VC-7K3M-Q9ZD-4XHB')).toBe(number);
    expect(normalizeCaseNumber('VC-7K3M-Q9ZD-4XH')).toBeUndefined();
    expect(normalizeCaseNumber('VC-7K3M-Q9ZD-4XHU')).toBeUndefined();
  });
});

describe('state machine projection', () => {
  it('derives status, owner, assignee and responsible from the log, and resumes correctly after rejection, withdrawal and hand-off', () => {
    seq = 0; prev = ZERO_HASH;
    const log: CaseEvent[] = [];
    const push = (e: CaseEvent) => { log.push(e); return project(log); };
    expect(project([])).toEqual({ status: 'draft' });
    expect(allowedSteps(project([]))).toEqual([{ type: 'CASE_CREATED', signers: 'any' }]);
    let p = push(event('CASE_CREATED', alice));
    expect(p).toMatchObject({ status: 'open', owner: alice });
    expect(allowedSteps(p).map(s => s.type)).toEqual(['TASK_ASSIGNED', 'CASE_CLOSED']);
    expect(allowedSteps(p)[0].signers).toEqual([alice]);
    p = push(event('TASK_ASSIGNED', alice, { to: bob.id, toName: bob.name, task: 'a1b2c3d4e5f60718' }));
    expect(p).toMatchObject({ status: 'assigned', assignee: bob, openTask: { id: 'a1b2c3d4e5f60718', to: bob, by: alice, resume: 'rejected' } });
    expect(allowedSteps(p).map(s => `${s.type}:${(s.signers as typeof alice[]).map(w => w.name).join('+')}`))
      .toEqual(['TASK_ASSIGNED:alice@', 'TASK_ACCEPTED:bob@', 'TASK_REJECTED:bob@', 'TASK_WITHDRAWN:alice@']);
    p = push(event('TASK_WITHDRAWN', alice, { to: bob.id, toName: bob.name, task: 'a1b2c3d4e5f60718' }));
    expect(p).toMatchObject({ status: 'rejected' });
    expect(p.assignee).toBeUndefined();
    p = push(event('TASK_ASSIGNED', alice, { to: bob.id, toName: bob.name, task: 'b1b2c3d4e5f60718' }));
    p = push(event('TASK_ACCEPTED', bob, { task: 'b1b2c3d4e5f60718' }, 0x22));
    expect(p).toMatchObject({ status: 'accepted', responsible: bob, acceptedTask: { id: 'b1b2c3d4e5f60718' } });
    expect(allowedSteps(p).map(s => `${s.type}:${(s.signers as typeof alice[]).map(w => w.name).join('+')}`)).toEqual(['TASK_ASSIGNED:alice@+bob@', 'REVIEW_COMPLETED:bob@']);
    // Bob hands the task to Carol, who declines: Bob remains responsible.
    p = push(event('TASK_ASSIGNED', bob, { to: carol.id, toName: carol.name, task: 'c1b2c3d4e5f60718' }, 0x22));
    expect(p).toMatchObject({ status: 'assigned', assignee: carol, responsible: bob, openTask: { resume: 'accepted' } });
    expect(allowedSteps(p).find(s => s.type === 'TASK_ASSIGNED')!.signers).toEqual([alice, bob]);
    p = push(event('TASK_REJECTED', carol, { task: 'c1b2c3d4e5f60718' }, 0x33));
    expect(p).toMatchObject({ status: 'accepted', responsible: bob, acceptedTask: { id: 'b1b2c3d4e5f60718' } });
    expect(p.assignee).toBeUndefined();
    p = push(event('REVIEW_COMPLETED', bob, { task: 'b1b2c3d4e5f60718' }, 0x22));
    expect(p).toMatchObject({ status: 'completed', completedTask: { id: 'b1b2c3d4e5f60718' }, responsible: bob });
    expect(allowedSteps(p).map(s => s.type)).toEqual(['TASK_ASSIGNED', 'CASE_CLOSED']);
    p = push(event('CASE_CLOSED', alice));
    expect(allowedSteps(p)).toEqual([{ type: 'CASE_REOPENED', signers: [alice] }]);
    p = push(event('CASE_REOPENED', alice));
    expect(p.status).toBe('reopened');
    expect(allowedSteps(p).map(s => s.type)).toEqual(['TASK_ASSIGNED', 'CASE_CLOSED']);
    // The log links: each prev is the previous hash.
    for (let i = 1; i < log.length; i++) expect(log[i].prev).toBe(log[i - 1].hash);
  });

  it('never allows closing over an accepted review', () => {
    seq = 0; prev = ZERO_HASH;
    const log = [event('CASE_CREATED', alice), event('TASK_ASSIGNED', alice, { to: bob.id, toName: bob.name, task: 'a1b2c3d4e5f60718' }), event('TASK_ACCEPTED', bob, { task: 'a1b2c3d4e5f60718' }, 0x22)];
    expect(allowedSteps(project(log)).map(s => s.type)).not.toContain('CASE_CLOSED');
  });
});
