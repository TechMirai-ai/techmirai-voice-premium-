/**
 * Canonical form of a caller-entered phone number (VP-15). The same number typed as
 * `090-1234-5678`, `０９０ １２３４ ５６７８` or `+81 90 1234 5678` must compare equal, because the
 * returning-caller lookup matches on the stored string.
 *
 * Japanese numbers are stored as national digits (`09012345678`); any other international number
 * as `+` and digits. Anything else is rejected.
 */
const FULL_WIDTH_DIGITS = /[０-９]/g;
const SEPARATORS = /[\s().\-‐‑‒–—―ー－]/g;
const JAPAN_NATIONAL = /^0\d{9,10}$/;
const INTERNATIONAL = /^\+\d{8,15}$/;
const JAPAN_COUNTRY_CODE = '+81';

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The dialable E.164 form (`+819012345678`) of a number as stored by `normalizeCallerPhone`, or
 * undefined when it cannot be dialled. A national number (leading `0`) gets `defaultCountryCode`
 * (e.g. `+81`) with the trunk `0` dropped; a `+…` number is already international.
 */
export function toE164(stored: string, defaultCountryCode: string): string | undefined {
  const candidate = stored.startsWith('0') ? `${defaultCountryCode}${stored.slice(1)}` : stored;
  return E164.test(candidate) ? candidate : undefined;
}

export function normalizeCallerPhone(raw: string): string | undefined {
  const compact = raw
    .normalize('NFKC')
    .replace(FULL_WIDTH_DIGITS, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[(（]0[)）]/g, '')
    .replace(SEPARATORS, '');

  if (compact.startsWith(JAPAN_COUNTRY_CODE)) {
    const national = `0${compact.slice(JAPAN_COUNTRY_CODE.length).replace(/^0/, '')}`;
    return JAPAN_NATIONAL.test(national) ? national : undefined;
  }
  if (JAPAN_NATIONAL.test(compact)) return compact;
  return INTERNATIONAL.test(compact) ? compact : undefined;
}
