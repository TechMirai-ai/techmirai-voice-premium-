/**
 * The hard, server-side gate in front of a live transfer to staff (VP-24).
 *
 * The prompt tells the model when to transfer, but a caller can talk a model into anything, so
 * every transfer request is re-checked here before the server sends the transfer command. The gate
 * FAILS CLOSED: any doubt (no number configured, a malformed number, a number outside the
 * allowed countries, an unreadable count) is a refusal, and a refusal sends the caller to the
 * callback flow.
 *
 * Pure — no network, no clock, no environment: the caller passes in `now`, the counts and the
 * variable's value, so every rule is unit-tested.
 *
 * Known hole: the platform has no national-holiday calendar, so a holiday is only refused if the
 * client lists it in `transfer.closedDates`.
 */
import { E164 } from '../config/phoneFormats.js';
import type { ClientConfig } from '../config/schema.js';

export type TransferRefusal =
  | 'disabled'
  | 'closed'
  | 'closing_soon'
  | 'closed_date'
  | 'call_already_transferred'
  | 'daily_cap'
  | 'destination_unavailable';

export type TransferDecision =
  { allowed: true; number: string } | { allowed: false; reason: TransferRefusal };

export interface TransferGateInput {
  config: ClientConfig;
  now: Date;
  /** The value of the env var named by `transfer.numberEnv`; `undefined` when it is not set. */
  numberValue: string | undefined;
  /** Transfers already started for this call. */
  callTransfers: number;
  /** Transfers started for this client in the last 24 hours (stored + not yet reported). */
  clientTransfersLast24h: number;
}

type Day = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const WEEKDAY_SHORT: Record<string, Day> = {
  Sun: 'sun',
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
};

interface ClinicClock {
  day: Day | undefined;
  /** `YYYY-MM-DD` in the clinic's timezone. */
  date: string;
  minutesSinceMidnight: number;
}

function clinicClock(now: Date, timeZone: string): ClinicClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: WEEKDAY_SHORT[parts['weekday'] ?? ''],
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    minutesSinceMidnight: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** The staff number, only if it is E.164 and starts with an allowed country code. */
export function usableTransferNumber(
  value: string | undefined,
  allowedCountryCodes: readonly string[],
): string | undefined {
  const number = value?.trim();
  if (!number || !E164.test(number)) return undefined;
  return allowedCountryCodes.some((code) => number.startsWith(code)) ? number : undefined;
}

export function evaluateTransferGate(input: TransferGateInput): TransferDecision {
  const transfer = input.config.transfer;
  if (!transfer?.enabled) return { allowed: false, reason: 'disabled' };

  const hours = input.config.business.hours;
  const clock = clinicClock(input.now, hours.timezone);
  const today = clock.day ? hours.weekly[clock.day] : undefined;
  // An unrecognised weekday or a closed day is a refusal, never a guess.
  if (!today || today === 'closed') return { allowed: false, reason: 'closed' };
  if (transfer.closedDates.includes(clock.date)) return { allowed: false, reason: 'closed_date' };

  const closeAt = minutesOf(today.close);
  if (clock.minutesSinceMidnight < minutesOf(today.open) || clock.minutesSinceMidnight >= closeAt) {
    return { allowed: false, reason: 'closed' };
  }
  if (clock.minutesSinceMidnight >= closeAt - transfer.closingBufferMinutes) {
    return { allowed: false, reason: 'closing_soon' };
  }

  if (input.callTransfers >= 1) return { allowed: false, reason: 'call_already_transferred' };
  if (input.clientTransfersLast24h >= transfer.maxPerDay) {
    return { allowed: false, reason: 'daily_cap' };
  }

  const number = usableTransferNumber(input.numberValue, transfer.allowedCountryCodes);
  if (!number) return { allowed: false, reason: 'destination_unavailable' };

  return { allowed: true, number };
}
