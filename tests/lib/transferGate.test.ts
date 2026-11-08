/**
 * VP-24: the hard server-side gate in front of a live transfer. Every rule is tested at its
 * boundary, and every doubt must be a refusal (fail closed).
 */
import { describe, expect, test } from 'vitest';

import { parseClientConfig, type ClientConfig } from '../../src/config/schema.js';
import {
  evaluateTransferGate,
  usableTransferNumber,
  type TransferGateInput,
} from '../../src/lib/transferGate.js';
import { readSakuraDocument, SAKURA_ID, withChanges } from '../helpers/clientFixtures.js';

const sakuraDocument = readSakuraDocument();
const STAFF = '+81312345678';

const configWith = (mutate: (draft: Record<string, any>) => void = () => {}): ClientConfig =>
  parseClientConfig(withChanges(sakuraDocument, mutate), SAKURA_ID).config;

/** JST (UTC+9, no daylight saving) wall-clock time as an instant. 2026-11-09 is a Monday. */
const jst = (day: string, time: string): Date => new Date(`${day}T${time}:00+09:00`);

const MONDAY = '2026-11-09';
const SUNDAY = '2026-11-08';

function gate(overrides: Partial<TransferGateInput> = {}) {
  return evaluateTransferGate({
    config: configWith(),
    now: jst(MONDAY, '10:00'),
    numberValue: STAFF,
    callTransfers: 0,
    clientTransfersLast24h: 0,
    ...overrides,
  });
}

describe('evaluateTransferGate', () => {
  test('allows a transfer during opening hours and hands back the number from the env value', () => {
    expect(gate()).toEqual({ allowed: true, number: STAFF });
  });

  describe('opening hours (Sakura: Mon–Sat 09:00–19:00, 10 minute closing buffer)', () => {
    test.each([
      ['08:59', 'closed'],
      ['09:00', undefined],
      ['18:49', undefined],
      ['18:50', 'closing_soon'],
      ['18:59', 'closing_soon'],
      ['19:00', 'closed'],
      ['23:30', 'closed'],
      ['00:05', 'closed'],
    ])('Monday %s → %s', (time, refusal) => {
      const decision = gate({ now: jst(MONDAY, time) });

      if (refusal === undefined) expect(decision.allowed).toBe(true);
      else expect(decision).toEqual({ allowed: false, reason: refusal });
    });

    test('a closed day (Sunday) is refused all day', () => {
      expect(gate({ now: jst(SUNDAY, '12:00') })).toEqual({ allowed: false, reason: 'closed' });
    });

    test('the clinic timezone decides, not UTC: Monday 05:00 JST is Sunday 20:00 UTC', () => {
      expect(gate({ now: new Date('2026-11-08T20:00:00Z') })).toEqual({
        allowed: false,
        reason: 'closed',
      });
      expect(gate({ now: new Date('2026-11-09T00:30:00Z') }).allowed).toBe(true);
    });

    test('the closing buffer comes from the client config', () => {
      const noBuffer = configWith((draft) => {
        draft['transfer'].closingBufferMinutes = 0;
      });
      const bigBuffer = configWith((draft) => {
        draft['transfer'].closingBufferMinutes = 60;
      });

      expect(gate({ config: noBuffer, now: jst(MONDAY, '18:59') }).allowed).toBe(true);
      expect(gate({ config: noBuffer, now: jst(MONDAY, '19:00') }).allowed).toBe(false);
      expect(gate({ config: bigBuffer, now: jst(MONDAY, '17:59') }).allowed).toBe(true);
      expect(gate({ config: bigBuffer, now: jst(MONDAY, '18:00') })).toEqual({
        allowed: false,
        reason: 'closing_soon',
      });
    });

    test('the hours come from business.hours, not a second definition', () => {
      const shorter = configWith((draft) => {
        draft['business'].hours.weekly.mon = { open: '10:00', close: '12:00' };
      });

      expect(gate({ config: shorter, now: jst(MONDAY, '09:30') }).allowed).toBe(false);
      expect(gate({ config: shorter, now: jst(MONDAY, '10:30') }).allowed).toBe(true);
      expect(gate({ config: shorter, now: jst(MONDAY, '11:55') }).allowed).toBe(false);
    });

    test('closedDates refuse a day that is otherwise open (holidays, clinic closures)', () => {
      const config = configWith((draft) => {
        draft['transfer'].closedDates = [MONDAY];
      });

      expect(gate({ config })).toEqual({ allowed: false, reason: 'closed_date' });
      expect(gate({ config, now: jst('2026-11-10', '10:00') }).allowed).toBe(true);
    });
  });

  describe('volume', () => {
    test('a second transfer on the same call is refused', () => {
      expect(gate({ callTransfers: 1 })).toEqual({
        allowed: false,
        reason: 'call_already_transferred',
      });
    });

    test('the daily cap (Sakura: 10) refuses exactly at the limit', () => {
      expect(gate({ clientTransfersLast24h: 9 }).allowed).toBe(true);
      expect(gate({ clientTransfersLast24h: 10 })).toEqual({ allowed: false, reason: 'daily_cap' });
      expect(gate({ clientTransfersLast24h: 500 })).toEqual({
        allowed: false,
        reason: 'daily_cap',
      });
    });

    test('the cap comes from the client config (default 20)', () => {
      const config = configWith((draft) => {
        delete draft['transfer'].maxPerDay;
      });

      expect(gate({ config, clientTransfersLast24h: 19 }).allowed).toBe(true);
      expect(gate({ config, clientTransfersLast24h: 20 }).allowed).toBe(false);
    });
  });

  describe('the destination (fails closed)', () => {
    test.each([
      ['unset', undefined],
      ['empty', ''],
      ['blank', '   '],
      ['not E.164', '03-1234-5678'],
      ['no plus', '81312345678'],
      ['letters', '+81abc'],
      ['outside the allowed countries', '+14155550100'],
      ['premium-rate style', '+88212345678'],
    ])('%s → refused', (_label, value) => {
      expect(gate({ numberValue: value })).toEqual({
        allowed: false,
        reason: 'destination_unavailable',
      });
    });

    test('surrounding whitespace in the env value is tolerated', () => {
      expect(gate({ numberValue: `  ${STAFF}\n` })).toEqual({ allowed: true, number: STAFF });
    });

    test('a country is allowed only when the client opts it in', () => {
      const config = configWith((draft) => {
        draft['transfer'].allowedCountryCodes = ['+81', '+1'];
      });

      expect(gate({ config, numberValue: '+14155550100' })).toEqual({
        allowed: true,
        number: '+14155550100',
      });
    });
  });

  test('a switched-off or absent transfer block is refused', () => {
    const off = configWith((draft) => {
      draft['transfer'].enabled = false;
    });
    const absent = configWith((draft) => {
      delete draft['transfer'];
    });

    expect(gate({ config: off })).toEqual({ allowed: false, reason: 'disabled' });
    expect(gate({ config: absent })).toEqual({ allowed: false, reason: 'disabled' });
  });
});

describe('usableTransferNumber', () => {
  test('accepts E.164 inside an allowed country and rejects everything else', () => {
    expect(usableTransferNumber(STAFF, ['+81'])).toBe(STAFF);
    expect(usableTransferNumber(STAFF, ['+1'])).toBeUndefined();
    expect(usableTransferNumber(undefined, ['+81'])).toBeUndefined();
  });
});
