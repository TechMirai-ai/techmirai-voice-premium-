/**
 * The optional `reservationFlow.recall` section of `clients/<clientId>/client.yaml` (VP-26): the
 * assistant greets a caller whose number has an earlier visit on record by saying when it was and
 * what it was for — and nothing else (owner decision: date + service only, never a time, a name, a
 * reservation number or any treatment detail).
 *
 * Presence of the section IS the opt-in: a client without it renders byte-identically to before
 * (no extra tool, no extra prompt text) — see tests/vapi/sakuraGolden.test.ts. What the caller
 * hears is data here, per language; the rules around it (own number only, how far back, what may
 * be said) live in code and are the same for every client.
 *
 * Spoken lines contain `[[date]]` (and `[[service]]` in the first one): the model substitutes the
 * values the tool gave it, in the caller's language, and never speaks the placeholder text. The
 * checks that keep a line from saying more than that are in rules.ts.
 *
 * This file imports nothing from ./schema.ts (which imports it): see notificationsSchema.ts.
 */
import { z } from 'zod';

/** One text per language code; which codes are required is checked in rules.ts. */
const localizedLine = z.record(z.string(), z.string().min(1, 'must not be empty'));

/** The spoken lines. Both need a version for every supported language. */
export const RECALL_SCRIPT_KEYS = [
  /** The earlier visit had a recorded service: says the date and the service. */
  'visitAcknowledgement',
  /** The earlier visit has no recorded service (a returning-patient booking): the date only. */
  'visitAcknowledgementNoService',
] as const;

export type RecallScriptKey = (typeof RECALL_SCRIPT_KEYS)[number];

/** How far back a visit may be and still be mentioned (owner decision, VP-26: one year). */
export const DEFAULT_RECALL_MAX_AGE_DAYS = 365;
const MAX_RECALL_MAX_AGE_DAYS = 3650;

const scriptsShape = Object.fromEntries(RECALL_SCRIPT_KEYS.map((key) => [key, localizedLine])) as {
  [K in RecallScriptKey]: typeof localizedLine;
};

export const recallSchema = z.strictObject({
  maxAgeDays: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECALL_MAX_AGE_DAYS)
    .default(DEFAULT_RECALL_MAX_AGE_DAYS),
  scripts: z.strictObject(scriptsShape),
});

export type RecallConfig = z.infer<typeof recallSchema>;
