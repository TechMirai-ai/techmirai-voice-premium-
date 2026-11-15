/**
 * Which stored numbers a client's SMS settings allow a text to — one rule, used by the notifier
 * (to skip with a reason) and by the consultation tool (to tell the model whether to mention a
 * text message). Pure.
 */
import type { SmsNotificationConfig } from '../config/notificationsSchema.js';
import { toE164 } from '../lib/callerPhone.js';

export type SmsNumberRejection =
  'invalid_caller_number' | 'country_not_allowed' | 'number_type_not_allowed';

export type SmsNumberCheck =
  { to: string; rejection?: undefined } | { to?: undefined; rejection: SmsNumberRejection };

/**
 * `stored` is a number as the project stores it (src/lib/callerPhone.ts): national digits for
 * Japan, `+…` otherwise. Returns the E.164 number to text, or why it may not be texted.
 * `allowedNumberPrefixes` is opt-in per client (e.g. Japanese 070/080/090 mobiles only).
 */
export function checkSmsNumber(stored: string, sms: SmsNotificationConfig): SmsNumberCheck {
  const to = toE164(stored, sms.defaultCountryCode);
  if (!to) return { rejection: 'invalid_caller_number' };
  if (!sms.allowedCountryCodes.some((countryCode) => to.startsWith(countryCode))) {
    return { rejection: 'country_not_allowed' };
  }
  if (
    sms.allowedNumberPrefixes &&
    !sms.allowedNumberPrefixes.some((prefix) => to.startsWith(prefix))
  ) {
    return { rejection: 'number_type_not_allowed' };
  }
  return { to };
}
