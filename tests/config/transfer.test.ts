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
const issuesOf = (document: unknown) => captureIssues(() => parse(document)).issues;

describe('transfer config (VP-24)', () => {
  test('the Sakura config carries an enabled transfer block, with defaults filled in', () => {
    const { transfer } = parse(sakura).config;

    expect(transfer).toMatchObject({
      enabled: true,
      mode: 'blind-transfer',
      allowedCountryCodes: ['+81'],
      closingBufferMinutes: 10,
      maxPerDay: 10,
      closedDates: [],
    });
    expect(transfer?.numberEnv).toBe('TRANSFER_STAFF_NUMBER_SAKURA');
    expect(transfer?.fallbackPlan).toBeUndefined();
  });

  test('omitted optional fields take their defaults', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.transfer.allowedCountryCodes;
      delete draft.transfer.mode;
      delete draft.transfer.closingBufferMinutes;
      delete draft.transfer.maxPerDay;
      delete draft.transfer.closedDates;
    });

    expect(parse(document).config.transfer).toMatchObject({
      allowedCountryCodes: ['+81'],
      mode: 'blind-transfer',
      closingBufferMinutes: 10,
      maxPerDay: 20,
      closedDates: [],
    });
  });

  test('a client with no transfer block still parses (the section is optional)', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.transfer;
    });

    expect(parse(document).config.transfer).toBeUndefined();
  });

  test('a switched-off block is valid even without the callback flow it would otherwise need', () => {
    const document = withChanges(sakura, (draft) => {
      draft.transfer.enabled = false;
      draft.callback.enabled = false;
    });

    expect(parse(document).config.transfer?.enabled).toBe(false);
  });

  describe('the staff number (an env var reference, never the number)', () => {
    test('the yaml names a TRANSFER_ variable', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.numberEnv = 'TRANSFER_STAFF_NUMBER_OTHER';
      });

      expect(parse(document).config.transfer?.numberEnv).toBe('TRANSFER_STAFF_NUMBER_OTHER');
    });

    test.each(['DATABASE_URL', 'VAPI_API_KEY', 'transfer_staff', '+81312345678'])(
      'a variable outside the TRANSFER_ prefix (%s) is rejected: it would be dialled or leaked',
      (name) => {
        const document = withChanges(sakura, (draft) => {
          draft.transfer.numberEnv = name;
        });

        expect(issueAt(issuesOf(document), 'transfer.numberEnv')).toContain('TRANSFER_');
      },
    );

    test('a literal number key is an unknown key: the number cannot be put back in the yaml', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.number = '+81312345678';
      });

      expect(issueAt(issuesOf(document), 'transfer.number')).toMatch(/unknown key/i);
    });

    test('numberEnv is required', () => {
      const document = withChanges(sakura, (draft) => {
        delete draft.transfer.numberEnv;
      });

      expect(issuesOf(document).some((issue) => issue.path === 'transfer.numberEnv')).toBe(true);
    });

    test('a one-digit country code other than +1 / +7 is rejected as an allow-list entry', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.allowedCountryCodes = ['+8'];
      });

      expect(
        issuesOf(document).some((issue) => issue.path.startsWith('transfer.allowedCountryCodes')),
      ).toBe(true);
    });
  });

  describe('shape', () => {
    test('unknown keys inside the block are errors (typo guard)', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.timeoutSeconds = 30;
      });

      expect(issueAt(issuesOf(document), 'transfer.timeoutSeconds')).toMatch(/unknown key/i);
    });

    test('only the blind-transfer mode exists today', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.mode = 'warm-transfer-experimental';
      });

      expect(issuesOf(document).some((issue) => issue.path === 'transfer.mode')).toBe(true);
    });

    test.each([-1, 121, 1.5])('closingBufferMinutes %s is rejected', (minutes) => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.closingBufferMinutes = minutes;
      });

      expect(
        issuesOf(document).some((issue) => issue.path === 'transfer.closingBufferMinutes'),
      ).toBe(true);
    });

    test('no secret and no phone number lives in the block: it holds a variable name and wording', () => {
      const text = JSON.stringify(parse(sakura).config.transfer);

      expect(text).not.toMatch(/key|token|secret|Bearer/i);
      expect(text).not.toMatch(/\+\d{8,}/);
    });

    test.each([0, 201, 1.5])('maxPerDay %s is rejected', (limit) => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.maxPerDay = limit;
      });

      expect(issuesOf(document).some((issue) => issue.path === 'transfer.maxPerDay')).toBe(true);
    });
  });

  describe('hours the transfer gate could never satisfy', () => {
    test('overnight hours are an error while transfer is enabled', () => {
      const document = withChanges(sakura, (draft) => {
        draft.business.hours.weekly.mon = { open: '22:00', close: '02:00' };
      });

      expect(issueAt(issuesOf(document), 'business.hours.weekly.mon')).toMatch(/overnight/);
    });

    test('a closing buffer as long as the opening window is an error', () => {
      const document = withChanges(sakura, (draft) => {
        draft.business.hours.weekly.mon = { open: '10:00', close: '11:00' };
        draft.transfer.closingBufferMinutes = 60;
      });

      expect(issueAt(issuesOf(document), 'transfer.closingBufferMinutes')).toMatch(/mon/);
    });

    test('the same hours are fine when the transfer is switched off', () => {
      const document = withChanges(sakura, (draft) => {
        draft.business.hours.weekly.mon = { open: '22:00', close: '02:00' };
        draft.transfer.enabled = false;
      });

      expect(parse(document).config.transfer?.enabled).toBe(false);
    });
  });

  describe('closedDates', () => {
    test('accepts real calendar dates', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.closedDates = ['2026-11-23', '2027-01-01'];
      });

      expect(parse(document).config.transfer?.closedDates).toEqual(['2026-11-23', '2027-01-01']);
    });

    test.each(['23/11/2026', '2026-11-3', 'tomorrow'])('rejects the format %s', (date) => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.closedDates = [date];
      });

      expect(
        issuesOf(document).some((issue) => issue.path.startsWith('transfer.closedDates')),
      ).toBe(true);
    });

    test('rejects a date that matches the format but is not a day (2026-02-30)', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.closedDates = ['2026-02-30'];
      });

      expect(issueAt(issuesOf(document), 'transfer.closedDates.0')).toMatch(/real calendar date/);
    });
  });

  describe('the spoken lines', () => {
    test('every supported language needs every line', () => {
      const document = withChanges(sakura, (draft) => {
        delete draft.transfer.scripts.offer.en;
      });

      expect(issueAt(issuesOf(document), 'transfer.scripts.offer.en')).toMatch(/missing text/i);
    });

    test('text for a language that is not supported is rejected', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.scripts.failed.de = 'Es tut mir leid.';
      });

      expect(issueAt(issuesOf(document), 'transfer.scripts.failed.de')).toContain(
        'not in languages.supported',
      );
    });

    test('a clinic placeholder is allowed, an unknown or caller-only one is not', () => {
      const ok = withChanges(sakura, (draft) => {
        draft.transfer.scripts.transferring.en = 'One moment, connecting you to [[clinicName]].';
      });
      const unknown = withChanges(sakura, (draft) => {
        draft.transfer.scripts.transferring.en = 'Hello [[nope]].';
      });
      const caller = withChanges(sakura, (draft) => {
        draft.transfer.scripts.transferring.en = 'Hello [[callerName]].';
      });

      expect(parse(ok).config.transfer?.scripts.transferring['en']).toContain('[[clinicName]]');
      expect(issueAt(issuesOf(unknown), 'transfer.scripts.transferring.en')).toMatch(
        /unknown placeholder/,
      );
      expect(issueAt(issuesOf(caller), 'transfer.scripts.transferring.en')).toMatch(
        /only allowed in/,
      );
    });

    test.each(['{{ "now" | date: "%H" }}', '{% if x %}hi{% endif %}'])(
      'Liquid syntax (%s) is rejected: Vapi would evaluate it',
      (text) => {
        const document = withChanges(sakura, (draft) => {
          draft.transfer.scripts.offer.en = text;
        });

        expect(issueAt(issuesOf(document), 'transfer.scripts.offer.en')).toContain(
          'Vapi would evaluate',
        );
      },
    );
  });

  describe('the callback safety net', () => {
    test('an enabled transfer needs callback.enabled', () => {
      const document = withChanges(sakura, (draft) => {
        draft.callback.enabled = false;
      });

      expect(issueAt(issuesOf(document), 'transfer.enabled')).toContain('callback.enabled');
    });
  });

  describe('fallbackPlan (for a Vapi number or SIP trunk — inert on Telnyx)', () => {
    test('is optional; when given, endCallEnabled defaults to false (keep the caller)', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.fallbackPlan = { message: { ja: 'ja fallback', en: 'en fallback' } };
      });

      expect(parse(document).config.transfer?.fallbackPlan).toEqual({
        message: { ja: 'ja fallback', en: 'en fallback' },
        endCallEnabled: false,
      });
    });

    test('its message needs every supported language', () => {
      const document = withChanges(sakura, (draft) => {
        draft.transfer.fallbackPlan = { message: { ja: 'ja fallback' } };
      });

      expect(issueAt(issuesOf(document), 'transfer.fallbackPlan.message.en')).toMatch(
        /missing text/i,
      );
    });
  });
});
