/**
 * Shared phone-number normalization for the reservation tools (VP-8) — folds
 * full-width digits/spaces to ASCII and strips everything but digits, the
 * same rule `callbackRequest.ts` applies inline (kept separate there per the
 * work order's "additive only, nothing about the existing flow changes").
 */
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

export function normalizePhoneDigits(raw: string): string {
  return raw.normalize('NFKC').replace(/\D/g, '');
}

export function isValidPhoneDigitCount(digits: string): boolean {
  return digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
}
