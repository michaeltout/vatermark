export type EventType = 'CASE_CREATED' | 'TASK_ASSIGNED' | 'TASK_ACCEPTED' | 'TASK_REJECTED' | 'TASK_WITHDRAWN' | 'REVIEW_COMPLETED' | 'CASE_CLOSED' | 'CASE_REOPENED';
export type CaseStatus = 'draft' | 'open' | 'assigned' | 'rejected' | 'accepted' | 'completed' | 'closed' | 'reopened';
export type VerifyStatus = 'verified' | 'revoked' | 'unmarked' | 'invalid' | 'unsupported' | 'unavailable';
export interface IdentityRef { id: string; name: string }
export interface ArtifactManifest { digestAlgorithm: 'sha-256'; digest: string; bytes: number; mediaType: string; width?: number; height?: number; manifestVersion: 1 }
export interface Anchor { status: 'pending' | 'anchored' | 'failed'; commitment: string; txid?: string; height?: number; confirmations?: number; updatedAt: number; detail?: string }
export interface CaseEventView {
  seq: number; type: EventType; at: number; issuedAt: string; actor: IdentityRef; to?: IdentityRef; task?: string; deadline?: string;
  hash: string; prev: string; signingHeight: number; block: { height: number; hash: string }; keyState: 'unchanged' | 'rotated' | 'revoked'; anchor: Anchor; statement: string;
}
export interface PendingStep {
  id: string; type: EventType; statement: string; expectedSigner: IdentityRef; to?: IdentityRef;
  walletUri: string; expiresAt: number; issuedAt: string; deadline?: string; proposedHere: boolean;
}
export interface AllowedStep { type: EventType; signers: IdentityRef[] | 'any' }
export interface CaseView {
  number: string; status: CaseStatus; createdAt: number; updatedAt: number;
  policy: { id: string; hash: string; text: string }; artifact: ArtifactManifest; headHash: string;
  owner?: IdentityRef; assignee?: IdentityRef; responsible?: IdentityRef;
  openTask?: { id: string; to: IdentityRef; by: IdentityRef; deadline?: string; since?: number };
  acceptedTask?: { id: string; by?: IdentityRef };
  events: CaseEventView[]; pending?: PendingStep; actions: AllowedStep[]; isCreator: boolean; exportUrl?: string; related: string[];
}
export interface Config { network: string; signing: { enabled: boolean; reason?: string }; responseMode?: 'redirect' | 'post'; maxUploadBytes: number; maxPixels: number }
export interface CheckResult {
  artifact: ArtifactManifest; cases: string[]; ticket?: { id: string; expiresAt: number };
  derivative?: { status: VerifyStatus; message: string; identity?: IdentityRef & { currentStatus?: string } };
}
export interface StepInput { type: EventType; actor?: string; to?: string; deadline?: string }

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json().catch(() => null) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!response.ok) throw new RequestError(data?.error?.message || `Something went wrong (${response.status}). Please try again.`, response.status, data?.error?.code);
  return data as T;
}
const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
function upload(file: File, signal?: AbortSignal): RequestInit {
  const body = new FormData();
  body.append('image', file);
  return { method: 'POST', body, signal };
}
export const api = {
  config: (signal?: AbortSignal) => request<Config>('/api/config', { signal }),
  case: (number: string, signal?: AbortSignal) => request<CaseView>(`/api/cases/${encodeURIComponent(number)}`, { signal }),
  open: (file: File, signal?: AbortSignal) => request<CaseView>('/api/cases', upload(file, signal)),
  check: (file: File, signal?: AbortSignal) => request<CheckResult>('/api/cases/check', upload(file, signal)),
  fromTicket: (ticket: string) => request<CaseView>('/api/cases/from-ticket', json({ ticket })),
  step: (number: string, input: StepInput) => request<CaseView>(`/api/cases/${encodeURIComponent(number)}/steps`, json(input)),
  withdrawStep: (number: string) => request<CaseView>(`/api/cases/${encodeURIComponent(number)}/step`, { method: 'DELETE' }),
};
