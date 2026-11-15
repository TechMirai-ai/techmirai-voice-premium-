import { describe, expect, test } from 'vitest';

import { startOfClinicDay } from '../../src/lib/clinicTime.js';

describe('startOfClinicDay', () => {
  test('is local midnight in the zone, as an instant', () => {
    expect(startOfClinicDay(new Date('2026-11-16T03:00:00Z'), 'Asia/Tokyo').toISOString()).toBe(
      '2026-11-15T15:00:00.000Z',
    );
  });

  test('just after local midnight and just before the next one stay on the same day', () => {
    const start = '2026-11-15T15:00:00.000Z';
    expect(startOfClinicDay(new Date('2026-11-15T15:00:01Z'), 'Asia/Tokyo').toISOString()).toBe(
      start,
    );
    expect(startOfClinicDay(new Date('2026-11-16T14:59:59Z'), 'Asia/Tokyo').toISOString()).toBe(
      start,
    );
    expect(startOfClinicDay(new Date('2026-11-16T15:00:00Z'), 'Asia/Tokyo').toISOString()).toBe(
      '2026-11-16T15:00:00.000Z',
    );
  });
});
