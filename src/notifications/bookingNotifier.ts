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
import { startOfClinicDay } from '../lib/clinicTime.js';
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
import {
  bookedJob,
  changedJob,
  consultationJob,
  type NotificationJob,
  type SmsOutcome,
} from './notificationJobs.js';
import type { PhoneSource } from '../repositories/consultationRequestRepository.js';
import type { ConsultationCooldownSource } from './notificationJobs.js';
import type { SmsSender } from './telnyxSms.js';
import { checkSmsNumber } from './smsEligibility.js';
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

/** A consultation request just saved (TechMirai's own agent). Holds personal data: never log it. */
export interface ConsultationNotification {
  clientId: string;
  /** The saved row's id (names the SMS idempotency key; never shown to anyone). */
  requestId: string;
  callId: string;
  language: string;
  contactName: string;
  /** The saved number (normalised national/international form); null when there is none. */
  contactPhone: string | null;
  phoneSource: PhoneSource;
  reason: string | null;
  createdAt: Date;
}

export interface ConsultationNotifier {
  /**
   * Never rejects. Resolves to how the caller's SMS REALLY ended (sent, or skipped/failed with a
   * reason code) — the consultation tool tells the model from this, and the staff LINE alert is
   * built from the very same value, so the two can never disagree.
   */
  notifyConsultation(request: ConsultationNotification): Promise<SmsOutcome>;
}

export interface BookingNotifierDeps {
  loadConfig(clientId: string): ClientConfig;
  credential: CredentialLookup;
  sms: SmsSender;
  line: LinePusher;
  log: NotificationLogRepository;
  /** Needed only for consultation requests: how many earlier requests a number already made. */
  consultations?: ConsultationCooldownSource;
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
/** The `detail` of the once-a-day "LINE cap reached" notice's log row. */
const CAP_ALERT_DETAIL = 'cap_alert';

export class ChannelBookingNotifier implements BookingNotifier, ConsultationNotifier {
  constructor(private readonly deps: BookingNotifierDeps) {}

  async notifyBooked(booking: BookingNotification): Promise<void> {
    await this.notify(bookedJob(booking));
  }

  async notifyChanged(change: AppointmentChangeNotification): Promise<void> {
    await this.notify(changedJob(change));
  }

  async notifyConsultation(request: ConsultationNotification): Promise<SmsOutcome> {
    const cooldown = this.deps.consultations;
    const outcome = await this.notify(consultationJob(request, cooldown, this.now()));
    // A consultation job always runs the SMS first; the fallback only guards the type.
    return outcome ?? { status: 'skipped', detail: 'sms_not_configured' };
  }

  /** Delivers one job on every channel. Resolves to the caller's SMS outcome when it ran first. */
  private async notify(job: NotificationJob): Promise<SmsOutcome | undefined> {
    try {
      const config = this.deps.loadConfig(job.clientId);
      const sms = config.notifications?.sms;
      const line = config.notifications?.line;
      if (job.lineAfterSms) {
        // The staff alert reports how the caller's SMS went, so the SMS runs first.
        const outcome: SmsOutcome = sms
          ? await this.guardedSms(job, config, sms)
          : { status: 'skipped', detail: 'sms_not_configured' };
        if (line) {
          await this.guarded(job, 'line', () => this.sendLine(job, config, line, outcome));
        }
        return outcome;
      }
      await Promise.all([
        sms ? this.guardedSms(job, config, sms) : undefined,
        line ? this.guarded(job, 'line', () => this.sendLine(job, config, line)) : undefined,
      ]);
      return undefined;
    } catch (error) {
      const detail = deliveryErrorCode(error);
      logger.error('booking notification failed', {
        clientId: job.clientId,
        appointmentId: job.appointmentId,
        event: job.event,
        reason: detail,
      });
      // Nothing is known to have been sent: never report success.
      return { status: 'failed', detail };
    }
  }

  /** Runs the SMS; a failure is logged and turned into a `failed` outcome, never thrown. */
  private async guardedSms(
    job: NotificationJob,
    config: ClientConfig,
    sms: SmsNotificationConfig,
  ): Promise<SmsOutcome> {
    try {
      return await this.sendSms(job, config, sms);
    } catch (error) {
      const detail = deliveryErrorCode(error);
      logger.error('booking notification failed', {
        clientId: job.clientId,
        appointmentId: job.appointmentId,
        event: job.event,
        channel: 'sms',
        reason: detail,
      });
      return { status: 'failed', detail };
    }
  }

  private async skipSms(job: NotificationJob, detail: string): Promise<SmsOutcome> {
    await this.record(job, 'sms', 'skipped', detail);
    return { status: 'skipped', detail };
  }

  private async sendSms(
    job: NotificationJob,
    config: ClientConfig,
    sms: SmsNotificationConfig,
  ): Promise<SmsOutcome> {
    if (!job.callerPhone) return this.skipSms(job, 'no_caller_number');
    // Country allow-list, then the client's opt-in number-type allow-list (e.g. mobiles only).
    const checked = checkSmsNumber(job.callerPhone, sms);
    if (checked.rejection) return this.skipSms(job, checked.rejection);
    const { to } = checked;

    const apiKey = this.deps.credential(sms.apiKeyEnv);
    if (!apiKey) {
      await this.skipMissingCredential(job, 'sms', sms.apiKeyEnv);
      return { status: 'skipped', detail: 'missing_credentials' };
    }

    const templates = job.smsTemplates(sms);
    const template = templates?.[job.language] ?? templates?.[config.languages.default];
    if (!template) return this.skipSms(job, 'no_template');

    // A job-specific gate (a consultation's per-number cooldown) runs before a slot is claimed.
    const gate = job.smsGate ? await job.smsGate(sms) : undefined;
    if (gate) return this.skipSms(job, gate);

    const reserved = await this.reserveWithinCaps(job, 'sms', {
      perClientPerDay: sms.maxPerDay,
      perNumber: { phone: job.callerPhone, max: sms.maxPerRecipientPerDay },
    });
    if (!('reservationId' in reserved)) return { status: 'skipped', detail: reserved.refusal };
    const { reservationId } = reserved;

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
      return { status: 'sent' };
    } catch (error) {
      const detail = deliveryErrorCode(error);
      await this.settle(job, 'sms', reservationId, { status: 'failed', detail });
      return { status: 'failed', detail };
    }
  }

  private async sendLine(
    job: NotificationJob,
    config: ClientConfig,
    line: LineNotificationConfig,
    smsOutcome?: SmsOutcome,
  ): Promise<void> {
    const accessToken = this.deps.credential(line.channelAccessTokenEnv);
    if (!accessToken) return this.skipMissingCredential(job, 'line', line.channelAccessTokenEnv);

    const template = job.lineTemplate(line);
    if (!template) return this.record(job, 'line', 'skipped', 'no_template');
    const text = renderTemplate(template, job.lineValues(config, smsOutcome));

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
    const reserved = await this.reserveWithinCaps(
      job,
      'line',
      { perClientPerDay: line.maxPerDay },
      recipients.map((recipient) => recipient.envName).join(','),
    );
    if (!('reservationId' in reserved)) {
      if (reserved.refusal === 'daily_limit' && line.capReachedMessage) {
        await this.alertCapReached(job, config, line, accessToken, recipients);
      }
      return;
    }
    const { reservationId } = reserved;

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
   * The first time the daily LINE cap is hit on a (client-local) day, tells staff once. Exempt from
   * the cap: it is recorded as a `skipped` row (which never counts toward a cap) and pushed
   * directly. The row is written FIRST, so a second refusal right behind this one stays quiet; a
   * failed push is logged and not retried the same day. Never throws.
   */
  private async alertCapReached(
    job: NotificationJob,
    config: ClientConfig,
    line: LineNotificationConfig,
    accessToken: string,
    recipients: readonly { envName: string; to: string }[],
  ): Promise<void> {
    const message = line.capReachedMessage;
    if (!message) return;
    try {
      const since = startOfClinicDay(this.now(), config.business.hours.timezone);
      const already = await this.deps.log.countRecorded({
        clientId: job.clientId,
        channel: 'line',
        detail: CAP_ALERT_DETAIL,
        since,
      });
      if (already > 0) return;
      await this.record(job, 'line', 'skipped', CAP_ALERT_DETAIL, {
        recipientRef: recipients.map((recipient) => recipient.envName).join(','),
      });
      await Promise.all(
        recipients.map(async ({ to }) => {
          try {
            await this.deps.line.push({ accessToken, to, text: message, retryKey: randomUUID() });
          } catch (error) {
            logger.error('LINE cap alert failed', {
              clientId: job.clientId,
              reason: deliveryErrorCode(error),
            });
          }
        }),
      );
    } catch (error) {
      logger.error('LINE cap alert failed', {
        clientId: job.clientId,
        reason: deliveryErrorCode(error),
      });
    }
  }

  /**
   * Claims a send slot: inserts a `pending` row, then counts live rows (`sent`, or `pending` for
   * under PENDING_STALE_MS; its own included) in the last 24 h. Over a cap → the row is settled as
   * `skipped` and the refusal reason is returned. Because every request inserts BEFORE it counts, the
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
  ): Promise<{ reservationId: string } | { refusal: string }> {
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
    if (!refusal) return { reservationId };

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
    return { refusal };
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
