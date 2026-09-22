import { describe, expect, test } from 'vitest';

import { PHONE_MASK, redactPersonalData, VALUE_MASK } from '../../src/lib/redact.js';

describe('redactPersonalData', () => {
  test.each([
    ['048-000-0000', 'Japanese, hyphenated'],
    ['04800000000', 'Japanese, no hyphens'],
    ['+81480000000', 'E.164'],
    ['+81 48 000 0000', 'E.164 with spaces'],
    ['090-1234-5678', 'Japanese mobile'],
    ['０４８－０００－００００', 'full-width digits'],
  ])('masks %s (%s)', (phone) => {
    const redacted = redactPersonalData(`Please call ${phone} today`);

    expect(redacted).not.toContain(phone);
    expect(redacted).toContain(PHONE_MASK);
  });

  test('masks a phone number in the middle of Japanese text', () => {
    // 当院（048-000-0000）まで = "call the clinic at (048-000-0000)"
    const redacted = redactPersonalData('当院（048-000-0000）まで直接お電話ください。');

    expect(redacted).not.toContain('048-000-0000');
    expect(redacted).toContain(PHONE_MASK);
  });

  test.each(['callerName', 'callerPhone', 'name', 'phone'])(
    'masks any value under the key %s',
    (key) => {
      const redacted = redactPersonalData({
        [key]: '山田太郎',
        clientId: 'sakura-seikotsuin',
      }) as Record<string, unknown>;

      expect(redacted[key]).toBe(VALUE_MASK);
      expect(redacted.clientId).toBe('sakura-seikotsuin');
    },
  );

  // VP-5 §3: staff-login passwords are treated with the same seriousness as
  // a caller's name/phone — never written to a log, plaintext or hashed.
  test.each(['password', 'passwordHash', 'newPassword', 'confirmPassword', 'temporaryPassword'])(
    'masks any value under the key %s',
    (key) => {
      const redacted = redactPersonalData({
        [key]: 'super-secret-value-123',
        staffUserId: 'staff-1',
      }) as Record<string, unknown>;

      expect(redacted[key]).toBe(VALUE_MASK);
      expect(redacted.staffUserId).toBe('staff-1');
    },
  );

  test('walks nested objects and arrays without mutating the input', () => {
    const input = {
      call: { callerName: '山田太郎', notes: ['reach me on 090-1234-5678'] },
      clientId: 'sakura-seikotsuin',
    };

    const redacted = redactPersonalData(input) as typeof input;

    expect(redacted.call.callerName).toBe(VALUE_MASK);
    expect(redacted.call.notes[0]).toContain(PHONE_MASK);
    // the original object is untouched
    expect(input.call.callerName).toBe('山田太郎');
    expect(input.call.notes[0]).toContain('090-1234-5678');
  });

  test.each([
    'The clinic is open 09:00 to 19:00.',
    'We are at 1-2-3 Sample-cho, Urawa-ku.',
    'Postal code 330-0000.',
    'Checked: 2026-09-17.',
    'さくら整骨院の受付です。',
  ])('leaves normal text unchanged: %s', (text) => {
    expect(redactPersonalData(text)).toBe(text);
  });

  test('leaves non-string scalars alone', () => {
    expect(redactPersonalData(42)).toBe(42);
    expect(redactPersonalData(null)).toBeNull();
    expect(redactPersonalData(undefined)).toBeUndefined();
  });

  test('keeps both copies when the same object is referenced twice', () => {
    const shared = { note: 'no personal data here' };

    const redacted = redactPersonalData({ first: shared, second: shared }) as {
      first: { note: string };
      second: { note: string };
    };

    expect(redacted.first).toEqual({ note: 'no personal data here' });
    expect(redacted.second).toEqual({ note: 'no personal data here' });
  });

  test('formats a Date instead of flattening it to an empty object', () => {
    const redacted = redactPersonalData({ at: new Date('2026-09-18T00:00:00.000Z') }) as {
      at: string;
    };

    expect(redacted.at).toBe('2026-09-18T00:00:00.000Z');
  });

  test('survives a circular object', () => {
    const node: Record<string, unknown> = { clientId: 'sakura-seikotsuin' };
    node.self = node;

    expect(() => redactPersonalData(node)).not.toThrow();
  });

  test('redacts an Error message but keeps the error name', () => {
    const redacted = redactPersonalData(new Error('failed to reach 090-1234-5678')) as {
      name: string;
      message: string;
    };

    expect(redacted.name).toBe('Error');
    expect(redacted.message).toContain(PHONE_MASK);
  });
});
