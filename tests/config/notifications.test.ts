import { describe, expect, test } from 'vitest';

import { parseClientConfig } from '../../src/config/schema.js';
import {
  captureIssues,
  issueAt,
  readSakuraDocument,
  SAKURA_ID,
  withChanges,
} from '../helpers/clientFixtures.js';

const sakura = readSakuraDocument();
const parse = (document: unknown) => parseClientConfig(document, SAKURA_ID);

describe('notifications config (VP-23)', () => {
  test('the Sakura config carries an SMS and a LINE block, with defaults filled in', () => {
    const { notifications } = parse(sakura).config;

    expect(notifications?.sms).toMatchObject({
      provider: 'telnyx',
      apiKeyEnv: 'TELNYX_API_KEY',
      senderId: 'Sakura',
      defaultCountryCode: '+81',
      maxPerRecipientPerDay: 3,
    });
    expect(notifications?.line?.channelAccessTokenEnv).toBe('LINE_CHANNEL_ACCESS_TOKEN');
    expect(notifications?.line?.recipientEnvs).toEqual(['LINE_STAFF_USER_ID']);
  });

  test('holds no secret: only env-var NAMES, never a key or token value', () => {
    const text = JSON.stringify(parse(sakura).config.notifications);

    expect(text).not.toMatch(/KEY_[A-Za-z0-9]{20,}|Bearer|secret/i);
    expect(text).not.toMatch(/\bU[0-9a-f]{32}\b/);
  });

  test('a client with no notifications block still parses (the section is optional)', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.notifications;
    });

    expect(parse(document).config.notifications).toBeUndefined();
  });

  test('the SMS section alone, or the LINE section alone, is valid', () => {
    const smsOnly = withChanges(sakura, (draft) => {
      delete draft.notifications.line;
    });
    const lineOnly = withChanges(sakura, (draft) => {
      delete draft.notifications.sms;
    });

    expect(parse(smsOnly).config.notifications?.line).toBeUndefined();
    expect(parse(lineOnly).config.notifications?.sms).toBeUndefined();
  });

  describe('caller-facing SMS templates', () => {
    test('requires a template for the default language (the fallback for the rest)', () => {
      const document = withChanges(sakura, (draft) => {
        delete draft.notifications.sms.templates.ja;
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.sms.templates.ja')).toMatch(/default language/i);
    });

    test('rejects a template for a language the client does not support', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.templates.fr = '[[businessName]] [[date]] [[time]]';
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.sms.templates.fr')).toMatch(
        /not in languages\.supported/,
      );
    });

    test.each([
      ['an https link', '[[businessName]] https://example.test/book'],
      ['a www link', '[[businessName]] www.example.test'],
      ['a bare domain', '[[businessName]] see example.com for details'],
    ])('rejects %s — confirmations stay factual', (_label, text) => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.templates.en = text;
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.sms.templates.en')).toMatch(/URL|link/i);
    });

    test('rejects a placeholder outside businessName/date/time (no patient details by SMS)', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.templates.en = '[[businessName]] for [[patientName]]';
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.sms.templates.en')).toMatch(
        /unknown placeholder "\[\[patientName\]\]"/,
      );
    });
  });

  describe('staff LINE message', () => {
    test('allows the booking details staff need', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.line.messageTemplate =
          '[[businessName]] [[date]] [[time]] [[patientName]] [[patientPhone]] [[serviceName]] [[reservationNumber]]';
      });

      expect(() => parse(document)).not.toThrow();
    });

    test('rejects an unknown placeholder', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.line.messageTemplate = '[[businessName]] [[diagnosis]]';
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.line.messageTemplate')).toMatch(
        /unknown placeholder "\[\[diagnosis\]\]"/,
      );
    });
  });

  describe('credentials are named, and only by provider-prefixed env vars', () => {
    test('rejects an SMS key variable outside TELNYX_ (a typo must not send DATABASE_URL to Telnyx)', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.apiKeyEnv = 'DATABASE_URL';
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.sms.apiKeyEnv')).toMatch(/starting with TELNYX_/);
    });

    test('rejects a LINE token variable outside LINE_', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.line.channelAccessTokenEnv = 'SESSION_SECRET';
      });

      const { issues } = captureIssues(() => parse(document));

      expect(issueAt(issues, 'notifications.line.channelAccessTokenEnv')).toMatch(
        /starting with LINE_/,
      );
    });

    test('rejects a LINE recipient variable outside LINE_', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.line.recipientEnvs = ['LINE_STAFF_USER_ID', 'DATABASE_URL'];
      });

      const { issues } = captureIssues(() => parse(document));

      expect(
        issues.some((issue) => issue.path.startsWith('notifications.line.recipientEnvs')),
      ).toBe(true);
    });

    test('accepts a second client with its own variable names and several recipients', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.apiKeyEnv = 'TELNYX_API_KEY_OTHER';
        draft.notifications.line.channelAccessTokenEnv = 'LINE_OTHER_ACCESS_TOKEN';
        draft.notifications.line.recipientEnvs = ['LINE_OTHER_GROUP_ID', 'LINE_OTHER_OWNER_ID'];
      });

      expect(() => parse(document)).not.toThrow();
    });
  });

  describe('sender and limits', () => {
    test.each(['Way Too Long Sender', '12345', 'has space', 'ab', 'TwelveLetters'])(
      'rejects the sender id %j',
      (senderId) => {
        const document = withChanges(sakura, (draft) => {
          draft.notifications.sms.senderId = senderId;
        });

        expect(() => parse(document)).toThrow();
      },
    );

    test('accepts an E.164 number as the sender', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.senderId = '+81312345678';
      });

      expect(() => parse(document)).not.toThrow();
    });

    test('rejects an unknown key inside the sms block (typos are errors)', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.sms.sendeerId = 'Sakura';
      });

      expect(() => parse(document)).toThrow();
    });

    test('requires at least one LINE recipient', () => {
      const document = withChanges(sakura, (draft) => {
        draft.notifications.line.recipientEnvs = [];
      });

      expect(() => parse(document)).toThrow();
    });
  });
});
