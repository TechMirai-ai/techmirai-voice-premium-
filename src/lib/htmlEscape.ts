/**
 * Shared HTML-escaping helper (VP-5 §4.4). Every place caller- or
 * staff-supplied text is written into a server-rendered page must go
 * through this first — the staff dashboard's `reason` field in particular is
 * free text a caller controls and may also hold health information (§1), so
 * this is a security requirement, not a style preference.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_PATTERN = /[&<>"']/g;

export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_PATTERN, (char) => HTML_ESCAPES[char] as string);
}
