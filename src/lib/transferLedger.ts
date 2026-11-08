/**
 * Transfers this server instance has started but whose end-of-call report may not be stored yet.
 *
 * The daily cap reads stored calls (`call_logs.ended_reason`), which lag a started transfer by the
 * time the call takes to end and its report to arrive. This ledger closes that gap for the
 * requests one instance sees; it is memory only, so a second serverless instance does not share
 * it. The cap therefore bounds a flood approximately, not to the exact call — a strict ceiling
 * would need a table (see docs/VP24-CALL-TRANSFER.md). Size-bounded so it cannot grow without end.
 */

/**
 * A transferred call only reaches `call_logs` once it ENDS and its report arrives, so this must
 * outlast a long staff conversation. Overlap with the stored count only double-counts (fail closed).
 */
export const UNREPORTED_WINDOW_MS = 90 * 60_000;
const MAX_ENTRIES = 500;

export class TransferLedger {
  /** Keyed by call id; the client is kept so one client's transfers never use another's quota. */
  private readonly startedAt = new Map<string, { clientId: string; at: number }>();

  /** Transfers already started for this call (0 or 1). */
  forCall(callId: string): number {
    return this.startedAt.has(callId) ? 1 : 0;
  }

  /** Started by this client within the unreported window, on this instance. */
  recentCount(clientId: string, now: Date): number {
    this.prune(now);
    let count = 0;
    for (const entry of this.startedAt.values()) if (entry.clientId === clientId) count += 1;
    return count;
  }

  record(clientId: string, callId: string, now: Date): void {
    this.prune(now);
    this.startedAt.set(callId, { clientId, at: now.getTime() });
    while (this.startedAt.size > MAX_ENTRIES) {
      const oldest = this.startedAt.keys().next().value;
      if (oldest === undefined) break;
      this.startedAt.delete(oldest);
    }
  }

  private prune(now: Date): void {
    for (const [callId, entry] of this.startedAt) {
      if (now.getTime() - entry.at > UNREPORTED_WINDOW_MS) this.startedAt.delete(callId);
    }
  }
}
