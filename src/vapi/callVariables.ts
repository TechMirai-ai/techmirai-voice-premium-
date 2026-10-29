/**
 * The per-call variables the /talk page hands Vapi through `assistantOverrides.variableValues`
 * (VP-15), and the one place that reads the caller's phone number back out of a webhook's `call`.
 *
 * SEAM FOR SV-5: `callerPhoneFromCall` is the only function that decides where "the caller's phone
 * number" comes from. When real phone calls exist, make it read `call.customer.number` (Vapi's
 * caller ID) and delete the /talk phone field — nothing else needs to change.
 */
import { formatClinicDateTime } from '../lib/clinicTime.js';
import { normalizeCallerPhone } from '../lib/callerPhone.js';
import type { PriorCall } from '../repositories/callLogRepository.js';

/** Variable names — must match the `{{…}}` placeholders in promptTemplate.ts. */
export const CALLER_PHONE_VARIABLE = 'callerPhone';
export const PRIOR_CALL_VARIABLE = 'priorCall';

/** The value of the prior-call variable when this number has not called before. */
export const NO_PRIOR_CALL = 'none';

const MAX_SUMMARY_CHARS = 500;
const NO_SUMMARY = '(none recorded)';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `overrides.variableValues[callerPhone]`, normalised — undefined for anything that isn't a string. */
function enteredPhoneIn(overrides: unknown): string | undefined {
  if (!isRecord(overrides) || !isRecord(overrides.variableValues)) return undefined;
  const entered = overrides.variableValues[CALLER_PHONE_VARIABLE];
  return typeof entered === 'string' ? normalizeCallerPhone(entered) : undefined;
}

/**
 * Normalised caller number for this call, or undefined when the call carries none. A call started
 * from a single assistant records it under `assistantOverrides`; a call started from an inline
 * squad (the /talk page's default-language start, VP-22) records it under
 * `squad.membersOverrides` and leaves `assistantOverrides` null.
 */
export function callerPhoneFromCall(call: unknown): string | undefined {
  if (!isRecord(call)) return undefined;
  const squad = isRecord(call.squad) ? call.squad : undefined;
  return enteredPhoneIn(call.assistantOverrides) ?? enteredPhoneIn(squad?.membersOverrides);
}

/** One line of prompt data describing the most recent earlier call (status + summary, no transcript). */
export function formatPriorCall(prior: PriorCall | undefined, timeZone: string): string {
  if (!prior) return NO_PRIOR_CALL;
  const date = formatClinicDateTime(prior.occurredAt, timeZone).slice(0, 10);
  const summary =
    prior.summary?.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS) || NO_SUMMARY;
  return `Last call: ${date}, status: ${prior.status}, summary: ${summary}`;
}
