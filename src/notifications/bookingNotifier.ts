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
 *
 * Abuse guards (the public /talk page lets anyone type a number): an SMS only goes to an allowed
 * country, and both channels stop at daily caps. Each send first RESERVES its slot (a `pending`
 * log row) and only then counts, so simultaneous bookings cannot all slip past the cap. If the
 * log is unreachable the guard cannot be checked, so the send is skipped (fails closed).
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
  ReservedCounts,
  Settlement,
} from '../repositories/notificationLogRepository.js';
import { deliveryErrorCode } from './deliveryError.js';
import type { LinePusher } from './linePush.js';
import type { SmsSender } from './telnyxSms.js';
import { formatBookingDate, renderTemplate, sanitizeInline } from './template.js';

/** Looks up a secret/identifier by the env-var name a client's config gave. */
export type CredentialLookup = (envName: string) => string | undefined;

export interface BookingNotification {
  clientId: string;
  appointmentId: string;
  /** The Vapi call that made the booking — at most one SMS and one LINE alert per call. */
  callId: string;
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

/**
 * The ceilings a send must stay under. `perNumber` applies to SMS only. One send per call and
 * channel is a fixed rule, not a setting: a call books one appointment, and letting a single call
 * book repeatedly is how a public page could be made to burn a client's whole daily budget.
 */
interface Caps {
  perClientPerDay: number;
  perNumber?: { phone: string; max: number };
}

const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A send that has been `pending` longer than this was abandoned (a live one takes seconds). */
const PENDING_STALE_MS = 5 * 60 * 1000;
const MAX_SENDS_PER_CALL_AND_CHANNEL = 1;
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
        sms ? this.guarded(booking, 'sms', () => this.sendSms(booking, config, sms)) : undefined,
        line
          ? this.guarded(booking, 'line', () => this.sendLine(booking, config, line))
          : undefined,
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
    if (!sms.allowedCountryCodes.some((countryCode) => to.startsWith(countryCode))) {
      return this.record(booking, 'sms', 'skipped', 'country_not_allowed');
    }

    const apiKey = this.deps.credential(sms.apiKeyEnv);
    if (!apiKey) return this.skipMissingCredential(booking, 'sms', sms.apiKeyEnv);

    const template = sms.templates[booking.language] ?? sms.templates[config.languages.default];
    if (!template) return this.record(booking, 'sms', 'skipped', 'no_template');

    const reservationId = await this.reserveWithinCaps(booking, 'sms', {
      perClientPerDay: sms.maxPerDay,
      perNumber: { phone: booking.callerPhone, max: sms.maxPerRecipientPerDay },
    });
    if (!reservationId) return;

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
      await this.settle(booking, 'sms', reservationId, {
        status: 'sent',
        providerMessageId: messageId,
      });
    } catch (error) {
      await this.settle(booking, 'sms', reservationId, {
        status: 'failed',
        detail: deliveryErrorCode(error),
      });
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
    // Caller-supplied text goes on ONE line each: no forged extra lines in the staff alert, and a
    // name that is nothing but invisible characters shows a placeholder, not a blank.
    const text = renderTemplate(line.messageTemplate, {
      businessName: businessName(config, language),
      date: formatBookingDate(booking.date, language),
      time: booking.time,
      patientName: sanitizeInline(booking.patientName) || NO_VALUE,
      patientPhone: booking.callerPhone ?? NO_VALUE,
      reservationNumber: booking.reservationNumber,
      serviceName: sanitizeInline(booking.serviceName ?? '') || NO_VALUE,
    });

    // A recipient whose variable is unset is skipped on its own and never counts toward a cap.
    const recipients: { envName: string; to: string }[] = [];
    for (const envName of line.recipientEnvs) {
      const to = this.deps.credential(envName);
      if (to) recipients.push({ envName, to });
      else await this.skipMissingCredential(booking, 'line', envName);
    }
    if (recipients.length === 0) return;

    // ONE reservation per booking, however many staff it fans out to: `maxPerDay` is alerts
    // (bookings), not individual pushes, so adding a recipient never shrinks the budget and a
    // cap hit can never tell some staff and not others.
    const reservationId = await this.reserveWithinCaps(
      booking,
      'line',
      { perClientPerDay: line.maxPerDay },
      recipients.map((recipient) => recipient.envName).join(','),
    );
    if (!reservationId) return;

    const outcomes = await Promise.all(
      recipients.map(async ({ to }) => {
        try {
          const { messageId } = await this.deps.line.push({
            accessToken,
            to,
            text,
            retryKey: randomUUID(),
          });
          return { ok: true as const, messageId };
        } catch (error) {
          return { ok: false as const, detail: deliveryErrorCode(error) };
        }
      }),
    );
    await this.settle(booking, 'line', reservationId, settleLine(outcomes));
  }

  /**
   * Claims a send slot: inserts a `pending` row, then counts live rows (`sent`, or `pending` for
   * under PENDING_STALE_MS; its own included) in the last 24 h. Over a cap → the row is settled as
   * `skipped` and undefined is returned. Because every request inserts BEFORE it counts, the
   * request that counts last sees all the others' reservations, so together they can never exceed
   * a cap (concurrent requests may both be refused, which is the safe direction). A request that
   * crashed mid-send leaves a stale `pending` row that stops counting after PENDING_STALE_MS, so it
   * cannot hold a slot for a day. Throws if the log is unreachable.
   */
  private async reserveWithinCaps(
    booking: BookingNotification,
    channel: NotificationChannel,
    caps: Caps,
    recipientRef?: string,
  ): Promise<string | undefined> {
    const reservationId = await this.deps.log.reserve({
      clientId: booking.clientId,
      appointmentId: booking.appointmentId,
      channel,
      ...(recipientRef ? { recipientRef } : {}),
    });
    const nowMs = this.now().getTime();
    const counts = await this.deps.log.countReserved({
      clientId: booking.clientId,
      channel,
      since: new Date(nowMs - RATE_WINDOW_MS),
      pendingSince: new Date(nowMs - PENDING_STALE_MS),
      callId: booking.callId,
      ...(caps.perNumber ? { patientPhone: caps.perNumber.phone } : {}),
    });

    const refusal = refusalReason(counts, caps);
    if (!refusal) return reservationId;

    if (refusal === 'daily_limit') {
      // Real patients and staff are now going without this channel until the window rolls — make
      // that visible to whoever watches the logs. Identifiers only, no personal data.
      logger.warn('notification daily cap reached', {
        clientId: booking.clientId,
        channel,
        maxPerDay: caps.perClientPerDay,
      });
    }
    await this.settle(booking, channel, reservationId, { status: 'skipped', detail: refusal });
    return undefined;
  }

  /** Runs one channel's work; a failure is logged and never reaches the other channel or the caller. */
  private async guarded(
    booking: BookingNotification,
    channel: NotificationChannel,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      logger.error('booking notification failed', {
        clientId: booking.clientId,
        appointmentId: booking.appointmentId,
        channel,
        reason: deliveryErrorCode(error),
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

  /** Moves a reserved row to its final status; a failure to log is logged, never thrown. */
  private async settle(
    booking: BookingNotification,
    channel: NotificationChannel,
    reservationId: string,
    settlement: Settlement,
  ): Promise<void> {
    this.logOutcome(booking, channel, settlement.status, settlement.detail);
    try {
      await this.deps.log.settle(reservationId, settlement);
    } catch (error) {
      this.logWriteFailure(booking, channel, error);
    }
  }

  /** Writes a final delivery row; a failure to log is logged, never thrown. */
  private async record(
    booking: BookingNotification,
    channel: NotificationChannel,
    status: NewNotificationLogEntry['status'],
    detail?: string,
    extras: LogExtras = {},
  ): Promise<void> {
    this.logOutcome(booking, channel, status, detail);
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
      this.logWriteFailure(booking, channel, error);
    }
  }

  private logOutcome(
    booking: BookingNotification,
    channel: NotificationChannel,
    status: string,
    detail?: string,
  ): void {
    logger.info('booking notification', {
      clientId: booking.clientId,
      appointmentId: booking.appointmentId,
      channel,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  private logWriteFailure(
    booking: BookingNotification,
    channel: NotificationChannel,
    error: unknown,
  ): void {
    logger.error('notification log write failed', {
      clientId: booking.clientId,
      appointmentId: booking.appointmentId,
      channel,
      reason: deliveryErrorCode(error),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/**
 * Why a reserved send must not go ahead, or undefined if it may. Counts include the send's own
 * reservation, hence `>`. The per-call rule is checked first: a repeat within one call is the
 * quietest refusal and must not be reported as the client's daily budget running out.
 */
function refusalReason(
  counts: ReservedCounts,
  caps: Caps,
): 'call_limit' | 'daily_limit' | 'rate_limited' | undefined {
  if (counts.forCall > MAX_SENDS_PER_CALL_AND_CHANNEL) return 'call_limit';
  if (counts.forClient > caps.perClientPerDay) return 'daily_limit';
  if (caps.perNumber && counts.forNumber > caps.perNumber.max) return 'rate_limited';
  return undefined;
}

type LineOutcome = { ok: true; messageId?: string | undefined } | { ok: false; detail: string };

/**
 * One LINE row per booking, however many staff it went to: `sent` if at least one recipient was
 * reached (detail `partial_failure` when others were not), `failed` only if none were.
 */
function settleLine(outcomes: readonly LineOutcome[]): Settlement {
  const delivered = outcomes.filter(
    (outcome): outcome is Extract<LineOutcome, { ok: true }> => outcome.ok,
  );
  const first = delivered[0];
  if (!first) {
    const failure = outcomes.find((outcome) => !outcome.ok);
    return { status: 'failed', detail: failure && !failure.ok ? failure.detail : 'unknown' };
  }
  const messageId = delivered.find((outcome) => outcome.messageId)?.messageId;
  return {
    status: 'sent',
    ...(delivered.length < outcomes.length ? { detail: 'partial_failure' } : {}),
    ...(messageId ? { providerMessageId: messageId } : {}),
  };
}

/** The business name in `language`, falling back to the client's default language. */
function businessName(config: ClientConfig, language: string): string {
  return config.business.name[language] ?? config.business.name[config.languages.default] ?? '';
}
