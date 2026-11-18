/**
 * The optional `silenceTimings` section of `clients/<clientId>/client.yaml`: when each step of the
 * caller-silence flow (VP-16) fires. Every value is SECONDS OF CALLER SILENCE counted from when the
 * assistant stopped speaking, read as absolute offsets (docs/VAPI-FACTS.md VP-16 R1) — the numbers
 * Vapi's `customer.speech.timeout` hooks take as `timeoutSeconds` (whole seconds, 1–1000).
 *
 * Omit the whole section and the shared defaults below apply, so a client that never sets it
 * renders byte-for-byte as before. A partial section keeps the defaults for the fields it leaves
 * out; the order rule below then catches a default that no longer fits.
 *
 * Vapi measures this clock to the caller's FINAL transcript, not to voice activity, so a short
 * `nudgeAfterSeconds` can fire over a caller who is still talking (VAPI-FACTS.md VP-16 R4). A
 * client whose callers speak in long sentences should raise it.
 *
 * This file imports nothing from ./schema.ts (which imports it): see notificationsSchema.ts.
 */
import { z } from 'zod';

/** The shared defaults: 4 / 9 / 14 / 19 / 31 s (the owner's original VP-16 timings). */
export const DEFAULT_SILENCE_TIMINGS = {
  /** Step 1: the gentle fixed nudge (`scripts.silenceRepeat`). */
  nudgeAfterSeconds: 4,
  /** Step 2: "can you hear me?" (`scripts.silenceCheck1`). */
  firstCheckAfterSeconds: 9,
  /** Step 3: "are you still on the line?" (`scripts.silenceCheck2`). */
  secondCheckAfterSeconds: 14,
  /**
   * Step 4: the server announces the end and hangs up (`scripts.silenceEnding`). ASSUMED GAP, not
   * from the owner: 5 s after step 3, like the other steps. Confirm in a real call.
   */
  announceEndAfterSeconds: 19,
  /**
   * Step 5, BACKSTOP ONLY: the built-in `endCall`, for when step 4 did not end the call (it would
   * then play the standard goodbye). Keep it long enough after step 4 (about 12 s) for the
   * announcement (~4–6 s) to finish first.
   */
  hangUpAfterSeconds: 31,
} as const;

export type SilenceTimings = { -readonly [K in keyof typeof DEFAULT_SILENCE_TIMINGS]: number };

const STEPS = [
  'nudgeAfterSeconds',
  'firstCheckAfterSeconds',
  'secondCheckAfterSeconds',
  'announceEndAfterSeconds',
  'hangUpAfterSeconds',
] as const;

/** Whole seconds in Vapi's accepted 1–1000 range. */
const seconds = (fallback: number) => z.number().int().min(1).max(1000).default(fallback);

export const silenceTimingsSchema = z
  .strictObject({
    nudgeAfterSeconds: seconds(DEFAULT_SILENCE_TIMINGS.nudgeAfterSeconds),
    firstCheckAfterSeconds: seconds(DEFAULT_SILENCE_TIMINGS.firstCheckAfterSeconds),
    secondCheckAfterSeconds: seconds(DEFAULT_SILENCE_TIMINGS.secondCheckAfterSeconds),
    announceEndAfterSeconds: seconds(DEFAULT_SILENCE_TIMINGS.announceEndAfterSeconds),
    hangUpAfterSeconds: seconds(DEFAULT_SILENCE_TIMINGS.hangUpAfterSeconds),
  })
  .superRefine((timings, ctx) => {
    STEPS.forEach((step, index) => {
      const previous = STEPS[index - 1];
      if (previous === undefined || timings[step] > timings[previous]) return;
      ctx.addIssue({
        code: 'custom',
        path: [step],
        message: `must be later than ${previous} (${String(timings[previous])}): the steps run in order`,
      });
    });
  });
