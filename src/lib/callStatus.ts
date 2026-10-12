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
  if (input.resolved === true) return 'resolved_by_ai';
  return 'unresolved';
}
