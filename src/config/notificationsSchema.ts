/**
 * The optional `notifications` section of `clients/<clientId>/client.yaml` (VP-23):
 * booking-confirmation SMS to the caller (Telnyx) and a booking alert to staff (LINE).
 *
 * Nothing here is a secret. Credentials live only in `.env`; this file names WHICH env var holds a
 * client's key (`apiKeyEnv`, `channelAccessTokenEnv`, `recipientEnvs`), so a second client is a
 * new block here plus new `.env` entries — never a code change (CLAUDE.md: secrets only in `.env`,
 * clinic-specific data only in `client.yaml`).
 *
 * Cross-field rules (templates vs. `languages`, placeholders, no URLs) live in
 * ./notificationRules.ts.
 *
 * This file deliberately imports nothing from ./schema.ts (which imports it): a cycle with
 * top-level use of the other module's exports would hit a temporal-dead-zone error.
 */
import { z } from 'zod';

/**
 * `.env` variable names, upper snake case, restricted to the provider's own prefix
 * (`TELNYX_…`, `LINE_…`). The value of the named variable is sent to that provider as a
 * credential, so an unrestricted name — a typo such as `DATABASE_URL` — would hand an unrelated
 * secret to a third party.
 */
function envVarName(prefix: string): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}[A-Z0-9_]+$`),
      `must be an UPPER_SNAKE_CASE environment variable name starting with ${prefix}`,
    );
}

/** Same shape as E164_PATTERN in ./schema.ts: `+` then 7–15 digits, first digit non-zero. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Alphanumeric sender ID: 3–11 characters (Telnyx's documented range), letters and digits only,
 * at least one letter. Telnyx also allows spaces; we don't, to keep the id unambiguous.
 */
const ALPHANUMERIC_SENDER_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{3,11}$/;

/** `+81`-style country calling code, used to dial a number stored in national form. */
const COUNTRY_CODE_PATTERN = /^\+[1-9]\d{0,2}$/;

export const DEFAULT_SMS_COUNTRY_CODE = '+81';
export const DEFAULT_SMS_MAX_PER_RECIPIENT_PER_DAY = 3;

const smsSchema = z.strictObject({
  provider: z.literal('telnyx'),
  /** Name of the `.env` variable holding this client's Telnyx API key. */
  apiKeyEnv: envVarName('TELNYX_'),
  messagingProfileId: z.string().min(1, 'must not be empty'),
  /** What the recipient sees as the sender: an alphanumeric ID such as `Sakura`, or an E.164 number. */
  senderId: z.union([
    z
      .string()
      .regex(ALPHANUMERIC_SENDER_PATTERN, 'must be 3–11 letters/digits with at least one letter'),
    z.string().regex(E164, 'must be an E.164 number, e.g. "+81312345678"'),
  ]),
  defaultCountryCode: z
    .string()
    .regex(COUNTRY_CODE_PATTERN, 'must look like "+81"')
    .default(DEFAULT_SMS_COUNTRY_CODE),
  /**
   * Abuse guard: the public demo page lets anyone type a number, so one number may receive at
   * most this many confirmations per rolling 24 hours.
   */
  maxPerRecipientPerDay: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(DEFAULT_SMS_MAX_PER_RECIPIENT_PER_DAY),
  /** The message per language code (which codes are required is checked in notificationRules.ts). */
  templates: z.record(z.string(), z.string().min(1, 'must not be empty')),
});

const lineSchema = z.strictObject({
  /** Name of the `.env` variable holding this client's LINE channel access token. */
  channelAccessTokenEnv: envVarName('LINE_'),
  /**
   * Names of the `.env` variables holding each recipient's LINE id — a userId today, a groupId
   * later. The push API takes either as `to`, so switching is an `.env` change.
   */
  recipientEnvs: z.array(envVarName('LINE_')).min(1, 'needs at least one recipient'),
  /** The staff alert, written in the language the client's staff read. */
  messageTemplate: z.string().min(1, 'must not be empty'),
});

export const notificationsSchema = z.strictObject({
  sms: smsSchema.optional(),
  line: lineSchema.optional(),
});

export type NotificationsConfig = z.infer<typeof notificationsSchema>;
export type SmsNotificationConfig = z.infer<typeof smsSchema>;
export type LineNotificationConfig = z.infer<typeof lineSchema>;
