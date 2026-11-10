import { describe, expect, test, vi } from 'vitest';

import { logger } from '../../src/lib/logger.js';

import { parseClientConfig, type ClientConfig } from '../../src/config/schema.js';
import {
  ChannelBookingNotifier,
  type BookingNotification,
} from '../../src/notifications/bookingNotifier.js';
import { NotificationDeliveryError } from '../../src/notifications/deliveryError.js';
import type { LinePusher, LinePushMessage } from '../../src/notifications/linePush.js';
import type { SmsMessage, SmsSender } from '../../src/notifications/telnyxSms.js';
import type {
  NewNotificationLogEntry,
  NotificationLogRepository,
  NotificationStatus,
  Reservation,
  ReservedCountQuery,
  ReservedCounts,
  Settlement,
} from '../../src/repositories/notificationLogRepository.js';
import { readSakuraDocument, SAKURA_ID, withChanges } from '../helpers/clientFixtures.js';

const sakuraDocument = readSakuraDocument();
const sakura = parseClientConfig(sakuraDocument, SAKURA_ID).config;

const LINE_USER_ID = `U${'a'.repeat(32)}`;
const CREDENTIALS: Record<string, string> = {
  TELNYX_API_KEY: 'test-telnyx-key',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
  LINE_STAFF_USER_ID: LINE_USER_ID,
};

class FakeSms implements SmsSender {
  readonly sent: SmsMessage[] = [];
  failWith: Error | undefined;

  send(message: SmsMessage): Promise<{ messageId: string }> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve({ messageId: 'sms-1' });
  }
}

class FakeLine implements LinePusher {
  readonly pushed: LinePushMessage[] = [];
  failWith: Error | undefined;

  push(message: LinePushMessage): Promise<{ messageId?: string }> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.pushed.push(message);
    return Promise.resolve({ messageId: 'line-1' });
  }
}

/** Rows as the notifier leaves them: a reservation is updated in place when it is settled. */
type MemoryRow = Omit<NewNotificationLogEntry, 'status'> & { status: NotificationStatus };

class MemoryLog implements NotificationLogRepository {
  readonly entries: MemoryRow[] = [];
  /** Sends already counted before this booking, as if made earlier in the day. */
  priorForNumber = 0;
  priorForClient = 0;
  failWith: Error | undefined;
  lastCount: ReservedCountQuery | undefined;

  record(entry: NewNotificationLogEntry): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.entries.push(entry);
    return Promise.resolve();
  }

  reserve(reservation: Reservation): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.entries.push({ ...reservation, status: 'pending' });
    return Promise.resolve(String(this.entries.length - 1));
  }

  settle(id: string, settlement: Settlement): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    const row = this.entries[Number(id)];
    if (row) this.entries[Number(id)] = { ...row, ...settlement };
    return Promise.resolve();
  }

  /** Which call booked an appointment: by convention `appt-N` belongs to `call-N`. */
  callOf = (appointmentId: string): string => appointmentId.replace('appt', 'call');

  countReserved(query: ReservedCountQuery): Promise<ReservedCounts> {
    this.lastCount = query;
    const live = this.entries.filter(
      (entry) =>
        entry.channel === query.channel && (entry.status === 'pending' || entry.status === 'sent'),
    );
    return Promise.resolve({
      forClient: this.priorForClient + live.length,
      // Every booking in these tests comes from the same number, so the in-memory rows all count.
      forNumber: query.patientPhone ? this.priorForNumber + live.length : 0,
      forCall: query.callId
        ? live.filter((entry) => this.callOf(entry.appointmentId) === query.callId).length
        : 0,
    });
  }
}

const booking: BookingNotification = {
  clientId: SAKURA_ID,
  appointmentId: 'appt-1',
  callId: 'call-1',
  reservationNumber: 'R123456',
  language: 'ja',
  patientName: 'Hanako Yamada',
  serviceName: 'General Consultation',
  date: '2026-11-03',
  time: '10:00',
  callerPhone: '09012345678',
};

/** The Nth booking, made in its own call (`appt-N` ↔ `call-N`, see MemoryLog.callOf). */
const bookingN = (index: number): BookingNotification => ({
  ...booking,
  appointmentId: `appt-${index}`,
  callId: `call-${index}`,
});

const withoutNumber: BookingNotification = (() => {
  const { callerPhone: _omitted, ...rest } = booking;
  return rest;
})();

const NOW = new Date('2026-11-02T00:00:00Z');

function build(
  options: { configs?: Record<string, ClientConfig>; credentials?: Record<string, string> } = {},
) {
  const sms = new FakeSms();
  const line = new FakeLine();
  const log = new MemoryLog();
  const configs = options.configs ?? { [SAKURA_ID]: sakura };
  const credentials = options.credentials ?? CREDENTIALS;
  const notifier = new ChannelBookingNotifier({
    loadConfig: (clientId) => {
      const config = configs[clientId];
      if (!config) throw new Error(`no client ${clientId}`);
      return config;
    },
    credential: (name) => credentials[name],
    sms,
    line,
    log,
    now: () => NOW,
  });
  return { notifier, sms, line, log };
}

const entryFor = (log: MemoryLog, channel: 'sms' | 'line') =>
  log.entries.find((entry) => entry.channel === channel);

describe('ChannelBookingNotifier — caller SMS', () => {
  test('sends a factual Japanese confirmation to the caller number in E.164', async () => {
    const { notifier, sms, log } = build();

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toEqual({
      apiKey: 'test-telnyx-key',
      messagingProfileId: '4001a195-9a6f-4a6b-8c61-c4c1d09caf3d',
      from: 'Sakura',
      to: '+819012345678',
      text: 'さくら整骨院です。2026年11月3日 10:00のご予約を承りました。',
      idempotencyKey: 'booking-appt-1-sms',
    });
    expect(entryFor(log, 'sms')).toMatchObject({
      status: 'sent',
      clientId: SAKURA_ID,
      appointmentId: 'appt-1',
      providerMessageId: 'sms-1',
    });
  });

  test('uses the call language: an English call gets the English template', async () => {
    const { notifier, sms } = build();

    await notifier.notifyBooked({ ...booking, language: 'en' });

    expect(sms.sent[0]?.text).toBe(
      'Sakura Seikotsuin: your appointment on November 3, 2026 at 10:00 is confirmed.',
    );
  });

  test('falls back to the default-language template when the call language has none', async () => {
    const { notifier, sms } = build();

    await notifier.notifyBooked({ ...booking, language: 'ko' });

    expect(sms.sent[0]?.text).toContain('ご予約を承りました');
  });

  test.each(['ja', 'en'])(
    'the %s SMS holds only name, date and time — no link, no patient or booking details',
    async (language) => {
      const { notifier, sms } = build();

      await notifier.notifyBooked({ ...booking, language });

      const text = sms.sent[0]?.text ?? '';
      expect(text).not.toMatch(/https?:|www\.|\.com|\.jp/i);
      expect(text).not.toContain('Hanako');
      expect(text).not.toContain('R123456');
      expect(text).not.toContain('General Consultation');
      expect(text).not.toContain('[[');
    },
  );

  test('skips, and says why, when the call carried no number', async () => {
    const { notifier, sms, log } = build();

    await notifier.notifyBooked(withoutNumber);

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({ status: 'skipped', detail: 'no_caller_number' });
  });

  test('skips a number that cannot be dialled', async () => {
    const { notifier, sms, log } = build();

    await notifier.notifyBooked({ ...booking, callerPhone: '12345' });

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({
      status: 'skipped',
      detail: 'invalid_caller_number',
    });
  });

  test('refuses a destination outside the allowed countries — Japan only by default', async () => {
    const { notifier, sms, log } = build();

    await notifier.notifyBooked({ ...booking, callerPhone: '+14155550132' });

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({
      status: 'skipped',
      detail: 'country_not_allowed',
    });
    // Refused before any slot is reserved: the only SMS row is the one skip, never a reservation.
    expect(log.entries.filter((entry) => entry.channel === 'sms')).toHaveLength(1);
  });

  test('dials an international number once the client lists its country as allowed', async () => {
    const withUs = parseClientConfig(
      withChanges(sakuraDocument, (draft) => {
        draft.notifications.sms.allowedCountryCodes = ['+81', '+1'];
      }),
      SAKURA_ID,
    ).config;
    const { notifier, sms } = build({ configs: { [SAKURA_ID]: withUs } });

    await notifier.notifyBooked({ ...booking, callerPhone: '+14155550132' });

    expect(sms.sent[0]?.to).toBe('+14155550132');
  });

  test('still sends to a Japanese number when only Japan is allowed', async () => {
    const { notifier, sms } = build();

    await notifier.notifyBooked({ ...booking, callerPhone: '+819012345678' });

    expect(sms.sent[0]?.to).toBe('+819012345678');
  });

  test('skips with missing_credentials when the client key is not in the environment', async () => {
    const { TELNYX_API_KEY: _key, ...withoutKey } = CREDENTIALS;
    const { notifier, sms, log } = build({ credentials: withoutKey });

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({
      status: 'skipped',
      detail: 'missing_credentials',
      recipientRef: 'TELNYX_API_KEY',
    });
  });

  test('stops at the per-number daily cap (the public demo page lets anyone type a number)', async () => {
    const { notifier, sms, log } = build();
    log.priorForNumber = 3;

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({ status: 'skipped', detail: 'rate_limited' });
    expect(log.entries.filter((entry) => entry.status === 'pending')).toHaveLength(0);
  });

  test('counts the recipient against the stored number over the last 24 hours', async () => {
    const { notifier, log } = build();
    const queries: ReservedCountQuery[] = [];
    const original = log.countReserved.bind(log);
    log.countReserved = (query) => {
      queries.push(query);
      return original(query);
    };

    await notifier.notifyBooked(booking);

    expect(queries.find((query) => query.channel === 'sms')).toEqual({
      clientId: SAKURA_ID,
      channel: 'sms',
      since: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      // A `pending` row older than 5 minutes belongs to a crashed send and stops counting.
      pendingSince: new Date(NOW.getTime() - 5 * 60 * 1000),
      callId: 'call-1',
      // The per-call limit is per event (VP-25); a booking is the default one.
      event: 'booked',
      patientPhone: '09012345678',
    });
  });

  test('sends while still under the cap', async () => {
    const { notifier, sms, log } = build();
    log.priorForNumber = 2;

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(1);
    expect(entryFor(log, 'sms')).toMatchObject({ status: 'sent', providerMessageId: 'sms-1' });
  });

  test('stops at the whole-client daily cap even for a number never texted before', async () => {
    const { notifier, sms, log } = build();
    log.priorForClient = 100; // Sakura: sms.maxPerDay defaults to 100

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({ status: 'skipped', detail: 'daily_limit' });
  });

  test('a run of different numbers cannot get past the client-wide cap', async () => {
    const capped = parseClientConfig(
      withChanges(sakuraDocument, (draft) => {
        draft.notifications.sms.maxPerDay = 2;
        draft.notifications.sms.maxPerRecipientPerDay = 5;
      }),
      SAKURA_ID,
    ).config;
    const { notifier, sms, log } = build({ configs: { [SAKURA_ID]: capped } });

    for (const [index, phone] of ['09011110001', '09011110002', '09011110003'].entries()) {
      await notifier.notifyBooked({
        ...bookingN(index),
        callerPhone: phone,
      });
    }

    expect(sms.sent).toHaveLength(2);
    const smsRows = log.entries.filter((entry) => entry.channel === 'sms');
    expect(smsRows.map((row) => row.status)).toEqual(['sent', 'sent', 'skipped']);
    expect(smsRows[2]?.detail).toBe('daily_limit');
  });

  test('simultaneous bookings for one number cannot all slip past the cap', async () => {
    const { notifier, sms, log } = build();

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => notifier.notifyBooked(bookingN(index))),
    );

    // Sakura allows 3 per number. Counting only `sent` rows (the old guard) let all 8 through.
    expect(sms.sent.length).toBeLessThanOrEqual(3);
    const smsRows = log.entries.filter((entry) => entry.channel === 'sms');
    expect(smsRows.filter((row) => row.status === 'sent').length).toBeLessThanOrEqual(3);
    expect(smsRows.filter((row) => row.status === 'pending')).toHaveLength(0);
  });

  test('bookings one after another send exactly up to the cap, then stop', async () => {
    const { notifier, sms } = build();

    for (let index = 0; index < 5; index += 1) {
      await notifier.notifyBooked(bookingN(index));
    }

    expect(sms.sent).toHaveLength(3);
  });

  test('a provider rejection settles the reservation as failed, leaving nothing pending', async () => {
    const { notifier, sms, log } = build();
    sms.failWith = new NotificationDeliveryError('http_400');

    await notifier.notifyBooked(booking);

    expect(entryFor(log, 'sms')).toMatchObject({ status: 'failed', detail: 'http_400' });
    expect(log.entries.filter((entry) => entry.status === 'pending')).toHaveLength(0);
  });

  test('records a provider failure with its reason code and does not reject', async () => {
    const { notifier, sms, log } = build();
    sms.failWith = new NotificationDeliveryError('http_400_40310');

    await expect(notifier.notifyBooked(booking)).resolves.toBeUndefined();

    expect(entryFor(log, 'sms')).toMatchObject({ status: 'failed', detail: 'http_400_40310' });
  });
});

describe('ChannelBookingNotifier — staff LINE alert', () => {
  test('pushes the booking details to the configured recipient', async () => {
    const { notifier, line, log } = build();

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(1);
    const pushed = line.pushed[0];
    expect(pushed?.accessToken).toBe('test-line-token');
    expect(pushed?.to).toBe(LINE_USER_ID);
    expect(pushed?.retryKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(pushed?.text).toContain('さくら整骨院');
    expect(pushed?.text).toContain('2026年11月3日 10:00');
    expect(pushed?.text).toContain('Hanako Yamada');
    expect(pushed?.text).toContain('09012345678');
    expect(pushed?.text).toContain('General Consultation');
    expect(pushed?.text).toContain('R123456');
    expect(entryFor(log, 'line')).toMatchObject({
      status: 'sent',
      recipientRef: 'LINE_STAFF_USER_ID',
      providerMessageId: 'line-1',
    });
  });

  test('keeps a caller-supplied name on one line — no forged lines in the staff alert', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked({
      ...booking,
      patientName: 'Tanaka\r\n【緊急】 Call +1-900-555-0100 now\u0007',
    });

    const text = line.pushed[0]?.text ?? '';
    const lines = text.split('\n');
    expect(lines.some((row) => row.startsWith('【緊急】'))).toBe(false);
    expect(text).toContain('お名前: Tanaka 【緊急】 Call +1-900-555-0100 now');
    expect(text.includes('\r')).toBe(false);
    // The next string holds the Unicode LINE SEPARATOR (U+2028) the name was sent with.
    expect(text.includes(' ')).toBe(false);
    expect(text.includes(String.fromCharCode(0x07))).toBe(false);
  });

  test('caps a very long name', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked({ ...booking, patientName: 'あ'.repeat(5000) });

    expect(line.pushed[0]?.text.length).toBeLessThan(400);
  });

  test('stops at the whole-client daily cap so the public page cannot flood the staff LINE', async () => {
    const { notifier, line, log } = build();
    log.priorForClient = 50; // Sakura: line.maxPerDay defaults to 50

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(0);
    expect(entryFor(log, 'line')).toMatchObject({
      status: 'skipped',
      detail: 'daily_limit',
      recipientRef: 'LINE_STAFF_USER_ID',
    });
  });

  test('sends while under the LINE cap', async () => {
    const { notifier, line, log } = build();
    log.priorForClient = 48;

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(1);
  });

  test('shows "-" for what the booking does not have (no service, no caller number)', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked({ ...withoutNumber, serviceName: null });

    expect(line.pushed[0]?.text).toContain('電話: -');
    expect(line.pushed[0]?.text).toContain('メニュー: -');
  });

  test('still alerts staff when the caller SMS cannot be sent', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked(withoutNumber);

    expect(line.pushed).toHaveLength(1);
  });

  test('records a LINE failure and does not reject; the SMS is unaffected', async () => {
    const { notifier, sms, line, log } = build();
    line.failWith = new NotificationDeliveryError('http_401');

    await expect(notifier.notifyBooked(booking)).resolves.toBeUndefined();

    expect(entryFor(log, 'line')).toMatchObject({ status: 'failed', detail: 'http_401' });
    expect(sms.sent).toHaveLength(1);
  });

  test('skips when the channel token is missing', async () => {
    const { LINE_CHANNEL_ACCESS_TOKEN: _token, ...withoutToken } = CREDENTIALS;
    const { notifier, line, log } = build({ credentials: withoutToken });

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(0);
    expect(entryFor(log, 'line')).toMatchObject({
      status: 'skipped',
      detail: 'missing_credentials',
      recipientRef: 'LINE_CHANNEL_ACCESS_TOKEN',
    });
  });

  test('skips a recipient whose variable is unset, without blocking the others', async () => {
    const config = parseClientConfig(
      withChanges(sakuraDocument, (draft) => {
        draft.notifications.line.recipientEnvs = ['LINE_STAFF_GROUP_ID', 'LINE_STAFF_USER_ID'];
      }),
      SAKURA_ID,
    ).config;
    const { notifier, line, log } = build({ configs: { [SAKURA_ID]: config } });

    await notifier.notifyBooked(booking);

    expect(line.pushed.map((message) => message.to)).toEqual([LINE_USER_ID]);
    expect(log.entries.filter((entry) => entry.channel === 'line')).toEqual([
      expect.objectContaining({ status: 'skipped', recipientRef: 'LINE_STAFF_GROUP_ID' }),
      expect.objectContaining({ status: 'sent', recipientRef: 'LINE_STAFF_USER_ID' }),
    ]);
  });

  test('pushes to every configured recipient — a staff group is just another entry', async () => {
    const groupId = `C${'b'.repeat(32)}`;
    const config = parseClientConfig(
      withChanges(sakuraDocument, (draft) => {
        draft.notifications.line.recipientEnvs = ['LINE_STAFF_GROUP_ID', 'LINE_STAFF_USER_ID'];
      }),
      SAKURA_ID,
    ).config;
    const { notifier, line } = build({
      configs: { [SAKURA_ID]: config },
      credentials: { ...CREDENTIALS, LINE_STAFF_GROUP_ID: groupId },
    });

    await notifier.notifyBooked(booking);

    expect(line.pushed.map((message) => message.to).sort()).toEqual([groupId, LINE_USER_ID].sort());
  });
});

describe('ChannelBookingNotifier — one SMS and one LINE alert per call', () => {
  const secondInSameCall: BookingNotification = { ...bookingN(2), callId: 'call-1' };

  test('a second booking in the same call gets neither an SMS nor a LINE alert', async () => {
    const { notifier, sms, line, log } = build();
    log.callOf = () => 'call-1';

    await notifier.notifyBooked(booking);
    await notifier.notifyBooked(secondInSameCall);

    expect(sms.sent).toHaveLength(1);
    expect(line.pushed).toHaveLength(1);
    const second = log.entries.filter((entry) => entry.appointmentId === 'appt-2');
    expect(second.map((entry) => [entry.channel, entry.status, entry.detail]).sort()).toEqual([
      ['line', 'skipped', 'call_limit'],
      ['sms', 'skipped', 'call_limit'],
    ]);
  });

  test('simultaneous bookings in one call send at most one of each', async () => {
    const { notifier, sms, line, log } = build();
    log.callOf = () => 'call-1';

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        notifier.notifyBooked({ ...bookingN(index), callId: 'call-1' }),
      ),
    );

    expect(sms.sent.length).toBeLessThanOrEqual(1);
    expect(line.pushed.length).toBeLessThanOrEqual(1);
  });

  test('bookings in different calls are not limited by each other', async () => {
    const { notifier, sms, line } = build();

    await notifier.notifyBooked(bookingN(1));
    await notifier.notifyBooked(bookingN(2));

    expect(sms.sent).toHaveLength(2);
    expect(line.pushed).toHaveLength(2);
  });

  test('a repeat within a call is not reported as the daily budget running out', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { notifier, log } = build();
    log.callOf = () => 'call-1';

    await notifier.notifyBooked(booking);
    await notifier.notifyBooked(secondInSameCall);

    expect(warn).not.toHaveBeenCalledWith('notification daily cap reached', expect.anything());
    warn.mockRestore();
  });

  test('counts the call, so a refused repeat does not hold a slot in the daily budget', async () => {
    const { notifier, log } = build();
    log.callOf = () => 'call-1';

    await notifier.notifyBooked(booking);
    await notifier.notifyBooked(secondInSameCall);

    const live = log.entries.filter((entry) => entry.status === 'sent');
    expect(live).toHaveLength(2); // one SMS + one LINE; the repeats are `skipped`, not live
  });
});

describe('ChannelBookingNotifier — LINE cap is per booking, not per recipient', () => {
  const groupId = `C${'b'.repeat(32)}`;
  const twoRecipients = parseClientConfig(
    withChanges(sakuraDocument, (draft) => {
      draft.notifications.line.recipientEnvs = ['LINE_STAFF_GROUP_ID', 'LINE_STAFF_USER_ID'];
    }),
    SAKURA_ID,
  ).config;
  const buildTwo = () =>
    build({
      configs: { [SAKURA_ID]: twoRecipients },
      credentials: { ...CREDENTIALS, LINE_STAFF_GROUP_ID: groupId },
    });

  test('one booking is one reservation and one log row, however many staff it reaches', async () => {
    const { notifier, line, log } = buildTwo();

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(2);
    const rows = log.entries.filter((entry) => entry.channel === 'line');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'sent',
      recipientRef: 'LINE_STAFF_GROUP_ID,LINE_STAFF_USER_ID',
    });
  });

  test('a second recipient does not use up the budget: with one alert left, both staff are told', async () => {
    const { notifier, line, log } = buildTwo();
    log.priorForClient = 49; // Sakura: line.maxPerDay defaults to 50

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(2);
  });

  test('at the cap nobody is told — never some staff and not others', async () => {
    const { notifier, line, log } = buildTwo();
    log.priorForClient = 50;

    await notifier.notifyBooked(booking);

    expect(line.pushed).toHaveLength(0);
    expect(log.entries.filter((entry) => entry.channel === 'line')).toEqual([
      expect.objectContaining({ status: 'skipped', detail: 'daily_limit' }),
    ]);
  });

  test('a recipient with no variable set is skipped on its own and does not count toward the cap', async () => {
    const { notifier, line, log } = build({ configs: { [SAKURA_ID]: twoRecipients } });
    log.priorForClient = 49;

    await notifier.notifyBooked(booking);

    expect(line.pushed.map((message) => message.to)).toEqual([LINE_USER_ID]);
    expect(log.entries.filter((entry) => entry.channel === 'line')).toEqual([
      expect.objectContaining({ status: 'skipped', detail: 'missing_credentials' }),
      expect.objectContaining({ status: 'sent', recipientRef: 'LINE_STAFF_USER_ID' }),
    ]);
  });

  test('when only some staff could be reached the row is sent, flagged partial_failure', async () => {
    const { notifier, line, log } = buildTwo();
    const push = line.push.bind(line);
    line.push = (message) =>
      message.to === groupId
        ? Promise.reject(new NotificationDeliveryError('http_400'))
        : push(message);

    await notifier.notifyBooked(booking);

    expect(log.entries.filter((entry) => entry.channel === 'line')).toEqual([
      expect.objectContaining({
        status: 'sent',
        detail: 'partial_failure',
        providerMessageId: 'line-1',
      }),
    ]);
  });

  test('when no staff could be reached the row is failed with the first reason', async () => {
    const { notifier, line, log } = buildTwo();
    line.failWith = new NotificationDeliveryError('http_401');

    await notifier.notifyBooked(booking);

    expect(log.entries.filter((entry) => entry.channel === 'line')).toEqual([
      expect.objectContaining({ status: 'failed', detail: 'http_401' }),
    ]);
  });
});

describe('ChannelBookingNotifier — a full daily cap is visible in the logs', () => {
  test('logs a warning, with identifiers only, when the whole-client cap is hit', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { notifier, log } = build();
    log.priorForClient = 100;

    await notifier.notifyBooked(booking);

    expect(warn).toHaveBeenCalledWith('notification daily cap reached', {
      clientId: SAKURA_ID,
      channel: 'sms',
      maxPerDay: 100,
    });
    expect(warn).toHaveBeenCalledWith('notification daily cap reached', {
      clientId: SAKURA_ID,
      channel: 'line',
      maxPerDay: 50,
    });
    warn.mockRestore();
  });

  test('does not warn for the per-number cap', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { notifier, log } = build();
    log.priorForNumber = 3;

    await notifier.notifyBooked(booking);

    expect(warn).not.toHaveBeenCalledWith('notification daily cap reached', expect.anything());
    warn.mockRestore();
  });
});

describe('ChannelBookingNotifier — staff alert text from the caller', () => {
  const invisible = String.fromCharCode(0x202e, 0x200b, 0x2066, 0xfeff, 0x00ad);

  test('drops bidi overrides and zero-width characters, without splitting the name', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked({
      ...booking,
      patientName: `Tana${String.fromCharCode(0x200b)}ka${String.fromCharCode(0x202e)}`,
    });

    expect(line.pushed[0]?.text).toContain('お名前: Tanaka\n');
  });

  test('shows "-" for a name made only of invisible or control characters', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked({ ...booking, patientName: `${invisible}\n\t` });

    expect(line.pushed[0]?.text).toContain('お名前: -');
  });

  test('shows "-" for a service name that is blank after cleaning', async () => {
    const { notifier, line } = build();

    await notifier.notifyBooked({ ...booking, serviceName: invisible });

    expect(line.pushed[0]?.text).toContain('メニュー: -');
  });
});

describe('ChannelBookingNotifier — generic across clients', () => {
  const secondDocument = withChanges(sakuraDocument, (draft) => {
    draft.clientId = 'second-client';
    draft.notifications.sms.apiKeyEnv = 'TELNYX_API_KEY_SECOND';
    draft.notifications.sms.messagingProfileId = 'profile-second';
    draft.notifications.sms.senderId = 'Second';
    draft.notifications.line.channelAccessTokenEnv = 'LINE_SECOND_ACCESS_TOKEN';
    draft.notifications.line.recipientEnvs = ['LINE_SECOND_GROUP_ID'];
  });
  const second = parseClientConfig(secondDocument, 'second-client').config;
  const secondGroup = `C${'c'.repeat(32)}`;

  test('a second client uses only its own key, profile, sender, token and recipient — config only', async () => {
    const { notifier, sms, line } = build({
      configs: { [SAKURA_ID]: sakura, 'second-client': second },
      credentials: {
        ...CREDENTIALS,
        TELNYX_API_KEY_SECOND: 'second-telnyx-key',
        LINE_SECOND_ACCESS_TOKEN: 'second-line-token',
        LINE_SECOND_GROUP_ID: secondGroup,
      },
    });

    await notifier.notifyBooked({ ...booking, clientId: 'second-client' });

    expect(sms.sent[0]).toMatchObject({
      apiKey: 'second-telnyx-key',
      messagingProfileId: 'profile-second',
      from: 'Second',
    });
    expect(line.pushed).toEqual([
      expect.objectContaining({ accessToken: 'second-line-token', to: secondGroup }),
    ]);
  });

  test('a second client without credentials set up yet sends nothing and affects nobody else', async () => {
    const { notifier, sms, line, log } = build({
      configs: { [SAKURA_ID]: sakura, 'second-client': second },
    });

    await notifier.notifyBooked({ ...booking, clientId: 'second-client' });

    expect(sms.sent).toHaveLength(0);
    expect(line.pushed).toHaveLength(0);
    expect(log.entries.map((entry) => entry.detail)).toEqual([
      'missing_credentials',
      'missing_credentials',
    ]);
    expect(log.entries.every((entry) => entry.clientId === 'second-client')).toBe(true);
  });

  test('a client with no notifications block sends and logs nothing', async () => {
    const bare = parseClientConfig(
      withChanges(sakuraDocument, (draft) => {
        delete draft.notifications;
        delete draft.reservationFlow; // changes need a staff alert (VP-25)
      }),
      SAKURA_ID,
    ).config;
    const { notifier, sms, line, log } = build({ configs: { [SAKURA_ID]: bare } });

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(0);
    expect(line.pushed).toHaveLength(0);
    expect(log.entries).toHaveLength(0);
  });
});

describe('ChannelBookingNotifier — never lets a notification problem escape', () => {
  test('resolves when the client config cannot be loaded', async () => {
    const { notifier, sms } = build();

    await expect(
      notifier.notifyBooked({ ...booking, clientId: 'does-not-exist' }),
    ).resolves.toBeUndefined();
    expect(sms.sent).toHaveLength(0);
  });

  test('resolves, and sends nothing, when the delivery log is down — the caps cannot be checked, so it fails closed', async () => {
    const { notifier, sms, line, log } = build();
    log.failWith = new Error('connection refused');

    await expect(notifier.notifyBooked(booking)).resolves.toBeUndefined();

    expect(sms.sent).toHaveLength(0);
    expect(line.pushed).toHaveLength(0);
  });

  test('one channel failing on the log does not stop the other', async () => {
    const { notifier, sms, line, log } = build();
    const reserve = log.reserve.bind(log);
    log.reserve = (reservation) =>
      reservation.channel === 'sms'
        ? Promise.reject(new Error('connection refused'))
        : reserve(reservation);

    await expect(notifier.notifyBooked(booking)).resolves.toBeUndefined();

    expect(sms.sent).toHaveLength(0);
    expect(line.pushed).toHaveLength(1);
  });

  test('the delivery log never holds a phone number, name, message text or LINE id', async () => {
    const { notifier, log } = build();

    await notifier.notifyBooked(booking);

    const stored = JSON.stringify(log.entries);
    expect(stored).not.toContain('9012345678');
    expect(stored).not.toContain('Hanako');
    expect(stored).not.toContain(LINE_USER_ID);
    expect(stored).not.toContain('ご予約');
  });
});
