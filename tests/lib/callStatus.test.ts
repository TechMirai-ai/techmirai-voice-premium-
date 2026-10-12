import { describe, expect, test } from 'vitest';

import { CALL_STATUSES, deriveCallStatus } from '../../src/lib/callStatus.js';

const booked = { name: 'book_appointment', result: 'Booked. Reservation number: R000001.' };
const callback = { name: 'request_callback', result: 'The callback request was saved.' };

describe('deriveCallStatus', () => {
  test('exposes exactly the four fixed statuses', () => {
    expect([...CALL_STATUSES]).toEqual([
      'reservation_made',
      'needs_callback',
      'resolved_by_ai',
      'unresolved',
    ]);
  });

  test('a successful booking is a reservation, even if the model also resolved it', () => {
    expect(deriveCallStatus({ toolResults: [booked], resolved: true })).toBe('reservation_made');
  });

  test('a failed booking does not count as a reservation', () => {
    const failed = { name: 'book_appointment', error: 'That time is taken.' };
    expect(deriveCallStatus({ toolResults: [failed], resolved: false })).toBe('unresolved');
    const failedText = { name: 'book_appointment', result: 'That time was just taken.' };
    expect(deriveCallStatus({ toolResults: [failedText], resolved: false })).toBe('unresolved');
  });

  test('a callback request beats a resolved flag', () => {
    expect(deriveCallStatus({ toolResults: [callback], resolved: true })).toBe('needs_callback');
  });

  test('a booking beats a callback in the same call', () => {
    expect(deriveCallStatus({ toolResults: [callback, booked], resolved: false })).toBe(
      'reservation_made',
    );
  });

  test('neither tool fired and the call resolved → resolved by AI', () => {
    expect(deriveCallStatus({ toolResults: [], resolved: true })).toBe('resolved_by_ai');
  });

  test('neither tool fired and nothing resolved → unresolved', () => {
    expect(deriveCallStatus({ toolResults: [], resolved: false })).toBe('unresolved');
  });

  test('a missing structured output is treated as unresolved, never as resolved', () => {
    expect(deriveCallStatus({ toolResults: [], resolved: undefined })).toBe('unresolved');
  });
});
