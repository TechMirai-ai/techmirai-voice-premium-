/**
 * Pure availability-generation logic for the demo reservation feature (VP-8).
 * Algorithmic, not a real capacity-tracked slots system (work order §1
 * decision 4): a time is available if it falls within the clinic's fixed
 * weekly hours for that date and is not already taken. No network, no
 * filesystem, no `Date.now()` — every input is explicit, like render.ts.
 */
import type { ClientConfig } from '../config/schema.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(value: string): boolean {
  return DATE_PATTERN.test(value);
}

export function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** Index matches JS `Date.getUTCDay()` (0 = Sunday), for `weeklyHoursSchema`'s day keys. */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

export class InvalidReservationDateError extends Error {
  constructor(date: string) {
    super(`not a valid YYYY-MM-DD date: "${date}"`);
    this.name = 'InvalidReservationDateError';
  }
}

/**
 * The weekday key for a YYYY-MM-DD date, treated as a plain calendar date —
 * deliberately computed in UTC, not the clinic's timezone, since only the
 * day-of-week (not the exact instant) matters for picking which day's hours
 * apply.
 */
function dayKeyOf(date: string): DayKey {
  if (!isValidDate(date)) throw new InvalidReservationDateError(date);
  const [year, month, day] = date.split('-').map(Number);
  const jsDate = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  const key = DAY_KEYS[jsDate.getUTCDay()];
  if (!key) throw new InvalidReservationDateError(date);
  return key;
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function timeOf(minutes: number): string {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (minutes % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

const SLOT_INTERVAL_MINUTES = 30;
const MAX_ALTERNATIVES = 2;

/** Every bookable slot start time for one day, in order, from the clinic's fixed weekly hours. */
export function candidateSlots(config: ClientConfig, date: string): string[] {
  const day = dayKeyOf(date);
  const hours = config.business.hours.weekly[day];
  if (hours === 'closed') return [];

  const start = minutesOf(hours.open);
  const end = minutesOf(hours.close);
  const slots: string[] = [];
  for (let minute = start; minute + SLOT_INTERVAL_MINUTES <= end; minute += SLOT_INTERVAL_MINUTES) {
    slots.push(timeOf(minute));
  }
  return slots;
}

export interface AvailabilityResult {
  requestedAvailable: boolean;
  /** Up to two other open times that day — empty when the requested time is available, or the clinic is closed. */
  alternatives: string[];
  /** The clinic is closed on that date's weekday — no time, requested or alternative, can be offered. */
  closed: boolean;
}

/**
 * @param takenTimes Every time already spoken for that date (fake pre-seeded
 *   "booked" slots plus real demo appointments) — fetched by the caller, kept
 *   out of this function so it stays pure and independently testable.
 */
export function checkAvailability(
  config: ClientConfig,
  date: string,
  requestedTime: string,
  takenTimes: ReadonlySet<string>,
): AvailabilityResult {
  const slots = candidateSlots(config, date);
  if (slots.length === 0) {
    return { requestedAvailable: false, alternatives: [], closed: true };
  }

  const requestedAvailable = slots.includes(requestedTime) && !takenTimes.has(requestedTime);
  if (requestedAvailable) {
    return { requestedAvailable: true, alternatives: [], closed: false };
  }

  const alternatives = slots.filter((slot) => !takenTimes.has(slot)).slice(0, MAX_ALTERNATIVES);
  return { requestedAvailable: false, alternatives, closed: false };
}
