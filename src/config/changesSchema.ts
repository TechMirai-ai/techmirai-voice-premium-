/**
 * The optional `reservationFlow.changes` section of `clients/<clientId>/client.yaml` (VP-25):
 * callers can cancel or reschedule a booking they made, matched by the number they call from.
 *
 * Presence of the section IS the opt-in: a client without it renders byte-identically to before
 * (no extra tools, no extra prompt text) — see tests/vapi/sakuraGolden.test.ts. What the caller
 * hears is data here, per language, like every other script; the behaviour and the rules around it
 * (what may be changed, how often) live in code and are the same for every client.
 *
 * Spoken lines may contain `[[date]]`, `[[time]]` and `[[service]]`: the model substitutes the
 * values it was given by the tool, as it does for `[[callerName]]` elsewhere, and never speaks the
 * placeholder text itself.
 *
 * This file imports nothing from ./schema.ts (which imports it): see notificationsSchema.ts.
 */
import { z } from 'zod';

/** One text per language code; which codes are required is checked in rules.ts. */
const localizedLine = z.record(z.string(), z.string().min(1, 'must not be empty'));

/** The spoken lines, in the order a change conversation uses them. */
export const CHANGE_SCRIPT_KEYS = [
  /** One booking found: read it back and ask whether it is the right one. */
  'found',
  /** More than one booking found: list them briefly (the model fills them in) and ask which. */
  'askWhich',
  /** Rescheduling: ask for the new date and time. */
  'askNewDateTime',
  /** Cancelling: "shall I cancel it?" — needs an explicit yes. */
  'confirmCancel',
  /** After a successful cancellation. */
  'cancelled',
  /** After a successful reschedule (states the new date and time). */
  'rescheduled',
  /** No booking found for this number (or the call has no number): leads into the callback offer. */
  'notFound',
  /** The change could not be made: leads into the callback offer. */
  'failed',
] as const;

export type ChangeScriptKey = (typeof CHANGE_SCRIPT_KEYS)[number];

const scriptsShape = Object.fromEntries(CHANGE_SCRIPT_KEYS.map((key) => [key, localizedLine])) as {
  [K in ChangeScriptKey]: typeof localizedLine;
};

export const changesSchema = z.strictObject({
  scripts: z.strictObject(scriptsShape),
});

export type ChangesConfig = z.infer<typeof changesSchema>;
