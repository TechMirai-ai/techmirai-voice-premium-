import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { DEMO_PLACEHOLDER_PHONE } from '../../src/lib/demoCallerPhone.js';

import {
  AUTH,
  buildVoiceApp,
  CALL_ID,
  CLIENT_ID,
  toolCallsBody,
} from '../helpers/voiceFixtures.js';

const CHECK_AVAILABILITY = '/api/voice/check-availability';
const LOOKUP_PATIENT = '/api/voice/lookup-patient';
const BOOK_APPOINTMENT = '/api/voice/book-appointment';

// sakura-seikotsuin (via the real assistant resolver fixture) is open Mon-Sat 09:00-19:00, closed Sunday.
const MONDAY = '2026-10-05';
const SUNDAY = '2026-10-04';

describe('POST /api/voice/check-availability', () => {
  test('reports an open time as available', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .set(AUTH)
      .send(toolCallsBody('check_availability', { date: MONDAY, time: '10:00' }));

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toMatch(/available/i);
    expect(response.body.results[0].error).toBeUndefined();
  });

  test('offers alternatives for a taken time', async () => {
    const { app, appointments } = buildVoiceApp();
    appointments.taken[MONDAY] = ['10:00'];

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .set(AUTH)
      .send(toolCallsBody('check_availability', { date: MONDAY, time: '10:00' }));

    expect(response.body.results[0].result).toMatch(/not available/i);
    expect(response.body.results[0].result).toContain('Available instead');
  });

  test('reports the clinic as closed on a day it is closed', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .set(AUTH)
      .send(toolCallsBody('check_availability', { date: SUNDAY, time: '10:00' }));

    expect(response.body.results[0].result).toMatch(/closed/i);
  });

  test.each([
    ['a malformed date', { date: '10/05/2026', time: '10:00' }],
    ['a malformed time', { date: MONDAY, time: '10am' }],
    ['a missing time', { date: MONDAY }],
  ])('rejects %s with an error result', async (_label, args) => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .set(AUTH)
      .send(toolCallsBody('check_availability', args));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
  });

  test('rejects an unauthenticated request', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .send(toolCallsBody('check_availability', { date: MONDAY, time: '10:00' }));

    expect(response.status).toBe(401);
  });
});

describe('POST /api/voice/lookup-patient', () => {
  test('finds a known patient by the confirmed full name', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_PATIENT)
      .set(AUTH)
      .send(toolCallsBody('lookup_patient', { callerName: 'ヤマダ タロウ' }));

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toContain('ヤマダ タロウ');
  });

  test('also matches a short name, ignoring case and spacing', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_PATIENT)
      .set(AUTH)
      .send(toolCallsBody('lookup_patient', { callerName: 'タロウ' }));

    expect(response.body.results[0].result).toContain('ヤマダ タロウ');
  });

  test('reports no record for an unknown name', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_PATIENT)
      .set(AUTH)
      .send(toolCallsBody('lookup_patient', { callerName: 'スズキ' }));

    expect(response.body.results[0].result).toMatch(/no patient record/i);
  });

  test('rejects a missing name', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_PATIENT)
      .set(AUTH)
      .send(toolCallsBody('lookup_patient', {}));

    expect(response.body.results[0].error).toBeDefined();
  });
});

describe('POST /api/voice/book-appointment', () => {
  const firstVisitArgs = {
    serviceId: 'general-consultation',
    date: MONDAY,
    time: '10:00',
    patientName: 'Taro',
    isReturningPatient: false,
  };

  test('books an available slot and returns a reservation number', async () => {
    const { app, appointments } = buildVoiceApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(toolCallsBody('book_appointment', firstVisitArgs));

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toMatch(/Reservation number: R\d{6}\./);
    expect(appointments.booked).toEqual([
      expect.objectContaining({
        clientId: CLIENT_ID,
        callId: CALL_ID,
        serviceId: 'general-consultation',
        serviceName: 'General Consultation',
        patientName: 'Taro',
        // No spoken number: the route stores the demo placeholder (src/lib/demoCallerPhone.ts).
        patientPhone: DEMO_PLACEHOLDER_PHONE,
        appointmentDate: MONDAY,
        appointmentTime: '10:00',
      }),
    ]);
  });

  test('books a returning patient with no service', async () => {
    const { app, appointments } = buildVoiceApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(
        toolCallsBody('book_appointment', {
          date: MONDAY,
          time: '11:00',
          patientName: 'ヤマダ タロウ',
          isReturningPatient: true,
        }),
      );

    expect(response.status).toBe(200);
    expect(appointments.booked[0]).toMatchObject({ serviceId: null, isReturningPatient: true });
  });

  test('refuses to book a time that is already taken', async () => {
    const { app, appointments } = buildVoiceApp();
    appointments.taken[MONDAY] = ['10:00'];

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(toolCallsBody('book_appointment', firstVisitArgs));

    expect(response.body.results[0].error).toMatch(/no longer available/i);
    expect(appointments.booked).toEqual([]);
  });

  test('rejects an unknown serviceId', async () => {
    const { app, appointments } = buildVoiceApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(toolCallsBody('book_appointment', { ...firstVisitArgs, serviceId: 'no-such-service' }));

    expect(response.body.results[0].error).toContain('serviceId');
    expect(appointments.booked).toEqual([]);
  });

  test.each([
    ['a blank name', { ...firstVisitArgs, patientName: '   ' }, 'patientName'],
    ['a missing name', { ...firstVisitArgs, patientName: undefined }, 'patientName'],
  ])('answers %s with an error result and saves nothing', async (_n, args, field) => {
    const { app, appointments } = buildVoiceApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(toolCallsBody('book_appointment', args));

    expect(response.body.results[0].error).toContain(field);
    expect(appointments.booked).toEqual([]);
  });

  test('a database failure still answers 200 with an error result, never a raw 500', async () => {
    const { app, appointments } = buildVoiceApp();
    appointments.failWith = new Error('connection terminated unexpectedly');

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(toolCallsBody('book_appointment', firstVisitArgs));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
  });
});
