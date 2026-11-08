/**
 * The optional `transfer` section of `clients/<clientId>/client.yaml` (VP-24): hand a live call to
 * a staff phone through our `transfer_to_staff` tool: the server checks hours and volume
 * (src/lib/transferGate.ts), then moves the call with Live Call Control.
 *
 * The staff NUMBER is a personal-looking secret, so it is not here: `numberEnv` names the `.env`
 * variable that holds it (same pattern as the LINE recipient). Everything else — hours behaviour,
 * the daily cap, the wording — is clinic data and lives here. Cross-field rules (scripts vs.
 * `languages`, `callback.enabled`, real closed dates) are in ./transferRules.ts.
 *
 * Known limit (docs/VAPI-FACTS.md, VP-24): on a Telnyx-imported number Vapi is documented to leave
 * the call when a blind transfer starts, so a busy / unanswered / failed destination probably
 * CANNOT return the caller to the assistant (unverified for Live Call Control). `fallbackPlan` is
 * not sent today; it is part of the shape so a move to a Vapi number or SIP trunk is a config change.
 *
 * This file imports nothing from ./schema.ts (which imports it): see notificationsSchema.ts.
 */
import { z } from 'zod';

import { envVarName } from './envVarName.js';
import { COUNTRY_CODE_PATTERN } from './phoneFormats.js';

/** Transfers per client per rolling 24 h unless the yaml says otherwise. */
export const DEFAULT_TRANSFER_MAX_PER_DAY = 20;

const CLOSED_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Japan only unless a client's yaml opts other destinations in (bounds toll fraud). */
export const DEFAULT_TRANSFER_ALLOWED_COUNTRY_CODES: readonly string[] = ['+81'];

/** No transfer in the last minutes before closing: nobody is left to pick up. */
export const DEFAULT_TRANSFER_CLOSING_BUFFER_MINUTES = 10;

/**
 * Transfer modes this project knows. NOT SENT to Vapi today: the Live Call Control `transfer`
 * command has no `transferPlan` (docs/VAPI-FACTS.md VP-24 R7). Only the immediate blind transfer
 * exists; warm transfer needs a bring-your-own SIP trunk or Vapi number.
 */
export const TRANSFER_MODES = ['blind-transfer'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

/** One text per language code; which codes are required is checked in transferRules.ts. */
const localizedLine = z.record(z.string(), z.string().min(1, 'must not be empty'));

const fallbackPlanSchema = z.strictObject({
  /**
   * NOT SENT today (see the file comment): setting it does NOT bring a failed caller back. Spoken
   * to the caller when a transfer fails and Vapi returns them to the assistant.
   */
  message: localizedLine,
  /** `false` keeps the assistant on the line to take a callback; `true` ends the call. */
  endCallEnabled: z.boolean().default(false),
});

const transferScriptsSchema = z.strictObject({
  /** Offer after a callback was saved: "shall I try to connect you to a staff member now?" */
  offer: localizedLine,
  /** Said by the platform when the transfer starts (a fixed line, not model improvisation). */
  transferring: localizedLine,
  /** Said, before the usual staff-callback offer, when staff are asked for outside clinic hours. */
  closedOffer: localizedLine,
  /** Said when the transfer tool reports an error; the assistant then takes a callback. */
  failed: localizedLine,
});

export const transferSchema = z.strictObject({
  /** Off switch: keep the block, stop offering transfers. */
  enabled: z.boolean(),
  /**
   * Name of the `.env` variable holding the staff phone the call is transferred to (E.164). The
   * number itself is never in client.yaml, git or the Vapi tool: only this server reads it, at the
   * moment a transfer is allowed (src/lib/transferGate.ts).
   */
  numberEnv: envVarName('TRANSFER_'),
  /** The number must start with one of these country codes (checked when it is read). */
  allowedCountryCodes: z
    .array(z.string().regex(COUNTRY_CODE_PATTERN, 'must look like "+81"'))
    .min(1, 'needs at least one country code')
    .default([...DEFAULT_TRANSFER_ALLOWED_COUNTRY_CODES]),
  mode: z.enum(TRANSFER_MODES).default('blind-transfer'),
  /** Transfers stop this many minutes before closing time. */
  closingBufferMinutes: z
    .number()
    .int()
    .min(0)
    .max(120)
    .default(DEFAULT_TRANSFER_CLOSING_BUFFER_MINUTES),
  /**
   * Whole-client ceiling: at most this many transfers per rolling 24 hours, so a flood of calls
   * cannot run up the telephony bill whatever the Telnyx cap. Over it, the server refuses and the
   * assistant falls back to the callback.
   */
  maxPerDay: z.number().int().min(1).max(200).default(DEFAULT_TRANSFER_MAX_PER_DAY),
  /**
   * Extra closed days (YYYY-MM-DD, clinic timezone) on top of the weekly hours: national holidays
   * and the clinic's own closures. The server refuses transfers on these dates. The platform has no
   * holiday calendar, so `business.hours.closedOnNationalHolidays` alone cannot be enforced.
   */
  closedDates: z
    .array(z.string().regex(CLOSED_DATE_PATTERN, 'must be a date like "2026-12-29"'))
    .default([]),
  /**
   * Not sent today: transfers go out as a Live Call Control command, which has no `transferPlan`
   * (docs/VAPI-FACTS.md VP-24 R7). Kept so a Vapi number or SIP trunk can use it later.
   */
  fallbackPlan: fallbackPlanSchema.optional(),
  scripts: transferScriptsSchema,
});

export type TransferConfig = z.infer<typeof transferSchema>;
export type TransferScriptKey = keyof TransferConfig['scripts'];
export const TRANSFER_SCRIPT_KEYS = Object.keys(
  transferSchema.shape.scripts.shape,
) as TransferScriptKey[];
