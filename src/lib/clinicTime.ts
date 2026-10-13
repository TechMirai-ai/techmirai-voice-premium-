/**
 * Display formatting for the staff dashboard: instants are stored in UTC and shown in the clinic's
 * own timezone (`business.hours.timezone` in client.yaml — Asia/Tokyo for the demo clinic).
 * Display only; nothing here changes what is stored.
 */

/** `2026-10-13 20:14` — a fixed, sortable, locale-independent format. */
export function formatClinicDateTime(when: Date, timeZone: string): string {
  if (!Number.isFinite(when.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(when)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Column-header label for a timezone: "JST" for Japan, otherwise its UTC offset (e.g. "UTC+1"). */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  if (timeZone === 'Asia/Tokyo') return 'JST';
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  return offset.replace('GMT', 'UTC').replace(/^UTC[+-]0$/, 'UTC') || 'UTC';
}
