/**
 * Base name shared by a call's audio and transcript files in Drive (VP-13):
 * `<date>-<time>-<topic>`, e.g. `2026-10-13-1542-reservation`. The two files differ only in
 * extension. Date and time are the clinic's local time (`business.hours.timezone` in client.yaml),
 * so the Drive folder reads naturally in Japan; the Sheet's "Started at" column stays UTC.
 * A collision (same minute, same topic) is resolved by the job store with a `-2`, `-3`… suffix.
 */
const NO_TOPIC = 'no-topic';
const MAX_TOPIC_CHARS = 40;

/** Topics are already slugs; this keeps a stray value from ever becoming a path-ish file name. */
function topicSlug(topic: string | undefined): string {
  const slug = (topic ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TOPIC_CHARS)
    .replace(/-+$/g, '');
  return slug || NO_TOPIC;
}

export function archiveBaseName(
  startedAt: Date | undefined,
  topic: string | undefined,
  timeZone: string,
): string {
  const when = startedAt && Number.isFinite(startedAt.getTime()) ? startedAt : new Date(0);
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
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}-${topicSlug(topic)}`;
}

/** The nth candidate for a base name: 1 → base, 2 → base-2, … */
export function withCollisionSuffix(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}
