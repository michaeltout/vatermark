import { createHash } from 'node:crypto';

/**
 * The bundled workflow policy. Every statement binds the policy by identifier
 * and by the SHA-256 of this exact text, which also ships in export packages,
 * so a signer and a later verifier read the same definition of each event.
 * A deploying organisation replaces this text with its own; the identifier
 * and digest then change together.
 */
export const POLICY_ID = 'vatermark-cases-policy-v1';
export const POLICY_TEXT = [
  'Vatermark Cases workflow policy v1',
  '',
  'This policy defines what each signed event in a case means. It defines',
  'responsibility for a review task, not clinical correctness, and it does not',
  'assert that any signer holds a professional licence or organisational',
  'authorisation; those are established outside this record.',
  '',
  'CASE_CREATED: the signer opens the case against the artifact named by its',
  'SHA-256 digest and becomes its owner. The owner assigns review',
  'responsibility, withdraws unanswered requests, closes and reopens the case.',
  '',
  'TASK_ASSIGNED: the signer (the owner, or the clinician currently responsible',
  'handing the task on) asks the named identity to take responsibility for',
  'reviewing the artifact. The request may carry a deadline, which is a',
  'request, not an enforced limit. An unanswered request is not evidence that',
  'the named identity was notified of it or saw it.',
  '',
  'TASK_ACCEPTED: the named identity accepts responsibility for reviewing the',
  'artifact. From this event until completion or hand-off, that identity is',
  'responsible for the review.',
  '',
  'TASK_REJECTED: the named identity declines the request. Responsibility',
  'stays where it was before the request.',
  '',
  'TASK_WITHDRAWN: the owner withdraws a request that has not been answered.',
  'Responsibility stays where it was before the request.',
  '',
  'REVIEW_COMPLETED: the responsible identity attests that it has examined the',
  'artifact identified by the digest and completed the review it accepted. It',
  'attests completion of the task, not a diagnosis, a report, or the',
  'correctness of any finding; reports and findings live in the clinical',
  'record, outside this case.',
  '',
  'CASE_CLOSED: the owner records that the workflow for this case is finished.',
  'A case with an accepted, uncompleted review cannot be closed.',
  '',
  'CASE_REOPENED: the owner records that further work is needed on a closed',
  'case. Earlier events keep their meaning.',
].join('\n');
export const POLICY_HASH = createHash('sha256').update(POLICY_TEXT, 'utf8').digest('hex');
export function policyHash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
