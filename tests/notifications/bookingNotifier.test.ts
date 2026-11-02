import { describe, expect, test } from 'vitest';

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

class MemoryLog implements NotificationLogRepository {
  readonly entries: NewNotificationLogEntry[] = [];
  recentSms = 0;
  failWith: Error | undefined;
  lastCount: { clientId: string; phone: string; since: Date } | undefined;

  record(entry: NewNotificationLogEntry): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.entries.push(entry);
    return Promise.resolve();
  }

  countSmsSentToNumber(clientId: string, phone: string, since: Date): Promise<number> {
    this.lastCount = { clientId, phone, since };
    return Promise.resolve(this.recentSms);
  }
}

const booking: BookingNotification = {
  clientId: SAKURA_ID,
  appointmentId: 'appt-1',
  reservationNumber: 'R123456',
  language: 'ja',
  patientName: 'Hanako Yamada',
  serviceName: 'General Consultation',
  date: '2026-11-03',
  time: '10:00',
  callerPhone: '09012345678',
};

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

  test('dials an international caller number as it is', async () => {
    const { notifier, sms } = build();

    await notifier.notifyBooked({ ...booking, callerPhone: '+14155550132' });

    expect(sms.sent[0]?.to).toBe('+14155550132');
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
    log.recentSms = 3;

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(0);
    expect(entryFor(log, 'sms')).toMatchObject({ status: 'skipped', detail: 'rate_limited' });
    expect(log.lastCount).toEqual({
      clientId: SAKURA_ID,
      phone: '09012345678',
      since: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    });
  });

  test('sends while still under the cap', async () => {
    const { notifier, sms, log } = build();
    log.recentSms = 2;

    await notifier.notifyBooked(booking);

    expect(sms.sent).toHaveLength(1);
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

  test('resolves, and still sends, when the delivery log itself is down', async () => {
    const { notifier, sms, line, log } = build();
    log.failWith = new Error('connection refused');

    await expect(notifier.notifyBooked(booking)).resolves.toBeUndefined();

    expect(sms.sent).toHaveLength(1);
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
