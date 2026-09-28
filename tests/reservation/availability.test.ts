import { describe, expect, test } from 'vitest';

import { buildMinimalConfig } from '../helpers/vapiFixtures.js';
import {
  candidateSlots,
  checkAvailability,
  InvalidReservationDateError,
  isValidDate,
  isValidTime,
} from '../../src/reservation/availability.js';

// buildMinimalConfig's clinic is open Mon-Fri 09:00-17:00, closed Sat/Sun (UTC).
const CONFIG = buildMinimalConfig();
const MONDAY = '2026-10-05'; // a real Monday
const SATURDAY = '2026-10-10'; // a real Saturday

describe('isValidDate / isValidTime', () => {
  test.each([
    ['2026-10-05', true],
    ['2026-1-5', false],
    ['not-a-date', false],
    ['', false],
  ])('isValidDate(%s) -> %s', (value, expected) => {
    expect(isValidDate(value)).toBe(expected);
  });

  test.each([
    ['09:00', true],
    ['23:59', true],
    ['24:00', false],
    ['9:00', false],
    ['09:60', false],
  ])('isValidTime(%s) -> %s', (value, expected) => {
    expect(isValidTime(value)).toBe(expected);
  });
});

describe('candidateSlots', () => {
  test("lists every 30-minute slot within the day's open hours", () => {
    expect(candidateSlots(CONFIG, MONDAY)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
    ]);
  });

  test('is empty on a day the clinic is closed', () => {
    expect(candidateSlots(CONFIG, SATURDAY)).toEqual([]);
  });

  test('throws for a malformed date', () => {
    expect(() => candidateSlots(CONFIG, 'not-a-date')).toThrow(InvalidReservationDateError);
  });
});

describe('checkAvailability', () => {
  test('the requested time is available when not taken', () => {
    const result = checkAvailability(CONFIG, MONDAY, '10:00', new Set());
    expect(result).toEqual({ requestedAvailable: true, alternatives: [], closed: false });
  });

  test('offers up to two alternatives when the requested time is taken', () => {
    const result = checkAvailability(CONFIG, MONDAY, '10:00', new Set(['10:00']));
    expect(result.requestedAvailable).toBe(false);
    expect(result.closed).toBe(false);
    expect(result.alternatives).toEqual(['09:00', '09:30']);
  });

  test('never offers an alternative that is itself taken', () => {
    const result = checkAvailability(CONFIG, MONDAY, '10:00', new Set(['09:00', '09:30', '10:00']));
    expect(result.alternatives).toEqual(['10:30', '11:00']);
  });

  test('a request for a time outside opening hours is unavailable, with real alternatives offered', () => {
    const result = checkAvailability(CONFIG, MONDAY, '20:00', new Set());
    expect(result.requestedAvailable).toBe(false);
    expect(result.closed).toBe(false);
    expect(result.alternatives).toEqual(['09:00', '09:30']);
  });

  test('reports the clinic as closed on a day with no hours, with no alternatives', () => {
    const result = checkAvailability(CONFIG, SATURDAY, '10:00', new Set());
    expect(result).toEqual({ requestedAvailable: false, alternatives: [], closed: true });
  });
});
