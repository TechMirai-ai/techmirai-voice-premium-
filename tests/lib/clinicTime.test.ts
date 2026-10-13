import { describe, expect, test } from 'vitest';

import { formatClinicDateTime, timeZoneLabel } from '../../src/lib/clinicTime.js';

describe('formatClinicDateTime', () => {
  test('converts a UTC instant to Japan time (UTC+9)', () => {
    const when = new Date('2026-10-13T11:14:07.173Z');
    expect(formatClinicDateTime(when, 'Asia/Tokyo')).toBe('2026-10-13 20:14');
  });

  test('rolls the date forward when the UTC evening is already tomorrow in Japan', () => {
    expect(formatClinicDateTime(new Date('2026-12-31T15:30:00.000Z'), 'Asia/Tokyo')).toBe(
      '2027-01-01 00:30',
    );
  });

  test('renders midnight as 00:xx, not 24:xx', () => {
    expect(formatClinicDateTime(new Date('2026-10-12T15:05:00.000Z'), 'Asia/Tokyo')).toBe(
      '2026-10-13 00:05',
    );
  });

  test('honours another clinic’s timezone, including daylight saving', () => {
    const summer = new Date('2026-07-01T12:00:00.000Z');
    expect(formatClinicDateTime(summer, 'Europe/London')).toBe('2026-07-01 13:00');
    expect(formatClinicDateTime(summer, 'UTC')).toBe('2026-07-01 12:00');
  });

  test('returns an empty string for an invalid date instead of throwing', () => {
    expect(formatClinicDateTime(new Date('not a date'), 'Asia/Tokyo')).toBe('');
  });
});

describe('timeZoneLabel', () => {
  test('labels Japan as JST', () => {
    expect(timeZoneLabel('Asia/Tokyo')).toBe('JST');
  });

  test('labels other zones by their UTC offset', () => {
    expect(timeZoneLabel('UTC', new Date('2026-07-01T00:00:00Z'))).toBe('UTC');
    expect(timeZoneLabel('Europe/London', new Date('2026-07-01T00:00:00Z'))).toBe('UTC+1');
  });
});
