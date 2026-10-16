/**
 * Chain anchoring of event commitments. An event is `anchored` only when a
 * transaction id and inclusion height are recorded; nothing here ever promotes
 * `pending` or `failed` to `anchored` without that evidence. Version 1 ships
 * the interface and an unconfigured implementation that keeps every event
 * pending and says so.
 */
export interface AnchorRecord {
  status: 'pending' | 'anchored' | 'failed';
  /** The committed value: the event hash. */
  commitment: string;
  txid?: string; height?: number; confirmations?: number;
  updatedAt: number; detail?: string;
}
export interface Anchorer {
  readonly configured: boolean;
  /** Human-readable explanation of the anchoring state shown next to pending events. */
  readonly detail: string;
  /** Submit a commitment; resolves with transaction evidence or throws. */
  submit(commitment: string): Promise<{ txid: string; height?: number }>;
  /** Refresh inclusion evidence for a submitted transaction. */
  status(txid: string): Promise<{ height?: number; confirmations?: number }>;
}
export class UnconfiguredAnchorer implements Anchorer {
  readonly configured = false;
  readonly detail = 'Anchoring is not configured on this server; event hashes are recorded but not yet committed to the Verus chain.';
  async submit(): Promise<{ txid: string }> { throw new Error('Anchoring is not configured.'); }
  async status(): Promise<{ height?: number; confirmations?: number }> { return {}; }
}
export function pendingAnchor(commitment: string, anchorer: Anchorer, now = Date.now()): AnchorRecord {
  return { status: 'pending', commitment, updatedAt: now, detail: anchorer.detail };
}
