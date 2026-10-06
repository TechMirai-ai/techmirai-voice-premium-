/**
 * Call budget for the public, link-shareable Talk demo page (VP-9). Two
 * independent gates, both server-side (CLAUDE.md: never just hide a client-side
 * button) — the caller cannot satisfy either one by editing browser state:
 *
 *   1. A signed, per-clientId cookie counts total calls made from this browser
 *      and caps them at TALK_CALL_CAP. Signed with HMAC-SHA256 so the count
 *      itself can't be edited (unlike plain localStorage) — a tampered or
 *      missing cookie is just treated as a fresh visitor (count 0), never as
 *      "unlimited". Note the inherent limit of any cookie-only scheme: a
 *      visitor can still get a fresh count by clearing cookies entirely. That
 *      is a known, accepted gap (matches what a cookie can offer), not an oversight.
 *   2. A shared `?key=` query value, compared against TALK_BYPASS_KEY in constant
 *      time, bypasses the cap entirely for the owner/staff link.
 *
 * The call's own 5-minute hard cap is handled separately, by Vapi itself
 * (`maxDurationSeconds`, passed as a call-start override) — see talkPage.ts.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TALK_CALL_CAP = 4;
export const TALK_CALL_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** Hard per-call cutoff enforced by Vapi itself, for every call (public or bypassed) alike. */
export const TALK_MAX_CALL_DURATION_SECONDS = 300;

export function talkCallCookieName(clientId: string): string {
  return `tmvp_talk_calls_${clientId}`;
}

function signCount(clientId: string, count: number, secret: string): string {
  const hmac = createHmac('sha256', secret).update(`${clientId}:${count}`).digest('hex');
  return `${count}.${hmac}`;
}

/** Malformed, missing, or tampered cookies are all just a fresh visitor — never "unlimited". */
function verifyCount(clientId: string, cookieValue: string, secret: string): number {
  const separatorIndex = cookieValue.lastIndexOf('.');
  if (separatorIndex === -1) return 0;

  const countPart = cookieValue.slice(0, separatorIndex);
  const signaturePart = cookieValue.slice(separatorIndex + 1);
  const count = Number.parseInt(countPart, 10);
  if (!Number.isInteger(count) || count < 0) return 0;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${clientId}:${count}`).digest('hex'),
  );
  const actual = Buffer.from(signaturePart);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 0;

  return count;
}

/** Fixed-length digests avoid any length-based timing signal, regardless of the provided key's length. */
export function isBypassKeyValid(provided: string | undefined, bypassKey: string): boolean {
  if (!provided) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(bypassKey).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/** Tiny, self-contained — avoids pulling in cookie-parser for a single read of one cookie. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() !== name) continue;
    return decodeURIComponent(part.slice(separatorIndex + 1).trim());
  }
  return undefined;
}

export interface TalkCallDecision {
  /** Whether this call may proceed. */
  allowed: boolean;
  /** True when allowed because of a valid bypass key — no cookie is read or written. */
  bypassed: boolean;
  /** Set only when the cap check actually ran and the count cookie should be updated. */
  newCookieValue?: string;
}

export function decideTalkCall(
  clientId: string,
  cookieHeader: string | undefined,
  providedKey: string | undefined,
  options: { rateLimitSecret: string; bypassKey: string },
): TalkCallDecision {
  if (isBypassKeyValid(providedKey, options.bypassKey)) {
    return { allowed: true, bypassed: true };
  }

  const existing = readCookie(cookieHeader, talkCallCookieName(clientId));
  const currentCount = existing ? verifyCount(clientId, existing, options.rateLimitSecret) : 0;

  if (currentCount >= TALK_CALL_CAP) {
    return { allowed: false, bypassed: false };
  }

  const nextCount = currentCount + 1;
  return {
    allowed: true,
    bypassed: false,
    newCookieValue: signCount(clientId, nextCount, options.rateLimitSecret),
  };
}
