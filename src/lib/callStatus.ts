/**
 * The staff-facing status of a call (VP-12). A fixed enum, derived from which
 * tool actually ran in the call — never a free-text field. Precedence is the
 * order of CALL_STATUSES: the first rule that matches wins.
 */

export const CALL_STATUSES = [
  'reservation_made',
  'needs_callback',
  'resolved_by_ai',
  'unresolved',
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

/** A tool call's outcome as recorded in the end-of-call report. */
export interface ToolOutcome {
  name: string;
  result?: string | undefined;
  error?: string | undefined;
}

export interface CallStatusInput {
  toolResults: readonly ToolOutcome[];
  /** From the call-outcome structured output; `undefined` when it is missing or failed. */
  resolved: boolean | undefined;
  /** VP-24: the call ended in a transfer to staff (`isTransferredCall`). Never counts as AI-resolved. */
  transferred?: boolean | undefined;
}

/**
 * Vapi's `endedReason` when it started a transfer or handed control to our server. It does NOT
 * confirm the destination answered (docs.vapi.ai/call-forwarding; docs/VAPI-FACTS.md VP-24), and
 * on Telnyx there is no other signal — so a transfer is always "outcome unconfirmed".
 */
export const TRANSFER_ENDED_REASON = 'assistant-forwarded-call';

export function isTransferredCall(endedReason: string | undefined): boolean {
  return endedReason === TRANSFER_ENDED_REASON;
}

/**
 * The note staff see at the start of a transferred call's summary. A dedicated status would need a
 * migration (`call_logs.status` has a CHECK constraint), so the marker rides in the summary.
 */
export const TRANSFER_SUMMARY_NOTE = 'Transferred to staff (outcome unconfirmed).';

export function withTransferNote(
  summary: string | undefined,
  transferred: boolean,
): string | undefined {
  if (!transferred) return summary;
  return summary ? `${TRANSFER_SUMMARY_NOTE} ${summary}` : TRANSFER_SUMMARY_NOTE;
}

export const BOOK_SUCCESS_PREFIX = 'Booked.';

const BOOK_TOOL = 'book_appointment';
const CALLBACK_TOOL = 'request_callback';

function bookingSucceeded(outcome: ToolOutcome): boolean {
  return (
    outcome.name === BOOK_TOOL &&
    !outcome.error &&
    (outcome.result ?? '').trimStart().startsWith(BOOK_SUCCESS_PREFIX)
  );
}

export function deriveCallStatus(input: CallStatusInput): CallStatus {
  if (input.toolResults.some(bookingSucceeded)) return 'reservation_made';
  if (input.toolResults.some((outcome) => outcome.name === CALLBACK_TOOL)) return 'needs_callback';
  // Only an explicit `true` counts: a missing/failed classification must surface to staff.
  // A transfer's outcome is never confirmed (see TRANSFER_ENDED_REASON), so it is never "resolved".
  if (input.resolved === true && !input.transferred) return 'resolved_by_ai';
  return 'unresolved';
}
