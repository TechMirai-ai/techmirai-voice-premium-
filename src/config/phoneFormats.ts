/**
 * Phone-number formats shared by the config sections that dial or allow-list numbers
 * (`notifications.sms`, `transfer`). No imports, so any schema file can use it without a cycle.
 */

/** E.164: `+` then 7–15 digits, first digit non-zero. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * `+81`-style country calling code, used as a PREFIX allow-list for destinations. At least two
 * digits, except `+1` and `+7`, the only one-digit codes in use — a stray `+8` would otherwise
 * admit China, Korea, Japan, Vietnam… as a prefix.
 */
export const COUNTRY_CODE_PATTERN = /^\+(?:[17]|[1-9]\d{1,2})$/;
