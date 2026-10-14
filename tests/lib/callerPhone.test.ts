import { describe, expect, test } from 'vitest';

import { normalizeCallerPhone } from '../../src/lib/callerPhone.js';

describe('normalizeCallerPhone', () => {
  test.each([
    ['090-1234-5678', '09012345678'],
    ['090 1234 5678', '09012345678'],
    ['(03) 1234-5678', '0312345678'],
    ['０９０－１２３４－５６７８', '09012345678'],
    ['+81 90-1234-5678', '09012345678'],
    ['+81 (0)90 1234 5678', '09012345678'],
    ['  09012345678  ', '09012345678'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeCallerPhone(raw)).toBe(expected);
  });

  test('accepts other international numbers as +digits', () => {
    expect(normalizeCallerPhone('+1 (415) 555-0132')).toBe('+14155550132');
  });

  test.each([
    '',
    '   ',
    'abc',
    '12345',
    '090-1234',
    '0901234567890123',
    '+1',
    '90-1234-5678',
    '090-abcd-5678',
  ])('rejects %j', (raw) => {
    expect(normalizeCallerPhone(raw)).toBeUndefined();
  });

  test('the same number typed two ways normalises identically', () => {
    expect(normalizeCallerPhone('090-1234-5678')).toBe(normalizeCallerPhone('+819012345678'));
  });
});
