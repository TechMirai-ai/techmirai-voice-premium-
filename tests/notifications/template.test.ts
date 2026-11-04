import { describe, expect, test } from 'vitest';

import {
  formatBookingDate,
  MAX_INLINE_VALUE_LENGTH,
  renderTemplate,
  sanitizeInline,
} from '../../src/notifications/template.js';

describe('sanitizeInline', () => {
  test('leaves an ordinary name alone', () => {
    expect(sanitizeInline('Hanako Yamada')).toBe('Hanako Yamada');
    expect(sanitizeInline('山田 花子')).toBe('山田 花子');
  });

  test.each([
    ['LF', 'Tanaka\n【緊急】 call', 'Tanaka 【緊急】 call'],
    ['CRLF', 'Tanaka\r\nURGENT', 'Tanaka URGENT'],
    ['tab', 'Tanaka\tURGENT', 'Tanaka URGENT'],
    ['NUL / BEL / ESC', `Tanaka${String.fromCharCode(0, 7, 27)}URGENT`, 'Tanaka URGENT'],
    ['NEL (U+0085)', `Tanaka${String.fromCharCode(0x85)}URGENT`, 'Tanaka URGENT'],
    ['line separator (U+2028)', `Tanaka${String.fromCharCode(0x2028)}URGENT`, 'Tanaka URGENT'],
    ['paragraph separator (U+2029)', `Tanaka${String.fromCharCode(0x2029)}URGENT`, 'Tanaka URGENT'],
  ])('turns %s into a single space', (_label, input, expected) => {
    expect(sanitizeInline(input)).toBe(expected);
  });

  test.each([
    ['right-to-left override (U+202E)', 0x202e],
    ['left-to-right isolate (U+2066)', 0x2066],
    ['pop directional isolate (U+2069)', 0x2069],
    ['zero-width space (U+200B)', 0x200b],
    ['zero-width joiner (U+200D)', 0x200d],
    ['word joiner (U+2060)', 0x2060],
    ['byte-order mark (U+FEFF)', 0xfeff],
    ['soft hyphen (U+00AD)', 0x00ad],
  ])('drops %s without splitting the word', (_label, codePoint) => {
    const hidden = String.fromCharCode(codePoint);

    expect(sanitizeInline(`Tana${hidden}ka`)).toBe('Tanaka');
    expect(sanitizeInline(`${hidden}Tanaka${hidden}`)).toBe('Tanaka');
  });

  test('returns an empty string for text that is only invisible characters', () => {
    expect(sanitizeInline(String.fromCharCode(0x202e, 0x200b, 0xfeff))).toBe('');
  });

  test('collapses runs of whitespace and trims the ends', () => {
    expect(sanitizeInline('  Tanaka \n\n   Taro  ')).toBe('Tanaka Taro');
  });

  test('caps the length by characters, not UTF-16 units', () => {
    const long = '😀'.repeat(MAX_INLINE_VALUE_LENGTH + 50);

    const result = sanitizeInline(long);

    expect(Array.from(result)).toHaveLength(MAX_INLINE_VALUE_LENGTH);
  });

  test('returns an empty string for text that is only control characters', () => {
    expect(sanitizeInline('\n\r\t')).toBe('');
  });
});

describe('renderTemplate', () => {
  test('fills every [[placeholder]]', () => {
    expect(
      renderTemplate('[[businessName]]: [[date]] at [[time]]', {
        businessName: 'Sakura',
        date: 'November 3, 2026',
        time: '10:00',
      }),
    ).toBe('Sakura: November 3, 2026 at 10:00');
  });

  test('tolerates spaces inside the brackets', () => {
    expect(renderTemplate('[[ time ]]', { time: '10:00' })).toBe('10:00');
  });

  test('renders an unknown placeholder as empty rather than leaking "[[name]]" to a phone', () => {
    expect(renderTemplate('a [[nope]] b', {})).toBe('a  b');
  });

  test('does not interpret $ patterns in a value', () => {
    expect(renderTemplate('[[businessName]]', { businessName: "$& $1 $'" })).toBe("$& $1 $'");
  });
});

describe('formatBookingDate', () => {
  test('writes a Japanese date in Japanese style', () => {
    expect(formatBookingDate('2026-11-03', 'ja')).toBe('2026年11月3日');
  });

  test('writes an English date in English style', () => {
    expect(formatBookingDate('2026-11-03', 'en')).toBe('November 3, 2026');
  });

  test('the language code alone picks the format — a new language needs no code', () => {
    expect(formatBookingDate('2026-11-03', 'de')).toBe('3. November 2026');
  });

  test('never shifts the day with the server time zone', () => {
    expect(formatBookingDate('2026-01-01', 'en')).toBe('January 1, 2026');
    expect(formatBookingDate('2026-12-31', 'en')).toBe('December 31, 2026');
  });

  test('falls back to the ISO text for an unusable language code', () => {
    expect(formatBookingDate('2026-11-03', 'not a language!')).toBe('2026-11-03');
  });

  test('returns an unparseable date unchanged', () => {
    expect(formatBookingDate('soon', 'en')).toBe('soon');
  });
});
