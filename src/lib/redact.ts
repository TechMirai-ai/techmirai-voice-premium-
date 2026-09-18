/**
 * Personal-data redaction for logs.
 *
 * Callers' names and phone numbers are personal data under Japan's APPI
 * (Act on the Protection of Personal Information). Nothing may reach a log
 * sink without passing through here first — see src/lib/logger.ts.
 *
 * WHAT THIS CAN AND CANNOT DO
 * Phone numbers are recognised anywhere, including inside free text, because
 * they have a recognisable shape. NAMES DO NOT: they are only redacted when
 * they arrive as the value of a known key (see SENSITIVE_KEYS). There is no
 * reliable way to spot a Japanese name inside a sentence.
 *
 * So: always pass personal data as structured context —
 *     logger.info('callback saved', { callerName, callerPhone })
 * and never interpolate it into the message —
 *     logger.info(`callback saved for ${callerName}`)   // LEAKS THE NAME
 */

export const PHONE_MASK = '[redacted:phone]';
export const VALUE_MASK = '[redacted]';

/**
 * Object keys whose value is always masked, whatever it looks like.
 * Compared case-insensitively. `name` is deliberately included even though it
 * is a common key: masking a clinic name in a log line is harmless, leaking a
 * caller's name is not. Log identifiers such as `clientId` instead.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'callername',
  'phone',
  'callerphone',
  'phonenumber',
  'tel',
]);

/** A run of digits this long or longer is treated as a phone number. */
const MIN_PHONE_DIGITS = 10;
/** E.164 allows at most 15 digits; longer runs are some other kind of number. */
const MAX_PHONE_DIGITS = 15;

/** How deep to walk into nested objects before giving up. */
const MAX_DEPTH = 8;

/**
 * Candidate phone-like runs: an optional leading `+` (ASCII or full-width),
 * then digits mixed with the separators people actually type — spaces,
 * hyphens of several Unicode flavours, dots and brackets.
 */
const PHONE_CANDIDATE = /[+＋]?[0-9０-９][0-9０-９()（）\s.\-‐‑‒–—―ー－]{5,20}[0-9０-９]/g;
const DIGIT = /[0-9０-９]/g;

const countDigits = (value: string): number => (value.match(DIGIT) ?? []).length;

/** Masks phone-number-like sequences inside free text. */
export function redactText(text: string): string {
  return text.replace(PHONE_CANDIDATE, (match) => {
    const digits = countDigits(match);
    return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS ? PHONE_MASK : match;
  });
}

const isSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(key.toLowerCase());

/**
 * Returns a redacted copy of `value`. The input is never mutated.
 *
 * - strings: phone-like sequences are masked;
 * - objects/arrays: walked recursively, and any value under a sensitive key
 *   (`name`, `callerName`, `phone`, `callerPhone`, …) is replaced wholesale;
 * - everything else is returned unchanged.
 */
export function redactPersonalData(value: string): string;
export function redactPersonalData(value: unknown): unknown;
export function redactPersonalData(value: unknown): unknown {
  return redactValue(value, 0, new Set());
}

function redactValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return VALUE_MASK;

  // Only the current branch counts as a cycle. A plain object referenced twice
  // in the same payload is not circular and must still be logged in full.
  if (ancestors.has(value)) return '[circular]';

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, ancestors));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? VALUE_MASK : redactValue(entry, depth + 1, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}
