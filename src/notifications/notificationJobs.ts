/**
 * What to tell people for each kind of appointment event (VP-23 booking, VP-25 cancel/reschedule).
 *
 * The delivery pipeline in ./bookingNotifier.ts — caps, one send per call, the delivery log,
 * failure isolation — is the same for every event. A job is only the part that differs: which
 * template a client configured for the event, and the values that fill it. Everything here is pure.
 */
import type {
  LineNotificationConfig,
  SmsNotificationConfig,
} from '../config/notificationsSchema.js';
import type { ClientConfig } from '../config/schema.js';
import type { NotificationEvent } from '../repositories/notificationLogRepository.js';
import { formatClinicDateTime } from '../lib/clinicTime.js';
import type {
  AppointmentChangeNotification,
  BookingNotification,
  ConsultationNotification,
} from './bookingNotifier.js';
import { formatBookingDate, sanitizeInline } from './template.js';

/** How the caller's SMS ended — the consultation staff alert reports it. `detail` is a reason code. */
export type SmsOutcome = { status: 'sent' } | { status: 'skipped' | 'failed'; detail: string };

/** What the cooldown gate needs from the consultation requests table. */
export interface ConsultationCooldownSource {
  /** Requests by this number for this client created at or after `since`, not counting `exceptRequestId`. */
  countByPhoneSince(
    clientId: string,
    phone: string,
    since: Date,
    exceptRequestId: string,
  ): Promise<number>;
}

/** Shown in a staff alert where the booking has no value (no service, no caller number). */
const NO_VALUE = '-';

export interface NotificationJob {
  event: NotificationEvent;
  clientId: string;
  /** Absent for an event that is not about an appointment (a consultation request). */
  appointmentId?: string;
  /** The call that CAUSED this notification: at most one send per call, channel and event. */
  callId: string;
  /** The call's language — picks the caller's SMS template. */
  language: string;
  /** The caller's number as stored (normalised); undefined when the call carried none. */
  callerPhone?: string;
  /** Telnyx de-duplicates on this: one per real-world event, never shared between events. */
  smsIdempotencyKey: string;
  /** The caller's SMS texts per language for this event; undefined = the client set none. */
  smsTemplates(sms: SmsNotificationConfig): Readonly<Record<string, string>> | undefined;
  smsValues(config: ClientConfig): Record<string, string>;
  /**
   * An extra check run just before the SMS claims a send slot: a reason code to skip with, or
   * undefined to go ahead. A throw is handled like a failed send, never shown to the caller.
   */
  smsGate?(sms: SmsNotificationConfig): Promise<string | undefined>;
  /** The staff alert for this event; undefined = the client set none. */
  lineTemplate(line: LineNotificationConfig): string | undefined;
  /** `smsOutcome` is set only for a job with `lineAfterSms`. */
  lineValues(config: ClientConfig, smsOutcome?: SmsOutcome): Record<string, string>;
  /** True = send the SMS first and tell staff how it went; false/absent = both channels at once. */
  lineAfterSms?: boolean;
}

/** The business name in `language`, falling back to the client's default language. */
function businessName(config: ClientConfig, language: string): string {
  return config.business.name[language] ?? config.business.name[config.languages.default] ?? '';
}

interface StaffAlertFields {
  patientName: string;
  serviceName: string | null;
  reservationNumber: string;
  callerPhone?: string | undefined;
}

/**
 * The staff alert's values. Staff read the client's default language. Caller-supplied text goes on
 * ONE line each: no forged extra lines in the alert, and a name that is nothing but invisible
 * characters shows a placeholder, not a blank.
 */
function staffValues(
  config: ClientConfig,
  fields: StaffAlertFields,
  date: string,
  time: string,
): Record<string, string> {
  const language = config.languages.default;
  return {
    businessName: businessName(config, language),
    date: formatBookingDate(date, language),
    time,
    patientName: sanitizeInline(fields.patientName) || NO_VALUE,
    patientPhone: fields.callerPhone ?? NO_VALUE,
    reservationNumber: fields.reservationNumber,
    serviceName: sanitizeInline(fields.serviceName ?? '') || NO_VALUE,
  };
}

export function bookedJob(booking: BookingNotification): NotificationJob {
  return {
    event: 'booked',
    clientId: booking.clientId,
    appointmentId: booking.appointmentId,
    callId: booking.callId,
    language: booking.language,
    ...(booking.callerPhone ? { callerPhone: booking.callerPhone } : {}),
    smsIdempotencyKey: `booking-${booking.appointmentId}-sms`,
    smsTemplates: (sms) => sms.templates,
    smsValues: (config) => ({
      businessName: businessName(config, booking.language),
      date: formatBookingDate(booking.date, booking.language),
      time: booking.time,
    }),
    lineTemplate: (line) => line.messageTemplate,
    lineValues: (config) => staffValues(config, booking, booking.date, booking.time),
  };
}

export function changedJob(change: AppointmentChangeNotification): NotificationJob {
  return {
    event: change.kind,
    clientId: change.clientId,
    appointmentId: change.appointmentId,
    callId: change.callId,
    language: change.language,
    ...(change.callerPhone ? { callerPhone: change.callerPhone } : {}),
    // One change per call, so the call id separates a second change to the same booking.
    smsIdempotencyKey: `change-${change.appointmentId}-${change.callId}-sms`,
    smsTemplates: (sms) => sms.changeTemplates?.[change.kind],
    smsValues: (config) => ({
      businessName: businessName(config, change.language),
      date: formatBookingDate(change.date, change.language),
      time: change.time,
    }),
    lineTemplate: (line) => line.changeTemplates?.[change.kind],
    lineValues: (config) => ({
      ...staffValues(config, change, change.date, change.time),
      oldDate: formatBookingDate(change.oldDate, config.languages.default),
      oldTime: change.oldTime,
    }),
  };
}

const HOUR_MS = 60 * 60 * 1000;
const NO_REASON = '-';
const SMS_NOT_SENT = 'not sent';

/** Staff read English here: plain words for each reason code a consultation SMS can end with. */
const SMS_REASON_WORDS: Readonly<Record<string, string>> = {
  no_caller_number: 'no number',
  invalid_caller_number: 'number not valid',
  country_not_allowed: 'not a Japanese number',
  number_type_not_allowed: 'not a mobile number (landline or other)',
  cooldown: 'this number already got a text in the last day',
  daily_limit: "the client's daily text limit was reached",
  call_limit: 'a text was already sent for this call',
  rate_limited: 'this number reached its daily text limit',
  missing_credentials: 'SMS is not set up (missing credentials)',
  no_template: 'no text template for this language',
  sms_not_configured: 'SMS is not set up for this client',
};

/** "sent", "skipped - <why>" or "failed - <code>": one line for the staff alert. */
export function smsStatusText(outcome: SmsOutcome | undefined): string {
  if (!outcome) return SMS_NOT_SENT;
  if (outcome.status === 'sent') return 'sent';
  const why = SMS_REASON_WORDS[outcome.detail] ?? outcome.detail;
  return `${outcome.status} - ${why}`;
}

const PHONE_SOURCE_WORDS: Readonly<Record<ConsultationNotification['phoneSource'], string>> = {
  caller_id: 'caller ID (the number they called from)',
  spoken: 'spoken by the caller',
};

/** The language's own name in English ("Japanese"), falling back to the code. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames('en', { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A consultation request (TechMirai's own agent): a thank-you SMS to the caller and an alert to
 * staff that says how the SMS went. `cooldown` is the per-number gate; without one it is skipped.
 */
export function consultationJob(
  request: ConsultationNotification,
  cooldown: ConsultationCooldownSource | undefined,
  now: Date,
): NotificationJob {
  const { contactPhone } = request;
  return {
    event: 'consultation_requested',
    clientId: request.clientId,
    callId: request.callId,
    language: request.language,
    ...(contactPhone ? { callerPhone: contactPhone } : {}),
    smsIdempotencyKey: `consultation-${request.requestId}-sms`,
    lineAfterSms: true,
    smsTemplates: (sms) => sms.consultationTemplates,
    smsValues: (config) => ({
      businessName: businessName(config, request.language),
      contactHours: config.consultation?.contactHours[request.language] ?? '',
      contactEmail: config.consultation?.contactEmail ?? '',
    }),
    smsGate: async (sms) => {
      if (!cooldown || !contactPhone || !sms.consultationCooldownHours) return undefined;
      const since = new Date(now.getTime() - sms.consultationCooldownHours * HOUR_MS);
      const earlier = await cooldown.countByPhoneSince(
        request.clientId,
        contactPhone,
        since,
        request.requestId,
      );
      return earlier > 0 ? 'cooldown' : undefined;
    },
    lineTemplate: (line) => line.consultationTemplate,
    lineValues: (config, smsOutcome) => ({
      businessName: businessName(config, config.languages.default),
      time: formatClinicDateTime(request.createdAt, config.business.hours.timezone),
      language: languageName(request.language),
      contactName: sanitizeInline(request.contactName) || NO_REASON,
      contactPhone: contactPhone ?? NO_REASON,
      phoneSource: PHONE_SOURCE_WORDS[request.phoneSource],
      reason: sanitizeInline(request.reason ?? '', 300) || NO_REASON,
      smsStatus: smsStatusText(smsOutcome),
    }),
  };
}
