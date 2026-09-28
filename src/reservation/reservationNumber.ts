/**
 * Demo reservation-number generation (VP-8 work order §1 decision 7): simple,
 * no real-world uniqueness requirement beyond not colliding within this
 * demo's own data — `appointmentRepository.ts` retries on a unique-index
 * collision, which this format makes rare (1 in a million) but not impossible.
 */
import { randomInt } from 'node:crypto';

const DIGIT_COUNT = 6;
const MAX_EXCLUSIVE = 10 ** DIGIT_COUNT;

/** e.g. "R048213". */
export function generateReservationNumber(): string {
  const digits = randomInt(0, MAX_EXCLUSIVE).toString().padStart(DIGIT_COUNT, '0');
  return `R${digits}`;
}
