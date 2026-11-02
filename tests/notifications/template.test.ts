import { describe, expect, test } from 'vitest';

import { formatBookingDate, renderTemplate } from '../../src/notifications/template.js';

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
