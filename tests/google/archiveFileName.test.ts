import { describe, expect, test } from 'vitest';

import { archiveBaseName, withCollisionSuffix } from '../../src/google/archiveFileName.js';

const TOKYO = 'Asia/Tokyo';
// 15:42 UTC is already 00:42 the next morning in Tokyo (UTC+9, no daylight saving).
const START = new Date('2026-10-13T15:42:07.000Z');

describe('archiveBaseName', () => {
  test('is <date>-<time>-<topic> in the clinic’s local time, to the minute', () => {
    expect(archiveBaseName(START, 'reservation', TOKYO)).toBe('2026-10-14-0042-reservation');
  });

  test('the date rolls over with local time, not UTC', () => {
    const lateEvening = new Date('2026-10-13T14:59:00.000Z'); // 23:59 in Tokyo, same day
    expect(archiveBaseName(lateEvening, 'parking', TOKYO)).toBe('2026-10-13-2359-parking');
  });

  test('midnight is 0000, never 2400', () => {
    const midnight = new Date('2026-10-13T15:00:00.000Z');
    expect(archiveBaseName(midnight, 'parking', TOKYO)).toBe('2026-10-14-0000-parking');
  });

  test('another clinic timezone is honoured (names follow client.yaml, not Japan)', () => {
    expect(archiveBaseName(START, 'parking', 'UTC')).toBe('2026-10-13-1542-parking');
    expect(archiveBaseName(START, 'parking', 'America/New_York')).toBe('2026-10-13-1142-parking');
  });

  test('calls in the same minute share a base name (collisions are resolved by the store)', () => {
    const later = new Date('2026-10-13T15:42:59.000Z');
    expect(archiveBaseName(later, 'reservation', TOKYO)).toBe(
      archiveBaseName(START, 'reservation', TOKYO),
    );
  });

  test('a different minute or topic gives a different name', () => {
    const nextMinute = new Date('2026-10-13T15:43:00.000Z');
    expect(archiveBaseName(nextMinute, 'reservation', TOKYO)).not.toBe(
      archiveBaseName(START, 'reservation', TOKYO),
    );
    expect(archiveBaseName(START, 'parking', TOKYO)).toBe('2026-10-14-0042-parking');
  });

  test('a missing topic is named no-topic rather than leaving a dangling dash', () => {
    expect(archiveBaseName(START, undefined, TOKYO)).toBe('2026-10-14-0042-no-topic');
    expect(archiveBaseName(START, '', TOKYO)).toBe('2026-10-14-0042-no-topic');
  });

  test('a stray topic can never put path characters or spaces in a file name', () => {
    expect(archiveBaseName(START, '../Etc/Passwd & more!', TOKYO)).toBe(
      '2026-10-14-0042-etc-passwd-more',
    );
  });

  test('a topic with no latin letters falls back to no-topic', () => {
    expect(archiveBaseName(START, '予約', TOKYO)).toBe('2026-10-14-0042-no-topic');
  });

  test('an over-long topic is cut, without leaving a trailing dash', () => {
    const name = archiveBaseName(START, `${'a'.repeat(39)}-bbbbbb`, TOKYO);
    expect(name).toBe(`2026-10-14-0042-${'a'.repeat(39)}`);
  });

  test('an unusable start time does not throw', () => {
    expect(archiveBaseName(new Date('nope'), 'parking', 'UTC')).toBe('1970-01-01-0000-parking');
    expect(archiveBaseName(undefined, 'parking', 'UTC')).toBe('1970-01-01-0000-parking');
  });
});

describe('withCollisionSuffix', () => {
  test('the first attempt is the plain name; later attempts add -2, -3…', () => {
    const base = '2026-10-14-0042-reservation';
    expect(withCollisionSuffix(base, 1)).toBe(base);
    expect(withCollisionSuffix(base, 2)).toBe(`${base}-2`);
    expect(withCollisionSuffix(base, 3)).toBe(`${base}-3`);
  });
});
