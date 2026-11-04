/**
 * Fills a client's notification template. Templates use `[[name]]` placeholders (validated at
 * config-load time by src/config/notificationRules.ts), so by the time one reaches here every
 * placeholder is known; an unfilled one renders as empty rather than leaking `[[name]]` to a
 * caller's phone.
 */
import { NOTIFICATION_PLACEHOLDER_PATTERN } from '../config/notificationRules.js';

export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(
    NOTIFICATION_PLACEHOLDER_PATTERN,
    (_match, name: string) => values[name.trim()] ?? '',
  );
}

/** Control characters (incl. CR/LF/tab) and the Unicode line/paragraph separators. */
const LINE_BREAKING_OR_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
/**
 * Invisible "format" characters (Unicode category Cf): bidi overrides/isolates (U+202A–202E,
 * U+2066–2069) that reorder what staff read, zero-width characters (U+200B–200D, U+2060, U+FEFF)
 * that hide text, the soft hyphen. They carry no visible content, so they are dropped, not turned
 * into a space (which would split a word).
 */
const INVISIBLE_FORMAT = /\p{Cf}+/gu;
export const MAX_INLINE_VALUE_LENGTH = 100;

/**
 * Makes caller-supplied text safe to drop into ONE line of a message: invisible format characters
 * are dropped, line breaks and control characters become a single space, runs of whitespace
 * collapse, the result is trimmed and capped. Without this a name such as "Tanaka\n【緊急】 …"
 * could forge extra lines in the staff alert, and a bidi override could reorder what staff read.
 * May return an empty string — callers show a placeholder for that.
 */
export function sanitizeInline(value: string, maxLength = MAX_INLINE_VALUE_LENGTH): string {
  return Array.from(
    value
      .replace(INVISIBLE_FORMAT, '')
      .replace(LINE_BREAKING_OR_CONTROL, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, maxLength)
    .join('')
    .trim();
}

/**
 * `2026-11-03` as the language's own long date ("2026年11月3日", "November 3, 2026"). The language
 * code is the locale, so a new language needs no code. A calendar date has no time zone, so it is
 * formatted in UTC to keep the day from shifting; an unusable code or date falls back to the
 * ISO text, which is still unambiguous.
 */
export function formatBookingDate(isoDate: string, language: string): string {
  const instant = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) return isoDate;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long', timeZone: 'UTC' }).format(
      instant,
    );
  } catch {
    return isoDate;
  }
}
