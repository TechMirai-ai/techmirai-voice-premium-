/** VP-23: what the book_appointment tool does about notifications and the caller's number. */
import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { DEMO_PLACEHOLDER_PHONE } from '../../src/lib/demoCallerPhone.js';
import type {
  BookingNotification,
  BookingNotifier,
} from '../../src/notifications/bookingNotifier.js';
import {
  AUTH,
  buildVoiceApp,
  CALL_ID,
  callWithEnteredPhone,
  CLIENT_ID,
  toolCallsBody,
} from '../helpers/voiceFixtures.js';

const BOOK_APPOINTMENT = '/api/voice/book-appointment';
// sakura-seikotsuin is open Mon-Sat 09:00-19:00.
const MONDAY = '2026-10-05';

const bookArgs = {
  serviceId: 'general-consultation',
  date: MONDAY,
  time: '10:00',
  patientName: 'Hanako Yamada',
  isReturningPatient: false,
};

class RecordingNotifier implements BookingNotifier {
  readonly received: BookingNotification[] = [];
  failWith: Error | undefined;

  notifyBooked(booking: BookingNotification): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.received.push(booking);
    return Promise.resolve();
  }
}

function bookingBody(callFields: Record<string, unknown> = {}) {
  const body = toolCallsBody('book_appointment', bookArgs);
  Object.assign(body.message.call, callFields);
  return body;
}

describe('book_appointment → notifications (VP-23)', () => {
  test('tells the notifier about the saved booking', async () => {
    const bookingNotifier = new RecordingNotifier();
    const { app } = buildVoiceApp({ bookingNotifier });

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(bookingBody({ customer: { number: '+819012345678' } }));

    expect(response.body.results[0].result).toMatch(/Reservation number: R\d{6}\./);
    expect(bookingNotifier.received).toEqual([
      {
        clientId: CLIENT_ID,
        appointmentId: 'appt-1',
        // The per-call limit (one SMS + one LINE per call) is keyed on the real Vapi call id.
        callId: CALL_ID,
        reservationNumber: 'R000001',
        language: 'ja',
        patientName: 'Hanako Yamada',
        serviceName: 'General Consultation',
        date: MONDAY,
        time: '10:00',
        callerPhone: '09012345678',
      },
    ]);
  });

  test('saves the network caller ID (call.customer.number) with the booking — F-4', async () => {
    const { app, appointments } = buildVoiceApp();

    await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(bookingBody({ customer: { number: '+81 90-1234-5678' } }))
      .expect(200);

    expect(appointments.booked[0]?.patientPhone).toBe('09012345678');
  });

  test('prefers the network caller ID over a number typed on the demo page', async () => {
    const bookingNotifier = new RecordingNotifier();
    const { app, appointments } = buildVoiceApp({ bookingNotifier });

    await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(
        bookingBody({
          customer: { number: '+819011112222' },
          ...callWithEnteredPhone('08033334444'),
        }),
      )
      .expect(200);

    expect(appointments.booked[0]?.patientPhone).toBe('09011112222');
    expect(bookingNotifier.received[0]?.callerPhone).toBe('09011112222');
  });

  test('on a web call, falls back to the number typed on the demo page', async () => {
    const bookingNotifier = new RecordingNotifier();
    const { app } = buildVoiceApp({ bookingNotifier });

    await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(bookingBody(callWithEnteredPhone('08033334444')))
      .expect(200);

    expect(bookingNotifier.received[0]?.callerPhone).toBe('08033334444');
  });

  test('a call with no number stores the placeholder but gives the notifier no number to text', async () => {
    const bookingNotifier = new RecordingNotifier();
    const { app, appointments } = buildVoiceApp({ bookingNotifier });

    await request(app).post(BOOK_APPOINTMENT).set(AUTH).send(bookingBody()).expect(200);

    expect(appointments.booked[0]?.patientPhone).toBe(DEMO_PLACEHOLDER_PHONE);
    expect(bookingNotifier.received).toHaveLength(1);
    expect(bookingNotifier.received[0]).not.toHaveProperty('callerPhone');
  });

  test('ignores a customer.number that is not a phone number', async () => {
    const bookingNotifier = new RecordingNotifier();
    const { app } = buildVoiceApp({ bookingNotifier });

    await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(bookingBody({ customer: { number: "x'; DROP TABLE appointments;--" } }))
      .expect(200);

    expect(bookingNotifier.received[0]).not.toHaveProperty('callerPhone');
  });

  test('still answers "Booked" when the notifier throws — the booking is already saved', async () => {
    const bookingNotifier = new RecordingNotifier();
    bookingNotifier.failWith = new Error('boom');
    const { app, appointments } = buildVoiceApp({ bookingNotifier });

    const response = await request(app).post(BOOK_APPOINTMENT).set(AUTH).send(bookingBody());

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeUndefined();
    expect(response.body.results[0].result).toMatch(/Booked\. Reservation number: R\d{6}\./);
    expect(appointments.booked).toHaveLength(1);
  });

  test('books normally when no notifier is configured', async () => {
    const { app, appointments } = buildVoiceApp();

    const response = await request(app).post(BOOK_APPOINTMENT).set(AUTH).send(bookingBody());

    expect(response.body.results[0].result).toMatch(/Booked\./);
    expect(appointments.booked).toHaveLength(1);
  });

  test('tells nobody when no booking was made (the time was taken)', async () => {
    const bookingNotifier = new RecordingNotifier();
    const { app, appointments } = buildVoiceApp({ bookingNotifier });
    appointments.taken[MONDAY] = ['10:00'];

    const response = await request(app).post(BOOK_APPOINTMENT).set(AUTH).send(bookingBody());

    expect(response.body.results[0].error).toMatch(/no longer available/);
    expect(bookingNotifier.received).toHaveLength(0);
  });
});
