/**
 * Tells people about appointment events (VP-23 booking; VP-25 cancellation and reschedule): a
 * factual SMS to the caller and an alert to the client's staff on LINE.
 *
 * Generic by construction. Nothing here names a clinic, a Telnyx profile, a LINE channel or a
 * recipient: all of it comes from the client's `notifications` block in client.yaml, with
 * secrets looked up by env-var NAME from the environment. A second client is a new yaml block and
 * new `.env` entries. What differs between events (which template, which values) lives in
 * ./notificationJobs.ts; everything below is shared by all of them.
 *
 * Failure policy (FUTURE-FEATURES F-2): the booking / change is already saved before this runs, and
 * `notifyBooked` / `notifyChanged` never reject — a down provider, a missing key or a database
 * hiccup in the log is recorded and swallowed, never shown to the caller or allowed to undo it.
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
import { bookedJob, changedJob, type NotificationJob } from './notificationJobs.js';
import type { SmsSender } from './telnyxSms.js';
import { renderTemplate } from './template.js';

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

/** A booking the caller cancelled or moved by phone (VP-25). */
export interface AppointmentChangeNotification {
  kind: 'cancelled' | 'rescheduled';
  clientId: string;
  appointmentId: string;
  /** The call that MADE THE CHANGE (not the one that made the booking) — one alert per call and event. */
  callId: string;
  reservationNumber: string;
  language: string;
  patientName: string;
  serviceName: string | null;
  /** The appointment now; for a cancellation, the slot that was cancelled. */
  date: string; // YYYY-MM-DD
  time: string; // HH:MM, clinic-local
  /** Where the booking was before the change (the same as date/time for a cancellation). */
  oldDate: string;
  oldTime: string;
  callerPhone?: string;
}

export interface BookingNotifier {
  /** Never rejects. */
  notifyBooked(booking: BookingNotification): Promise<void>;
  /** Never rejects. */
  notifyChanged(change: AppointmentChangeNotification): Promise<void>;
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
 * The ceilings a send must stay under. `perNumber` applies to SMS only. One send per call, channel
 * and event is a fixed rule, not a setting: a call books (or changes) one appointment, and letting
 * a single call repeat is how a public page could be made to burn a client's whole daily budget.
 */
interface Caps {
  perClientPerDay: number;
  perNumber?: { phone: string; max: number };
}

const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A send that has been `pending` longer than this was abandoned (a live one takes seconds). */
const PENDING_STALE_MS = 5 * 60 * 1000;
const MAX_SENDS_PER_CALL_AND_CHANNEL = 1;

export class ChannelBookingNotifier implements BookingNotifier {
  constructor(private readonly deps: BookingNotifierDeps) {}

  notifyBooked(booking: BookingNotification): Promise<void> {
    return this.notify(bookedJob(booking));
  }

  notifyChanged(change: AppointmentChangeNotification): Promise<void> {
    return this.notify(changedJob(change));
  }

  private async notify(job: NotificationJob): Promise<void> {
    try {
      const config = this.deps.loadConfig(job.clientId);
      const sms = config.notifications?.sms;
      const line = config.notifications?.line;
      await Promise.all([
        sms ? this.guarded(job, 'sms', () => this.sendSms(job, config, sms)) : undefined,
        line ? this.guarded(job, 'line', () => this.sendLine(job, config, line)) : undefined,
      ]);
    } catch (error) {
      logger.error('booking notification failed', {
        clientId: job.clientId,
        appointmentId: job.appointmentId,
        event: job.event,
        reason: deliveryErrorCode(error),
      });
    }
  }

  private async sendSms(
    job: NotificationJob,
    config: ClientConfig,
    sms: SmsNotificationConfig,
  ): Promise<void> {
    const to = job.callerPhone ? toE164(job.callerPhone, sms.defaultCountryCode) : undefined;
    if (!job.callerPhone) return this.record(job, 'sms', 'skipped', 'no_caller_number');
    if (!to) return this.record(job, 'sms', 'skipped', 'invalid_caller_number');
    if (!sms.allowedCountryCodes.some((countryCode) => to.startsWith(countryCode))) {
      return this.record(job, 'sms', 'skipped', 'country_not_allowed');
    }

    const apiKey = this.deps.credential(sms.apiKeyEnv);
    if (!apiKey) return this.skipMissingCredential(job, 'sms', sms.apiKeyEnv);

    const templates = job.smsTemplates(sms);
    const template = templates?.[job.language] ?? templates?.[config.languages.default];
    if (!template) return this.record(job, 'sms', 'skipped', 'no_template');

    const reservationId = await this.reserveWithinCaps(job, 'sms', {
      perClientPerDay: sms.maxPerDay,
      perNumber: { phone: job.callerPhone, max: sms.maxPerRecipientPerDay },
    });
    if (!reservationId) return;

    try {
      const { messageId } = await this.deps.sms.send({
        apiKey,
        messagingProfileId: sms.messagingProfileId,
        from: sms.senderId,
        to,
        text: renderTemplate(template, job.smsValues(config)),
        idempotencyKey: job.smsIdempotencyKey,
      });
      await this.settle(job, 'sms', reservationId, {
        status: 'sent',
        providerMessageId: messageId,
      });
    } catch (error) {
      await this.settle(job, 'sms', reservationId, {
        status: 'failed',
        detail: deliveryErrorCode(error),
      });
    }
  }

  private async sendLine(
    job: NotificationJob,
    config: ClientConfig,
    line: LineNotificationConfig,
  ): Promise<void> {
    const accessToken = this.deps.credential(line.channelAccessTokenEnv);
    if (!accessToken) return this.skipMissingCredential(job, 'line', line.channelAccessTokenEnv);

    const template = job.lineTemplate(line);
    if (!template) return this.record(job, 'line', 'skipped', 'no_template');
    const text = renderTemplate(template, job.lineValues(config));

    // A recipient whose variable is unset is skipped on its own and never counts toward a cap.
    const recipients: { envName: string; to: string }[] = [];
    for (const envName of line.recipientEnvs) {
      const to = this.deps.credential(envName);
      if (to) recipients.push({ envName, to });
      else await this.skipMissingCredential(job, 'line', envName);
    }
    if (recipients.length === 0) return;

    // ONE reservation per event, however many staff it fans out to: `maxPerDay` is alerts, not
    // individual pushes, so adding a recipient never shrinks the budget and a cap hit can never
    // tell some staff and not others.
    const reservationId = await this.reserveWithinCaps(
      job,
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
    await this.settle(job, 'line', reservationId, settleLine(outcomes));
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
    job: NotificationJob,
    channel: NotificationChannel,
    caps: Caps,
    recipientRef?: string,
  ): Promise<string | undefined> {
    const reservationId = await this.deps.log.reserve({
      clientId: job.clientId,
      appointmentId: job.appointmentId,
      channel,
      event: job.event,
      callId: job.callId,
      ...(recipientRef ? { recipientRef } : {}),
    });
    const nowMs = this.now().getTime();
    const counts = await this.deps.log.countReserved({
      clientId: job.clientId,
      channel,
      since: new Date(nowMs - RATE_WINDOW_MS),
      pendingSince: new Date(nowMs - PENDING_STALE_MS),
      callId: job.callId,
      event: job.event,
      ...(caps.perNumber ? { patientPhone: caps.perNumber.phone } : {}),
    });

    const refusal = refusalReason(counts, caps);
    if (!refusal) return reservationId;

    if (refusal === 'daily_limit') {
      // Real patients and staff are now going without this channel until the window rolls — make
      // that visible to whoever watches the logs. Identifiers only, no personal data.
      logger.warn('notification daily cap reached', {
        clientId: job.clientId,
        channel,
        maxPerDay: caps.perClientPerDay,
      });
    }
    await this.settle(job, channel, reservationId, { status: 'skipped', detail: refusal });
    return undefined;
  }

  /** Runs one channel's work; a failure is logged and never reaches the other channel or the caller. */
  private async guarded(
    job: NotificationJob,
    channel: NotificationChannel,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      logger.error('booking notification failed', {
        clientId: job.clientId,
        appointmentId: job.appointmentId,
        event: job.event,
        channel,
        reason: deliveryErrorCode(error),
      });
    }
  }

  private async skipMissingCredential(
    job: NotificationJob,
    channel: NotificationChannel,
    envName: string,
  ): Promise<void> {
    // The env var NAME is configuration, not a secret, and tells the operator what to set.
    logger.warn('notification credential not set', {
      clientId: job.clientId,
      channel,
      envVar: envName,
    });
    await this.record(job, channel, 'skipped', 'missing_credentials', {
      recipientRef: envName,
    });
  }

  /** Moves a reserved row to its final status; a failure to log is logged, never thrown. */
  private async settle(
    job: NotificationJob,
    channel: NotificationChannel,
    reservationId: string,
    settlement: Settlement,
  ): Promise<void> {
    this.logOutcome(job, channel, settlement.status, settlement.detail);
    try {
      await this.deps.log.settle(reservationId, settlement);
    } catch (error) {
      this.logWriteFailure(job, channel, error);
    }
  }

  /** Writes a final delivery row; a failure to log is logged, never thrown. */
  private async record(
    job: NotificationJob,
    channel: NotificationChannel,
    status: NewNotificationLogEntry['status'],
    detail?: string,
    extras: LogExtras = {},
  ): Promise<void> {
    this.logOutcome(job, channel, status, detail);
    try {
      await this.deps.log.record({
        clientId: job.clientId,
        appointmentId: job.appointmentId,
        channel,
        event: job.event,
        callId: job.callId,
        status,
        ...(detail ? { detail } : {}),
        ...extras,
      });
    } catch (error) {
      this.logWriteFailure(job, channel, error);
    }
  }

  private logOutcome(
    job: NotificationJob,
    channel: NotificationChannel,
    status: string,
    detail?: string,
  ): void {
    logger.info('booking notification', {
      clientId: job.clientId,
      appointmentId: job.appointmentId,
      event: job.event,
      channel,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  private logWriteFailure(
    job: NotificationJob,
    channel: NotificationChannel,
    error: unknown,
  ): void {
    logger.error('notification log write failed', {
      clientId: job.clientId,
      appointmentId: job.appointmentId,
      event: job.event,
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
 * One LINE row per event, however many staff it went to: `sent` if at least one recipient was
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
