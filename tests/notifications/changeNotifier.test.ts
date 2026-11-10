/**
 * VP-25: the same SMS / LINE pipeline as a new booking, now also told about a cancellation or a
 * reschedule. Fakes mirror bookingNotifier.test.ts; the abuse guards (caps, one send per call) are
 * exercised for the new events.
 */
import { describe, expect, test } from 'vitest';

import { parseClientConfig, type ClientConfig } from '../../src/config/schema.js';
import {
  ChannelBookingNotifier,
  type AppointmentChangeNotification,
} from '../../src/notifications/bookingNotifier.js';
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

const CREDENTIALS: Record<string, string> = {
  TELNYX_API_KEY: 'test-telnyx-key',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
  LINE_STAFF_USER_ID: `U${'a'.repeat(32)}`,
};

/** Glosses: キャンセル = "cancelled"; 変更 = "changed"; 元の日時 = "original date and time". */
const CHANGE_TEMPLATES = {
  sms: {
    cancelled: {
      ja: '[[businessName]]です。[[date]] [[time]]のご予約をキャンセルしました。',
      en: '[[businessName]]: your appointment on [[date]] at [[time]] is cancelled.',
    },
    rescheduled: {
      ja: '[[businessName]]です。ご予約を[[date]] [[time]]に変更しました。',
      en: '[[businessName]]: your appointment is moved to [[date]] at [[time]].',
    },
  },
  line: {
    cancelled:
      '【予約キャンセル】[[businessName]]\n日時: [[date]] [[time]]\nお名前: [[patientName]]',
    rescheduled:
      '【予約変更】[[businessName]]\n新: [[date]] [[time]]\n元: [[oldDate]] [[oldTime]]\n予約番号: [[reservationNumber]]',
  },
};

const withTemplates: ClientConfig = parseClientConfig(
  withChanges(readSakuraDocument(), (draft) => {
    draft.notifications.sms.changeTemplates = CHANGE_TEMPLATES.sms;
    draft.notifications.line.changeTemplates = CHANGE_TEMPLATES.line;
  }),
  SAKURA_ID,
).config;
const withoutTemplates: ClientConfig = parseClientConfig(
  withChanges(readSakuraDocument(), (draft) => {
    delete draft.notifications.sms.changeTemplates;
    delete draft.notifications.line.changeTemplates;
    // Without LINE change templates the config is only valid for a client that has not opted in.
    delete draft.reservationFlow;
  }),
  SAKURA_ID,
).config;

class FakeSms implements SmsSender {
  readonly sent: SmsMessage[] = [];
  send(message: SmsMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'sms-1' });
  }
}

class FakeLine implements LinePusher {
  readonly pushed: LinePushMessage[] = [];
  push(message: LinePushMessage): Promise<{ messageId?: string }> {
    this.pushed.push(message);
    return Promise.resolve({ messageId: 'line-1' });
  }
}

type MemoryRow = Omit<NewNotificationLogEntry, 'status'> & { status: NotificationStatus };

class MemoryLog implements NotificationLogRepository {
  readonly entries: MemoryRow[] = [];
  failWith: Error | undefined;
  readonly queries: ReservedCountQuery[] = [];

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
    const row = this.entries[Number(id)];
    if (row) this.entries[Number(id)] = { ...row, ...settlement };
    return Promise.resolve();
  }
  countReserved(query: ReservedCountQuery): Promise<ReservedCounts> {
    this.queries.push(query);
    const live = this.entries.filter(
      (entry) =>
        entry.channel === query.channel && (entry.status === 'pending' || entry.status === 'sent'),
    );
    return Promise.resolve({
      forClient: live.length,
      forNumber: 0,
      // Per call AND per event: a booking and a change in one call do not count against each other.
      forCall: live.filter(
        (entry) => entry.callId === query.callId && (entry.event ?? 'booked') === query.event,
      ).length,
    });
  }
}

const cancelled: AppointmentChangeNotification = {
  kind: 'cancelled',
  clientId: SAKURA_ID,
  appointmentId: 'appt-1',
  callId: 'call-9',
  reservationNumber: 'R123456',
  language: 'ja',
  patientName: 'Hanako Yamada',
  serviceName: 'General Consultation',
  date: '2026-11-03',
  time: '10:00',
  oldDate: '2026-11-03',
  oldTime: '10:00',
  callerPhone: '09012345678',
};

const rescheduled: AppointmentChangeNotification = {
  ...cancelled,
  kind: 'rescheduled',
  date: '2026-11-05',
  time: '14:30',
};

function build(config: ClientConfig = withTemplates) {
  const sms = new FakeSms();
  const line = new FakeLine();
  const log = new MemoryLog();
  const notifier = new ChannelBookingNotifier({
    loadConfig: () => config,
    credential: (name) => CREDENTIALS[name],
    sms,
    line,
    log,
    now: () => new Date('2026-11-02T00:00:00Z'),
  });
  return { notifier, sms, line, log };
}

describe('notifyChanged — cancellation', () => {
  test('texts the caller and alerts staff, each with the cancellation wording', async () => {
    const { notifier, sms, line } = build();

    await notifier.notifyChanged(cancelled);

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({
      to: '+819012345678',
      text: 'さくら整骨院です。2026年11月3日 10:00のご予約をキャンセルしました。',
    });
    expect(line.pushed).toHaveLength(1);
    expect(line.pushed[0]?.text).toBe(
      '【予約キャンセル】さくら整骨院\n日時: 2026年11月3日 10:00\nお名前: Hanako Yamada',
    );
  });

  test('uses the call language for the caller SMS', async () => {
    const { notifier, sms } = build();

    await notifier.notifyChanged({ ...cancelled, language: 'en' });

    expect(sms.sent[0]?.text).toBe(
      'Sakura Seikotsuin: your appointment on November 3, 2026 at 10:00 is cancelled.',
    );
  });
});

describe('notifyChanged — reschedule', () => {
  test('tells the caller the new time and staff both the new and the old one', async () => {
    const { notifier, sms, line } = build();

    await notifier.notifyChanged(rescheduled);

    expect(sms.sent[0]?.text).toBe('さくら整骨院です。ご予約を2026年11月5日 14:30に変更しました。');
    expect(line.pushed[0]?.text).toBe(
      '【予約変更】さくら整骨院\n新: 2026年11月5日 14:30\n元: 2026年11月3日 10:00\n予約番号: R123456',
    );
  });

  test('the SMS holds only name, date and time — no link, no patient details', async () => {
    const { notifier, sms } = build();

    await notifier.notifyChanged(rescheduled);

    const text = sms.sent[0]?.text ?? '';
    expect(text).not.toMatch(/https?:|www\.|\.com|\.jp/i);
    expect(text).not.toContain('Hanako');
    expect(text).not.toContain('R123456');
    expect(text).not.toContain('[[');
  });

  test('gives each change its own idempotency key, apart from the booking’s', async () => {
    const { notifier, sms } = build();

    await notifier.notifyChanged(rescheduled);

    expect(sms.sent[0]?.idempotencyKey).toBe('change-appt-1-call-9-sms');
  });
});

describe('notifyChanged — delivery record and guards', () => {
  test('logs each send under the change event and the call that made the change', async () => {
    const { notifier, log } = build();

    await notifier.notifyChanged(cancelled);

    expect(log.entries).toHaveLength(2);
    for (const entry of log.entries) {
      expect(entry).toMatchObject({
        event: 'cancelled',
        callId: 'call-9',
        appointmentId: 'appt-1',
        status: 'sent',
      });
    }
  });

  test('counts the per-call limit per event, against the call that made the change', async () => {
    const { notifier, log } = build();

    await notifier.notifyChanged(rescheduled);

    expect(log.queries.map((query) => [query.channel, query.event, query.callId])).toEqual([
      ['sms', 'rescheduled', 'call-9'],
      ['line', 'rescheduled', 'call-9'],
    ]);
  });

  test('a second notification for the same change event in one call is refused', async () => {
    const { notifier, sms, line, log } = build();

    await notifier.notifyChanged(rescheduled);
    await notifier.notifyChanged({ ...rescheduled, appointmentId: 'appt-2' });

    expect(sms.sent).toHaveLength(1);
    expect(line.pushed).toHaveLength(1);
    expect(log.entries.filter((entry) => entry.detail === 'call_limit')).toHaveLength(2);
  });

  test('a client with no change templates is skipped on both channels, and says why', async () => {
    const { notifier, sms, line, log } = build(withoutTemplates);

    await notifier.notifyChanged(cancelled);

    expect(sms.sent).toHaveLength(0);
    expect(line.pushed).toHaveLength(0);
    expect(log.entries).toEqual([
      expect.objectContaining({ channel: 'sms', status: 'skipped', detail: 'no_template' }),
      expect.objectContaining({ channel: 'line', status: 'skipped', detail: 'no_template' }),
    ]);
  });

  test('keeps a forged line break in the patient name from adding lines to the staff alert', async () => {
    const { notifier, line } = build();

    await notifier.notifyChanged({ ...cancelled, patientName: 'Hanako\n【緊急】 call now' });

    expect(line.pushed[0]?.text).toContain('お名前: Hanako 【緊急】 call now');
    expect(line.pushed[0]?.text.split('\n')).toHaveLength(3);
  });

  test('never rejects, even when the delivery log is down', async () => {
    const { notifier, sms, log } = build();
    log.failWith = new Error('db down');

    await expect(notifier.notifyChanged(cancelled)).resolves.toBeUndefined();

    // Fails closed: with the cap guard unreachable nothing is sent.
    expect(sms.sent).toHaveLength(0);
  });
});
