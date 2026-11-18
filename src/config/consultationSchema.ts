/**
 * The optional `consultation` section of `clients/<clientId>/client.yaml`.
 *
 * Present = this client takes CONSULTATION requests (a lead: name + a number to contact) through
 * the `request_consultation` tool instead of callback requests. The assistant renders the
 * consultation flow in place of the callback flow, and the callback tool is not created for it.
 * Absent = the client renders exactly as before.
 *
 * Wording only; nothing here is a secret. Cross-field rules (every language, known placeholders)
 * live in ./consultationRules.ts. Like notificationsSchema.ts, this file imports nothing from
 * ./schema.ts, which imports it.
 */
import { z } from 'zod';

const text = z.string().min(1, 'must not be empty');
const localized = z.record(z.string(), text);

/** The lines the assistant says in each step of the consultation flow (per language). */
const consultationScriptsSchema = z.strictObject({
  /** Asks for the caller's name. */
  askName: localized,
  /** Reads the name back as its own turn; the model fills [[name]]. Needs a yes. */
  confirmName: localized,
  /** Asks whether staff may contact the caller on the number they are calling from. */
  askContactNumber: localized,
  /** Asks for a number to use (caller said "another number", or no caller ID reached us). */
  askSpokenNumber: localized,
  /** Reads a spoken number back digit by digit; the model fills [[number]]. Needs a yes. */
  confirmSpokenNumber: localized,
  /** After a successful save. */
  saved: localized,
  /** Added after `saved` ONLY when the tool result says a text message is expected. */
  smsNote: localized,
  /** The caller will not give a number: nothing is saved; points to e-mail / contact form. */
  numberRefused: localized,
  /** The tool failed: nothing is promised; points to e-mail / contact form. */
  failed: localized,
  /** The caller asks to be connected to a person (transfer is not offered on this line). */
  noTransfer: localized,
});

/**
 * VP-27. Protection for a number the caller dictates: how long Vapi waits after the "what number?"
 * question before deciding the caller has finished. Callers read digits in paused groups, and the
 * default wait cut in after three digits in real calls (VAPI-FACTS.md Vendor-swap R18).
 * Omitted = the normal endpointing everywhere.
 */
const numberDictationSchema = z.strictObject({
  /** `customEndpointingRules` timeout for the turn after the number question (Vapi: 0-15). */
  waitSeconds: z.number().min(0).max(15),
  /** `transcriptionEndpointingPlan.onNumberSeconds`: the wait after a transcript ending in a number (Vapi: 0-3). */
  onNumberSeconds: z.number().min(0).max(3).optional(),
});

export const consultationSchema = z.strictObject({
  /** The address given to callers when the flow cannot finish; also used in the SMS. */
  contactEmail: z.email('must be an e-mail address'),
  /**
   * When staff contact callers, as spoken/written text per language. ONE value used by every
   * spoken line and the SMS (`[[contactHours]]`), so the wording cannot drift between them.
   */
  contactHours: localized,
  scripts: consultationScriptsSchema,
  numberDictation: numberDictationSchema.optional(),
});

export type ConsultationConfig = z.infer<typeof consultationSchema>;
export type ConsultationScriptKey = keyof ConsultationConfig['scripts'];

/** Every script key, in file order. Derived from the schema so it cannot drift. */
export const CONSULTATION_SCRIPT_KEYS = Object.keys(
  consultationSchema.shape.scripts.shape,
) as ConsultationScriptKey[];
