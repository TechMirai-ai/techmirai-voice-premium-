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
import type { AppointmentChangeNotification, BookingNotification } from './bookingNotifier.js';
import { formatBookingDate, sanitizeInline } from './template.js';

/** Shown in a staff alert where the booking has no value (no service, no caller number). */
const NO_VALUE = '-';

export interface NotificationJob {
  event: NotificationEvent;
  clientId: string;
  appointmentId: string;
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
  /** The staff alert for this event; undefined = the client set none. */
  lineTemplate(line: LineNotificationConfig): string | undefined;
  lineValues(config: ClientConfig): Record<string, string>;
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
