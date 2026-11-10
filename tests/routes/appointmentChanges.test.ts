/**
 * VP-25: the find / cancel / reschedule tools as the voice webhooks serve them. The server, not the
 * model, decides who may change what: the caller's number comes from the call only, a booking
 * must belong to that number, a reschedule must pass the same availability check as a booking,
 * and a call may change one booking only.
 */
import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { createApp } from '../../src/app.js';
import type {
  AppointmentChangeNotification,
  BookingNotification,
  BookingNotifier,
} from '../../src/notifications/bookingNotifier.js';
import { SlotTakenError } from '../../src/repositories/appointmentRepository.js';
import type { AssistantResolver } from '../../src/vapi/assistantResolver.js';
import { MemoryPriorCalls } from '../helpers/priorCallFixtures.js';
import { buildStaffOptions } from '../helpers/staffFixtures.js';
import {
  AUTH,
  buildVoiceApp,
  CALL_ID,
  callWithEnteredPhone,
  CLIENT_ID,
  healthyDb,
  toolCallsBody,
} from '../helpers/voiceFixtures.js';

const FIND = '/api/voice/find-my-appointments';
const CANCEL = '/api/voice/cancel-appointment';
const RESCHEDULE = '/api/voice/reschedule-appointment';

/** 2026-11-10 12:00 in Tokyo (a Tuesday). Sakura is open Mon-Fri and Sun 09:00-19:00, closed Saturday. */
const NOW = () => new Date('2026-11-10T03:00:00Z');
const THURSDAY = '2026-11-12';
const FRIDAY = '2026-11-13';
const SATURDAY = '2026-11-14';
const CALLER = '09012345678';
const OTHER_CALLER = '08099998888';
const SOME_UUID = '11111111-1111-4111-8111-111111111111';
/** The network caller ID Vapi reports for CALLER. */
const CALLER_ID_CALL = { customer: { number: '+819012345678' } };

class RecordingNotifier implements BookingNotifier {
  readonly changes: AppointmentChangeNotification[] = [];
  failWith: Error | undefined;

  notifyBooked(_booking: BookingNotification): Promise<void> {
    return Promise.resolve();
  }

  notifyChanged(change: AppointmentChangeNotification): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.changes.push(change);
    return Promise.resolve();
  }
}

function setup() {
  const bookingNotifier = new RecordingNotifier();
  const built = buildVoiceApp({ bookingNotifier, now: NOW });
  return { ...built, bookingNotifier };
}

/** A tool-calls body for a call that came from CALLER (network caller ID unless told otherwise). */
function body(
  tool: string,
  args: Record<string, unknown> = {},
  callFields: Record<string, unknown> = CALLER_ID_CALL,
  callId?: string,
) {
  const envelope = toolCallsBody(tool, args, 'sdk', callId ? { callId } : {});
  Object.assign(envelope.message.call, callFields);
  return envelope;
}

const resultOf = (response: request.Response): { result?: string; error?: string } =>
  (response.body as { results: { result?: string; error?: string }[] }).results[0] ?? {};

describe('find_my_appointments', () => {
  test('lists this caller’s upcoming bookings: id, weekday, date, time, service — nothing personal', async () => {
    const { app, appointments } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });
    appointments.seed({ phone: OTHER_CALLER, date: THURSDAY, time: '11:00' });

    const response = await request(app).post(FIND).set(AUTH).send(body('find_my_appointments'));

    const { result, error } = resultOf(response);
    expect(error).toBeUndefined();
    expect(result).toContain(mine.id);
    expect(result).toContain('Thursday 2026-11-12 at 10:00');
    expect(result).toContain('General Consultation');
    expect(result).toMatch(/1 upcoming appointment/);
    // Never the name or the number, and never another caller's booking.
    expect(result).not.toContain('Hanako');
    expect(result).not.toContain(CALLER);
    expect(result).not.toContain('11:00');
  });

  test('lists several bookings soonest first so the caller can be asked which one', async () => {
    const { app, appointments } = setup();
    appointments.seed({ date: FRIDAY, time: '15:00' });
    appointments.seed({ date: THURSDAY, time: '09:30' });

    const response = await request(app).post(FIND).set(AUTH).send(body('find_my_appointments'));

    const result = resultOf(response).result ?? '';
    expect(result).toMatch(/2 upcoming appointments/);
    expect(result.indexOf('2026-11-12')).toBeLessThan(result.indexOf('2026-11-13'));
  });

  test('says plainly when there is none, so the assistant can offer a callback', async () => {
    const { app, appointments } = setup();
    appointments.seed({ phone: OTHER_CALLER });

    const response = await request(app).post(FIND).set(AUTH).send(body('find_my_appointments'));

    expect(resultOf(response).result).toMatch(/No upcoming appointment/i);
  });

  test('does not list a booking that is cancelled or already in the past', async () => {
    const { app, appointments } = setup();
    appointments.seed({ status: 'cancelled' });
    appointments.seed({ date: '2026-11-10', time: '11:00', serviceName: 'Past visit' });

    const response = await request(app).post(FIND).set(AUTH).send(body('find_my_appointments'));

    expect(resultOf(response).result).toMatch(/No upcoming appointment/i);
  });

  test('a call with no number finds nothing — and never matches the demo placeholder number', async () => {
    const { app, appointments } = setup();
    // Every web-call booking without a number is stored under the placeholder.
    appointments.seed({ phone: '000-0000-0000' });

    const response = await request(app)
      .post(FIND)
      .set(AUTH)
      .send(body('find_my_appointments', {}, {}));

    expect(resultOf(response).result).toMatch(/No upcoming appointment/i);
  });

  test('on a web call it uses the number typed on the demo page (testing-era limitation)', async () => {
    const { app, appointments } = setup();
    appointments.seed();

    const response = await request(app)
      .post(FIND)
      .set(AUTH)
      .send(body('find_my_appointments', {}, callWithEnteredPhone('090-1234-5678')));

    expect(resultOf(response).result).toMatch(/1 upcoming appointment/);
  });

  test('takes no phone number from the model: an argument cannot widen the search', async () => {
    const { app, appointments } = setup();
    appointments.seed({ phone: OTHER_CALLER });

    const response = await request(app)
      .post(FIND)
      .set(AUTH)
      .send(body('find_my_appointments', { phone: OTHER_CALLER }));

    expect(resultOf(response).result).toMatch(/No upcoming appointment/i);
  });

  test('caps the list at five bookings', async () => {
    const { app, appointments } = setup();
    for (const time of ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']) {
      appointments.seed({ date: THURSDAY, time });
    }

    const response = await request(app).post(FIND).set(AUTH).send(body('find_my_appointments'));

    expect(resultOf(response).result).toMatch(/5 upcoming appointments/);
  });

  test('rejects an unauthenticated request', async () => {
    const { app } = setup();

    const response = await request(app).post(FIND).send(body('find_my_appointments'));

    expect(response.status).toBe(401);
  });
});

describe('cancel_appointment', () => {
  test('soft-cancels the caller’s booking, frees the slot and tells staff and the caller', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: mine.id }));

    expect(resultOf(response).result).toMatch(/^Cancelled\./);
    expect(mine.status).toBe('cancelled');
    expect(appointments.rows).toHaveLength(1); // kept, not deleted
    expect((await appointments.listTakenTimes(CLIENT_ID, THURSDAY)).has('10:00')).toBe(false);
    expect(bookingNotifier.changes).toEqual([
      {
        kind: 'cancelled',
        clientId: CLIENT_ID,
        appointmentId: mine.id,
        callId: CALL_ID,
        reservationNumber: mine.reservationNumber,
        language: 'ja',
        patientName: 'Hanako Yamada',
        serviceName: 'General Consultation',
        date: THURSDAY,
        time: '10:00',
        oldDate: THURSDAY,
        oldTime: '10:00',
        callerPhone: CALLER,
      },
    ]);
  });

  test('refuses another caller’s booking, says nothing about whether it exists, and changes nothing', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const theirs = appointments.seed({ phone: OTHER_CALLER });

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: theirs.id }));
    const unknown = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: SOME_UUID }));

    expect(resultOf(response).error).toBeDefined();
    // The same words for "not yours" and "does not exist": nothing to probe with.
    expect(resultOf(response).error).toBe(resultOf(unknown).error);
    expect(theirs.status).toBe('active');
    expect(bookingNotifier.changes).toHaveLength(0);
  });

  test('refuses a call that carries no number', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const row = appointments.seed({ phone: '000-0000-0000' });

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: row.id }, {}));

    expect(resultOf(response).error).toBeDefined();
    expect(row.status).toBe('active');
    expect(bookingNotifier.changes).toHaveLength(0);
  });

  test.each([
    ['a missing id', {}],
    ['an id that is not a UUID', { appointmentId: 'R000001' }],
  ])('rejects %s', async (_label, args) => {
    const { app } = setup();

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', args));

    expect(resultOf(response).error).toMatch(/Invalid or missing/);
  });

  test('refuses an appointment that has already started', async () => {
    const { app, appointments } = setup();
    const past = appointments.seed({ date: '2026-11-10', time: '11:00' });

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: past.id }));

    expect(resultOf(response).error).toBeDefined();
    expect(past.status).toBe('active');
  });

  test('one change per call: a second cancellation in the same call is refused', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const first = appointments.seed({ time: '09:00' });
    const second = appointments.seed({ time: '10:00' });

    await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: first.id }));
    const again = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: second.id }));

    expect(resultOf(again).error).toMatch(/only one change per call/i);
    expect(second.status).toBe('active');
    expect(bookingNotifier.changes).toHaveLength(1);
  });

  test('a different call can cancel the other booking', async () => {
    const { app, appointments } = setup();
    const first = appointments.seed({ time: '09:00' });
    const second = appointments.seed({ time: '10:00' });
    await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: first.id }));

    const later = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: second.id }, CALLER_ID_CALL, 'call-2'));

    expect(resultOf(later).result).toMatch(/^Cancelled\./);
  });

  test('the cancellation stands even when the notifier throws', async () => {
    const { app, appointments, bookingNotifier } = setup();
    bookingNotifier.failWith = new Error('LINE down');
    const mine = appointments.seed();

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: mine.id }));

    expect(resultOf(response).result).toMatch(/^Cancelled\./);
    expect(mine.status).toBe('cancelled');
  });

  test('a database failure becomes the graceful error, with nothing leaked', async () => {
    const { app, appointments } = setup();
    const mine = appointments.seed();
    appointments.failWith = new Error('connection to 10.0.0.5 refused');

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: mine.id }));

    expect(resultOf(response).error).toBeDefined();
    expect(resultOf(response).error).not.toContain('10.0.0.5');
  });
});

describe('reschedule_appointment', () => {
  const args = (appointmentId: string, overrides: Record<string, unknown> = {}) => ({
    appointmentId,
    date: FRIDAY,
    time: '14:30',
    ...overrides,
  });

  test('moves the booking in place and tells staff both the new and the old time', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(mine.id)));

    expect(resultOf(response).result).toMatch(/^Rescheduled\..*2026-11-13.*14:30/);
    expect([mine.date, mine.time, mine.status]).toEqual([FRIDAY, '14:30', 'active']);
    expect(appointments.rows).toHaveLength(1); // no duplicate booking
    expect(bookingNotifier.changes).toEqual([
      expect.objectContaining({
        kind: 'rescheduled',
        appointmentId: mine.id,
        date: FRIDAY,
        time: '14:30',
        oldDate: THURSDAY,
        oldTime: '10:00',
        callerPhone: CALLER,
      }),
    ]);
  });

  test('refuses a time that is taken, with the same "ask check_availability" wording as a booking', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });
    appointments.seed({ phone: OTHER_CALLER, date: FRIDAY, time: '14:30' });

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(mine.id)));

    expect(resultOf(response).error).toMatch(/no longer available.*check_availability/s);
    expect(mine.date).toBe(THURSDAY);
    expect(bookingNotifier.changes).toHaveLength(0);
  });

  test.each([
    ['a closed day (Saturday)', { date: SATURDAY }],
    ['a time outside opening hours (invented)', { time: '03:00' }],
    ['a time that is not on the half-hour grid', { time: '14:10' }],
    ['a time that has already passed', { date: '2026-11-10', time: '09:30' }],
  ])('refuses %s', async (_label, override) => {
    const { app, appointments } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(mine.id, override)));

    expect(resultOf(response).error).toBeDefined();
    expect(mine.date).toBe(THURSDAY);
    expect(mine.time).toBe('10:00');
  });

  test('refuses "moving" a booking to the time it already has', async () => {
    const { app, appointments } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(mine.id, { date: THURSDAY, time: '10:00' })));

    expect(resultOf(response).error).toMatch(/already has that date and time/i);
    expect(appointments.changes).toHaveLength(0);
  });

  test('refuses another caller’s booking and changes nothing', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const theirs = appointments.seed({ phone: OTHER_CALLER, date: THURSDAY, time: '10:00' });

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(theirs.id)));

    expect(resultOf(response).error).toBeDefined();
    expect(theirs.date).toBe(THURSDAY);
    expect(bookingNotifier.changes).toHaveLength(0);
  });

  test('one change per call: a reschedule after a cancel in the same call is refused', async () => {
    const { app, appointments } = setup();
    const first = appointments.seed({ time: '09:00' });
    const second = appointments.seed({ time: '10:00' });
    await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: first.id }));

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(second.id)));

    expect(resultOf(response).error).toMatch(/only one change per call/i);
    expect(second.time).toBe('10:00');
  });

  test('losing a race for the slot at write time is reported as "no longer available"', async () => {
    const { app, appointments } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });
    appointments.reschedule = () => Promise.reject(new SlotTakenError());

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(mine.id)));

    expect(resultOf(response).error).toMatch(/no longer available.*check_availability/s);
  });

  test.each([
    ['a malformed date', { date: '13/11/2026' }],
    ['a malformed time', { time: '2pm' }],
    ['a missing time', { time: undefined }],
  ])('rejects %s', async (_label, override) => {
    const { app, appointments } = setup();
    const mine = appointments.seed();

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(body('reschedule_appointment', args(mine.id, override)));

    expect(resultOf(response).error).toMatch(/Invalid or missing/);
  });
});

describe('a tool call delivered twice', () => {
  test('a repeated cancel repeats the success, not "could not be made", and tells staff once', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });
    const send = () =>
      request(app)
        .post(CANCEL)
        .set(AUTH)
        .send(body('cancel_appointment', { appointmentId: mine.id }));

    await send();
    const again = await send();

    expect(resultOf(again).result).toMatch(/^Cancelled\./);
    expect(resultOf(again).error).toBeUndefined();
    expect(bookingNotifier.changes).toHaveLength(1);
  });

  test('a repeated reschedule repeats the success, not "already has that time"', async () => {
    const { app, appointments, bookingNotifier } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });
    const send = () =>
      request(app)
        .post(RESCHEDULE)
        .set(AUTH)
        .send(
          body('reschedule_appointment', { appointmentId: mine.id, date: FRIDAY, time: '14:30' }),
        );

    await send();
    const again = await send();

    expect(resultOf(again).result).toMatch(/^Rescheduled\./);
    expect(bookingNotifier.changes).toHaveLength(1);
  });

  test('another call cannot use the repeat path to learn about this call’s change', async () => {
    const { app, appointments } = setup();
    const mine = appointments.seed({ date: THURSDAY, time: '10:00' });
    await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: mine.id }));

    const other = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: mine.id }, CALLER_ID_CALL, 'call-other'));

    expect(resultOf(other).error).toBeDefined();
  });
});

describe('argument and timing edges', () => {
  test('refuses an impossible calendar date for a reschedule', async () => {
    const { app, appointments } = setup();
    const mine = appointments.seed();

    const response = await request(app)
      .post(RESCHEDULE)
      .set(AUTH)
      .send(
        body('reschedule_appointment', {
          appointmentId: mine.id,
          date: '2026-02-31',
          time: '10:00',
        }),
      );

    expect(resultOf(response).error).toMatch(/Invalid or missing: date/);
    expect(mine.date).toBe(THURSDAY);
  });

  test('a bad appointment id sends the model back to the lookup, never to the caller', async () => {
    const { app } = setup();

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: 'R000001' }));

    expect(resultOf(response).error).toMatch(/find_my_appointments/);
    expect(resultOf(response).error).toMatch(/do not ask the caller/i);
  });

  test('an appointment that starts exactly now can no longer be cancelled', async () => {
    const { app, appointments } = setup();
    const starting = appointments.seed({ date: '2026-11-10', time: '12:00' });

    const response = await request(app)
      .post(CANCEL)
      .set(AUTH)
      .send(body('cancel_appointment', { appointmentId: starting.id }));

    expect(resultOf(response).error).toBeDefined();
    expect(starting.status).toBe('active');
  });
});

describe('a client that has not opted in', () => {
  const KANTO = 'kanto-city-gas-demo';
  const kantoResolver: AssistantResolver = {
    resolve: () => ({ clientId: KANTO, language: 'ja' }),
  };

  test.each([
    [FIND, 'find_my_appointments', {}],
    [CANCEL, 'cancel_appointment', { appointmentId: SOME_UUID }],
    [
      RESCHEDULE,
      'reschedule_appointment',
      { appointmentId: SOME_UUID, date: FRIDAY, time: '14:30' },
    ],
  ])('%s is refused outright', async (path, tool, toolArgs) => {
    const base = buildVoiceApp({ now: NOW });
    base.appointments.seed({ clientId: KANTO });
    const app = createApp({
      db: healthyDb,
      isProduction: false,
      voice: { ...base.voiceOptions, resolver: kantoResolver },
      staff: buildStaffOptions(),
      talk: {
        publicKey: 'test-vapi-public-key',
        rateLimitSecret: 'test-talk-rate-limit-secret-0123456789',
        bypassKey: 'test-talk-bypass-key',
        isProduction: false,
        callLogs: new MemoryPriorCalls(),
      },
    });

    const response = await request(app).post(path).set(AUTH).send(body(tool, toolArgs));

    expect(resultOf(response).error).toMatch(/not available/i);
  });
});
