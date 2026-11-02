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
