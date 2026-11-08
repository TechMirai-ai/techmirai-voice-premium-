import { describe, expect, test } from 'vitest';

import { TransferLedger, UNREPORTED_WINDOW_MS } from '../../src/lib/transferLedger.js';

const T0 = new Date('2026-11-09T01:00:00Z');
const after = (ms: number): Date => new Date(T0.getTime() + ms);

describe('TransferLedger (VP-24)', () => {
  test('remembers a started transfer per call', () => {
    const ledger = new TransferLedger();

    expect(ledger.forCall('call-1')).toBe(0);
    ledger.record('c', 'call-1', T0);

    expect(ledger.forCall('call-1')).toBe(1);
    expect(ledger.forCall('call-2')).toBe(0);
  });

  test('counts transfers across calls until their report is likely stored', () => {
    const ledger = new TransferLedger();
    ledger.record('c', 'call-1', T0);
    ledger.record('c', 'call-2', after(60_000));

    expect(ledger.recentCount('c', after(120_000))).toBe(2);
    expect(ledger.recentCount('c', after(UNREPORTED_WINDOW_MS + 1_000))).toBe(1);
    expect(ledger.recentCount('c', after(UNREPORTED_WINDOW_MS + 61_000))).toBe(0);
  });

  test('the window outlasts a long staff conversation (a call only reaches the log when it ends)', () => {
    const ledger = new TransferLedger();
    ledger.record('c', 'call-1', T0);

    expect(ledger.recentCount('c', after(60 * 60_000))).toBe(1);
  });

  test("one client's transfers never count against another client's quota", () => {
    const ledger = new TransferLedger();
    ledger.record('client-a', 'call-1', T0);
    ledger.record('client-a', 'call-2', T0);
    ledger.record('client-b', 'call-3', T0);

    expect(ledger.recentCount('client-a', T0)).toBe(2);
    expect(ledger.recentCount('client-b', T0)).toBe(1);
    expect(ledger.recentCount('client-c', T0)).toBe(0);
  });

  test('forgets a call once its window has passed', () => {
    const ledger = new TransferLedger();
    ledger.record('c', 'call-1', T0);

    ledger.recentCount('c', after(UNREPORTED_WINDOW_MS + 1));

    expect(ledger.forCall('call-1')).toBe(0);
  });

  test('stays bounded however many calls are recorded', () => {
    const ledger = new TransferLedger();

    for (let index = 0; index < 2_000; index += 1) ledger.record('c', `call-${index}`, T0);

    expect(ledger.recentCount('c', T0)).toBeLessThanOrEqual(500);
    expect(ledger.forCall('call-1999')).toBe(1);
  });
});
