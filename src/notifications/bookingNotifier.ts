/**
 * Tells people about a successful booking (VP-23): a factual confirmation SMS to the caller and an
 * alert to the client's staff on LINE.
 *
 * Generic by construction. Nothing here names a clinic, a Telnyx profile, a LINE channel or a
 * recipient: all of it comes from the client's `notifications` block in client.yaml, with
 * secrets looked up by env-var NAME from the environment. A second client is a new yaml block and
 * new `.env` entries.
 *
 * Failure policy (FUTURE-FEATURES F-2): the booking is already saved before this runs, and
 * `notifyBooked` never rejects — a down provider, a missing key or a database hiccup in the log
 * is recorded and swallowed, never shown to the caller or allowed to undo the booking.
 */
import { randomUUID } from 'node:crypto';

import type {
  LineNotificationConfig,
  SmsNotificationConfig,
} from '../config/notificationsSchema.js';
import type { ClientConfig } from '../config/schema.js';
import { toE164 } from '../lib/callerPhone.js';
import { logger } from '../lib/logger.js';
import type {
  NewNotificationLogEntry,
  NotificationChannel,
  NotificationLogRepository,
} from '../repositories/notificationLogRepository.js';
import { deliveryErrorCode } from './deliveryError.js';
import type { LinePusher } from './linePush.js';
import type { SmsSender } from './telnyxSms.js';
import { formatBookingDate, renderTemplate } from './template.js';

/** Looks up a secret/identifier by the env-var name a client's config gave. */
export type CredentialLookup = (envName: string) => string | undefined;

export interface BookingNotification {
  clientId: string;
  appointmentId: string;
  reservationNumber: string;
  /** The call's language — picks the caller's SMS template. */
  language: string;
  patientName: string;
  serviceName: string | null;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM, clinic-local
  /** The caller's number as stored (normalised); undefined when the call carried none. */
  callerPhone?: string;
}

export interface BookingNotifier {
  /** Never rejects. */
  notifyBooked(booking: BookingNotification): Promise<void>;
}

export interface BookingNotifierDeps {
  loadConfig(clientId: string): ClientConfig;
  credential: CredentialLookup;
  sms: SmsSender;
  line: LinePusher;
  log: NotificationLogRepository;
  now?: () => Date;
}

type LogExtras = Pick<NewNotificationLogEntry, 'recipientRef' | 'providerMessageId'>;

const SMS_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Shown in a staff alert where the booking has no value (no service, no caller number). */
const NO_VALUE = '-';

export class ChannelBookingNotifier implements BookingNotifier {
  constructor(private readonly deps: BookingNotifierDeps) {}

  async notifyBooked(booking: BookingNotification): Promise<void> {
    try {
      const config = this.deps.loadConfig(booking.clientId);
      const sms = config.notifications?.sms;
      const line = config.notifications?.line;
      await Promise.all([
        sms ? this.sendSms(booking, config, sms) : undefined,
        line ? this.sendLine(booking, config, line) : undefined,
      ]);
    } catch (error) {
      logger.error('booking notification failed', {
        clientId: booking.clientId,
        appointmentId: booking.appointmentId,
        reason: deliveryErrorCode(error),
      });
    }
  }

  private async sendSms(
    booking: BookingNotification,
    config: ClientConfig,
    sms: SmsNotificationConfig,
  ): Promise<void> {
    const to = booking.callerPhone
      ? toE164(booking.callerPhone, sms.defaultCountryCode)
      : undefined;
    if (!booking.callerPhone) return this.record(booking, 'sms', 'skipped', 'no_caller_number');
    if (!to) return this.record(booking, 'sms', 'skipped', 'invalid_caller_number');

    const apiKey = this.deps.credential(sms.apiKeyEnv);
    if (!apiKey) return this.skipMissingCredential(booking, 'sms', sms.apiKeyEnv);

    const template = sms.templates[booking.language] ?? sms.templates[config.languages.default];
    if (!template) return this.record(booking, 'sms', 'skipped', 'no_template');

    const sentRecently = await this.deps.log.countSmsSentToNumber(
      booking.clientId,
      booking.callerPhone,
      new Date(this.now().getTime() - SMS_RATE_WINDOW_MS),
    );
    if (sentRecently >= sms.maxPerRecipientPerDay) {
      return this.record(booking, 'sms', 'skipped', 'rate_limited');
    }

    try {
      const { messageId } = await this.deps.sms.send({
        apiKey,
        messagingProfileId: sms.messagingProfileId,
        from: sms.senderId,
        to,
        text: renderTemplate(template, {
          businessName: businessName(config, booking.language),
          date: formatBookingDate(booking.date, booking.language),
          time: booking.time,
        }),
        idempotencyKey: `booking-${booking.appointmentId}-sms`,
      });
      await this.record(booking, 'sms', 'sent', undefined, { providerMessageId: messageId });
    } catch (error) {
      await this.record(booking, 'sms', 'failed', deliveryErrorCode(error));
    }
  }

  private async sendLine(
    booking: BookingNotification,
    config: ClientConfig,
    line: LineNotificationConfig,
  ): Promise<void> {
    const accessToken = this.deps.credential(line.channelAccessTokenEnv);
    if (!accessToken)
      return this.skipMissingCredential(booking, 'line', line.channelAccessTokenEnv);

    const language = config.languages.default; // staff read the client's default language
    const text = renderTemplate(line.messageTemplate, {
      businessName: businessName(config, language),
      date: formatBookingDate(booking.date, language),
      time: booking.time,
      patientName: booking.patientName,
      patientPhone: booking.callerPhone ?? NO_VALUE,
      reservationNumber: booking.reservationNumber,
      serviceName: booking.serviceName ?? NO_VALUE,
    });

    await Promise.all(
      line.recipientEnvs.map((recipientEnv) =>
        this.pushToRecipient(booking, accessToken, recipientEnv, text),
      ),
    );
  }

  private async pushToRecipient(
    booking: BookingNotification,
    accessToken: string,
    recipientEnv: string,
    text: string,
  ): Promise<void> {
    const to = this.deps.credential(recipientEnv);
    if (!to) return this.skipMissingCredential(booking, 'line', recipientEnv);

    try {
      const { messageId } = await this.deps.line.push({
        accessToken,
        to,
        text,
        retryKey: randomUUID(),
      });
      await this.record(booking, 'line', 'sent', undefined, {
        recipientRef: recipientEnv,
        ...(messageId ? { providerMessageId: messageId } : {}),
      });
    } catch (error) {
      await this.record(booking, 'line', 'failed', deliveryErrorCode(error), {
        recipientRef: recipientEnv,
      });
    }
  }

  private async skipMissingCredential(
    booking: BookingNotification,
    channel: NotificationChannel,
    envName: string,
  ): Promise<void> {
    // The env var NAME is configuration, not a secret, and tells the operator what to set.
    logger.warn('notification credential not set', {
      clientId: booking.clientId,
      channel,
      envVar: envName,
    });
    await this.record(booking, channel, 'skipped', 'missing_credentials', {
      recipientRef: envName,
    });
  }

  /** Writes the delivery row; a failure to log is logged, never thrown. */
  private async record(
    booking: BookingNotification,
    channel: NotificationChannel,
    status: NewNotificationLogEntry['status'],
    detail?: string,
    extras: LogExtras = {},
  ): Promise<void> {
    logger.info('booking notification', {
      clientId: booking.clientId,
      appointmentId: booking.appointmentId,
      channel,
      status,
      ...(detail ? { detail } : {}),
    });
    try {
      await this.deps.log.record({
        clientId: booking.clientId,
        appointmentId: booking.appointmentId,
        channel,
        status,
        ...(detail ? { detail } : {}),
        ...extras,
      });
    } catch (error) {
      logger.error('notification log write failed', {
        clientId: booking.clientId,
        appointmentId: booking.appointmentId,
        channel,
        reason: deliveryErrorCode(error),
      });
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** The business name in `language`, falling back to the client's default language. */
function businessName(config: ClientConfig, language: string): string {
  return config.business.name[language] ?? config.business.name[config.languages.default] ?? '';
}
