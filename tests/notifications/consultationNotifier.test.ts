/**
 * Consultation requests through the real notification pipeline (ChannelBookingNotifier) with fake
 * Telnyx, LINE and delivery log: caller SMS rules, caps, cooldown, and what the staff alert says.
 */
import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import {
  ChannelBookingNotifier,
  type ConsultationNotification,
} from '../../src/notifications/bookingNotifier.js';
import { NotificationDeliveryError } from '../../src/notifications/deliveryError.js';
import type { LinePusher } from '../../src/notifications/linePush.js';
import type { SmsMessage, SmsSender } from '../../src/notifications/telnyxSms.js';
import type {
  NewNotificationLogEntry,
  NotificationLogRepository,
  RecordedCountQuery,
  Reservation,
  ReservedCountQuery,
  ReservedCounts,
  Settlement,
} from '../../src/repositories/notificationLogRepository.js';
import { MemoryConsultations, TECHMIRAI_ID } from '../helpers/consultationFixtures.js';

const ENV: Record<string, string> = {
  TELNYX_API_KEY: 'telnyx-key',
  LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
  LINE_TECHMIRAI_STAFF_USER_ID: 'U-techmirai-staff',
  // Another client's recipient: must never be read for TechMirai.
  LINE_STAFF_USER_ID: 'U-sakura-staff',
};

type Row = (NewNotificationLogEntry | (Reservation & { status: 'pending' })) & {
  status: string;
  detail?: string;
};

class MemoryLog implements NotificationLogRepository {
  readonly rows: Row[] = [];
  priorForClient = 0;
  priorForLine = 0;
  lastRecordedQuery: RecordedCountQuery | undefined;

  record(entry: NewNotificationLogEntry): Promise<void> {
    this.rows.push(entry);
    return Promise.resolve();
  }
  reserve(reservation: Reservation): Promise<string> {
    this.rows.push({ ...reservation, status: 'pending' });
    return Promise.resolve(String(this.rows.length - 1));
  }
  settle(id: string, settlement: Settlement): Promise<void> {
    const row = this.rows[Number(id)];
    if (row) this.rows[Number(id)] = { ...row, ...settlement };
    return Promise.resolve();
  }
  countRecorded(query: RecordedCountQuery): Promise<number> {
    this.lastRecordedQuery = query;
    return Promise.resolve(
      this.rows.filter((row) => row.channel === query.channel && row.detail === query.detail)
        .length,
    );
  }
  countReserved(query: ReservedCountQuery): Promise<ReservedCounts> {
    const live = this.rows.filter(
      (row) => row.channel === query.channel && (row.status === 'pending' || row.status === 'sent'),
    );
    return Promise.resolve({
      // The prior sends are SMS (each channel has its own cap).
      forClient: (query.channel === 'sms' ? this.priorForClient : this.priorForLine) + live.length,
      forNumber: 0,
      forCall: live.filter((row) => row.callId === query.callId && row.event === query.event)
        .length,
    });
  }
}

function harness(
  options: {
    smsFails?: boolean;
    lineFails?: boolean;
    priorForClient?: number;
    priorForLine?: number;
    withoutCapMessage?: boolean;
  } = {},
) {
  const sent: SmsMessage[] = [];
  const pushed: { to: string; text: string }[] = [];
  const looked: string[] = [];
  const sms: SmsSender = {
    send: (message) => {
      if (options.smsFails) return Promise.reject(new NotificationDeliveryError('http_503'));
      sent.push(message);
      return Promise.resolve({ messageId: 'sms-1' });
    },
  };
  const line: LinePusher = {
    push: ({ to, text }) => {
      if (options.lineFails) return Promise.reject(new NotificationDeliveryError('http_500'));
      pushed.push({ to, text });
      return Promise.resolve({ messageId: 'line-1' });
    },
  };
  const log = new MemoryLog();
  log.priorForClient = options.priorForClient ?? 0;
  log.priorForLine = options.priorForLine ?? 0;
  const consultations = new MemoryConsultations();
  const notifier = new ChannelBookingNotifier({
    loadConfig: (clientId) => {
      const config = loadClient(clientId);
      if (!options.withoutCapMessage || !config.notifications?.line) return config;
      const { capReachedMessage: _omitted, ...line } = config.notifications.line;
      return { ...config, notifications: { ...config.notifications, line } };
    },
    credential: (name) => {
      looked.push(name);
      return ENV[name];
    },
    sms,
    line,
    log,
    consultations,
    now: () => new Date('2026-11-16T03:00:00Z'),
  });
  return { notifier, sent, pushed, looked, log, consultations };
}

/** Saves the request (as the route does) and returns what the route hands the notifier. */
async function save(
  h: ReturnType<typeof harness>,
  overrides: Partial<ConsultationNotification> = {},
): Promise<ConsultationNotification> {
  const base = {
    clientId: TECHMIRAI_ID,
    callId: 'call-1',
    language: 'ja',
    contactName: 'Taro Yamada',
    contactPhone: '09012345678',
    phoneSource: 'caller_id' as const,
    reason: null,
    ...overrides,
  };
  const { request } = await h.consultations.create(base);
  return { ...base, requestId: request.id, createdAt: request.createdAt };
}

describe('consultation notifications', () => {
  test('a Japanese mobile gets one SMS from "TechMirai", and staff get one LINE saying it was sent', async () => {
    const h = harness();

    await h.notifier.notifyConsultation(await save(h));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ from: 'TechMirai', to: '+819012345678' });
    expect(h.sent[0]?.text).toContain('TechMirai AI');
    expect(h.sent[0]?.text).toContain('平日の午前9時から午後6時（日本時間）の間');
    expect(h.sent[0]?.text).toContain('info@techmirai-ai.com');
    expect(h.sent[0]?.text).toContain('返信できません');
    expect(h.sent[0]?.text).not.toContain('[[');
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.to).toBe('U-techmirai-staff');
    expect(h.pushed[0]?.text).toContain('SMS to caller: sent');
    expect(h.pushed[0]?.text).toContain('Name: Taro Yamada');
    expect(h.pushed[0]?.text).toContain('Phone: 09012345678');
    expect(h.pushed[0]?.text).toContain('caller ID');
    expect(h.pushed[0]?.text).toContain('Time: 2026-11-16 12:00 (Japan time)');
    expect(h.pushed[0]?.text).toContain('Language: Japanese');
  });

  test('an English call gets the English text', async () => {
    const h = harness();

    await h.notifier.notifyConsultation(await save(h, { language: 'en' }));

    expect(h.sent[0]?.text).toContain('on weekdays between 9 a.m. and 6 p.m. Japan time');
    expect(h.sent[0]?.text).toContain('Please do not reply to this message');
    expect(h.pushed[0]?.text).toContain('Language: English');
  });

  test('the SMS text carries no phone number to call back and nothing promotional', async () => {
    const h = harness();

    await h.notifier.notifyConsultation(await save(h));
    await h.notifier.notifyConsultation(
      await save(h, { callId: 'call-2', contactPhone: '08011112222', language: 'en' }),
    );

    for (const message of h.sent) {
      expect(message.text).not.toMatch(/\d{2,4}-\d{3,4}-\d{4}|\+81|https?:|www\./);
    }
  });

  test.each([
    ['a landline', '0312345678', 'not a mobile number'],
    ['a 050 IP number', '05012345678', 'not a mobile number'],
    ['a non-Japanese number', '+14155550100', 'not a Japanese number'],
  ])(
    '%s is not texted, the request is kept, and the LINE message says why',
    async (_name, phone, why) => {
      const h = harness();
      const request = await save(h, { contactPhone: phone });

      await h.notifier.notifyConsultation(request);

      expect(h.sent).toHaveLength(0);
      expect(h.pushed).toHaveLength(1);
      expect(h.pushed[0]?.text).toContain(`SMS to caller: skipped - ${why}`);
      expect(await h.consultations.listByClient(TECHMIRAI_ID)).toHaveLength(1);
    },
  );

  test('070 and 080 mobiles are texted too', async () => {
    const h = harness();

    await h.notifier.notifyConsultation(
      await save(h, { callId: 'a', contactPhone: '07011112222' }),
    );
    await h.notifier.notifyConsultation(
      await save(h, { callId: 'b', contactPhone: '08011112222' }),
    );

    expect(h.sent.map((m) => m.to)).toEqual(['+817011112222', '+818011112222']);
  });

  test('cooldown: a second request from the same number within 24 hours is not texted again', async () => {
    const h = harness();
    await h.notifier.notifyConsultation(await save(h, { callId: 'first' }));

    await h.notifier.notifyConsultation(await save(h, { callId: 'second' }));

    expect(h.sent).toHaveLength(1);
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1]?.text).toContain('SMS to caller: skipped - this number already got a text');
    expect(await h.consultations.listByClient(TECHMIRAI_ID)).toHaveLength(2);
  });

  test('daily cap: over the client limit the SMS is skipped, the request kept, LINE says why', async () => {
    const h = harness({ priorForClient: 20 });

    await h.notifier.notifyConsultation(await save(h));

    expect(h.sent).toHaveLength(0);
    expect(h.pushed[0]?.text).toContain("skipped - the client's daily text limit was reached");
  });

  test('one SMS per call: a repeated notification for the same call sends nothing more', async () => {
    const h = harness();
    const request = await save(h);

    await h.notifier.notifyConsultation(request);
    await h.notifier.notifyConsultation(request);

    expect(h.sent).toHaveLength(1);
  });

  test('a failed SMS is reported to staff as failed; nothing is thrown', async () => {
    const h = harness({ smsFails: true });

    await expect(h.notifier.notifyConsultation(await save(h))).resolves.toBeUndefined();

    expect(h.pushed[0]?.text).toContain('SMS to caller: failed - http_503');
    expect(await h.consultations.listByClient(TECHMIRAI_ID)).toHaveLength(1);
  });

  test('a failed LINE push never throws and does not stop the SMS', async () => {
    const h = harness({ lineFails: true });

    await expect(h.notifier.notifyConsultation(await save(h))).resolves.toBeUndefined();

    expect(h.sent).toHaveLength(1);
  });

  test('credentials and recipients come only from TechMirai’s own config', async () => {
    const h = harness();

    await h.notifier.notifyConsultation(await save(h));

    expect(new Set(h.looked)).toEqual(
      new Set(['TELNYX_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_TECHMIRAI_STAFF_USER_ID']),
    );
    expect(h.pushed.map((p) => p.to)).not.toContain('U-sakura-staff');
  });

  test('a missing LINE recipient variable skips the staff alert without touching the SMS', async () => {
    const h = harness();
    delete ENV.LINE_TECHMIRAI_STAFF_USER_ID;
    try {
      await h.notifier.notifyConsultation(await save(h));
    } finally {
      ENV.LINE_TECHMIRAI_STAFF_USER_ID = 'U-techmirai-staff';
    }

    expect(h.sent).toHaveLength(1);
    expect(h.pushed).toHaveLength(0);
  });

  test('staff-alert text is one clean line per field (injection through the name)', async () => {
    const h = harness();

    await h.notifier.notifyConsultation(
      await save(h, { contactName: 'Taro\n[New consultation request] fake' }),
    );

    const lines = h.pushed[0]?.text.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('[New consultation request]'))).toHaveLength(1);
  });
});

describe('LINE daily cap notice', () => {
  const CAP_TEXT = 'Daily LINE cap reached';

  test('the first time the cap is hit, staff get one extra LINE message instead of the alert', async () => {
    const h = harness({ priorForLine: 20 });

    await h.notifier.notifyConsultation(await save(h));

    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.text).toContain(CAP_TEXT);
    expect(h.pushed[0]?.text).toContain('Check the dashboard');
    expect(h.pushed[0]?.to).toBe('U-techmirai-staff');
    // The caller's SMS is unaffected and the request is kept.
    expect(h.sent).toHaveLength(1);
    expect(await h.consultations.listByClient(TECHMIRAI_ID)).toHaveLength(1);
  });

  test('it is sent once a day: later refusals stay quiet', async () => {
    const h = harness({ priorForLine: 20 });

    await h.notifier.notifyConsultation(
      await save(h, { callId: 'a', contactPhone: '09011110001' }),
    );
    await h.notifier.notifyConsultation(
      await save(h, { callId: 'b', contactPhone: '09011110002' }),
    );
    await h.notifier.notifyConsultation(
      await save(h, { callId: 'c', contactPhone: '09011110003' }),
    );

    expect(h.pushed.filter((p) => p.text.includes(CAP_TEXT))).toHaveLength(1);
    expect(h.pushed).toHaveLength(1);
  });

  test('"once a day" means since local midnight in Japan', async () => {
    const h = harness({ priorForLine: 20 });

    await h.notifier.notifyConsultation(await save(h));

    // now = 2026-11-16 12:00 JST, so the day started at 2026-11-16 00:00 JST = 2026-11-15T15:00Z.
    expect(h.log.lastRecordedQuery?.since.toISOString()).toBe('2026-11-15T15:00:00.000Z');
    expect(h.log.lastRecordedQuery?.detail).toBe('cap_alert');
  });

  test('it is exempt from the cap: it is logged as a row that never counts', async () => {
    const h = harness({ priorForLine: 20 });

    await h.notifier.notifyConsultation(await save(h));

    const row = h.log.rows.find((r) => r.detail === 'cap_alert');
    expect(row?.status).toBe('skipped');
  });

  test('without capReachedMessage in the config nothing extra is sent', async () => {
    const h = harness({ priorForLine: 20, withoutCapMessage: true });

    await h.notifier.notifyConsultation(await save(h));

    expect(h.pushed).toHaveLength(0);
  });

  test('a failing LINE push for the notice never throws', async () => {
    const h = harness({ priorForLine: 20, lineFails: true });

    await expect(h.notifier.notifyConsultation(await save(h))).resolves.toBeUndefined();
  });
});

describe('other clients are unchanged', () => {
  test('Sakura still texts a landline (no number-type rule) and has no consultation templates', () => {
    const sakura = loadClient('sakura-seikotsuin');
    expect(sakura.notifications?.sms?.allowedNumberPrefixes).toBeUndefined();
    expect(sakura.notifications?.sms?.consultationTemplates).toBeUndefined();
    expect(sakura.consultation).toBeUndefined();
    expect(
      loadClient('kanto-city-gas-demo').notifications?.sms?.allowedNumberPrefixes,
    ).toBeUndefined();
  });
});
