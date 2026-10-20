/**
 * VP-19: the voice webhooks as the Kanto City Gas assistants would hit them. Uses the REAL
 * state-file assistant resolver on the committed `.vapi-state.kanto-city-gas-demo.json` and the
 * real client.yaml (not a hard-coded sakura resolver), so a mistake in either — an assistant name
 * that doesn't resolve, hours that don't match the booking engine — fails here, not on a live call.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/app.js';
import { StateFileAssistantResolver } from '../../src/vapi/assistantResolver.js';
import {
  AUTH,
  buildVoiceApp,
  CALL_ID,
  healthyDb,
  toolCallsBody,
} from '../helpers/voiceFixtures.js';
import { REPO_ROOT } from '../helpers/clientFixtures.js';
import { MemoryPriorCalls } from '../helpers/priorCallFixtures.js';
import { buildStaffOptions } from '../helpers/staffFixtures.js';

const KANTO_ID = 'kanto-city-gas-demo';
const MONDAY = '2026-10-05';
const SATURDAY = '2026-10-10';
const SUNDAY = '2026-10-04';

const CHECK_AVAILABILITY = '/api/voice/check-availability';
const BOOK_APPOINTMENT = '/api/voice/book-appointment';
const CALLBACK_REQUEST = '/api/voice/callback-request';
const END_OF_CALL_REPORT = '/api/voice/end-of-call-report';

let assistantIds: Record<string, string>;

beforeAll(() => {
  const state = JSON.parse(
    readFileSync(path.join(REPO_ROOT, `.vapi-state.${KANTO_ID}.json`), 'utf8'),
  ) as { assistants: Record<string, string> };
  assistantIds = state.assistants;
});

/** The shared in-memory voice app, but resolving assistants from the real committed state files. */
function buildKantoApp() {
  const base = buildVoiceApp();
  base.services.services = [
    { id: 'kanto-gas-opening', name: { ja: 'ガスの開栓', en: 'Gas opening' }, durationMinutes: 60 },
    { id: 'kanto-gas-closing', name: { ja: 'ガスの閉栓', en: 'Gas closing' }, durationMinutes: 30 },
  ];
  const app = createApp({
    db: healthyDb,
    isProduction: false,
    voice: { ...base.voiceOptions, resolver: new StateFileAssistantResolver() },
    staff: buildStaffOptions(),
    talk: {
      publicKey: 'test-vapi-public-key',
      rateLimitSecret: 'test-talk-rate-limit-secret-0123456789',
      bypassKey: 'test-talk-bypass-key',
      isProduction: false,
      callLogs: new MemoryPriorCalls(),
    },
  });
  return { ...base, app };
}

/** A tool-calls envelope as sent by the given Kanto squad member (`ja`, `en` or `ja-return`). */
function fromMember(member: string, tool: string, args: Record<string, unknown>) {
  const name = `${KANTO_ID}--${member}`;
  return toolCallsBody(tool, args, 'sdk', { assistant: { id: assistantIds[name], name } });
}

describe('Kanto assistants resolve from the committed state file', () => {
  test.each([
    ['ja', 'ja'],
    ['en', 'en'],
    ['ja-return', 'ja'],
  ])('%s member books as client %s language', async (member, language) => {
    const { app, appointments } = buildKantoApp();

    await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(
        fromMember(member, 'book_appointment', {
          serviceId: 'kanto-gas-opening',
          patientName: 'Tanaka',
          date: MONDAY,
          time: '10:30',
        }),
      )
      .expect(200);

    expect(appointments.booked[0]).toMatchObject({ clientId: KANTO_ID, language });
  });

  test('resolves by assistant id alone, as Vapi may omit the name', async () => {
    const { app, appointments } = buildKantoApp();
    const body = toolCallsBody(
      'book_appointment',
      { serviceId: 'kanto-gas-closing', patientName: 'Tanaka', date: MONDAY, time: '11:00' },
      'sdk',
      { assistant: { id: assistantIds[`${KANTO_ID}--en`] ?? '' } },
    );

    await request(app).post(BOOK_APPOINTMENT).set(AUTH).send(body).expect(200);

    expect(appointments.booked[0]).toMatchObject({ clientId: KANTO_ID, language: 'en' });
  });
});

describe('availability follows the Kanto business hours (Mon-Fri 09-18, Sat 09-17, Sun closed)', () => {
  test.each([
    [MONDAY, '17:30', true],
    [MONDAY, '18:00', false],
    [SATURDAY, '16:30', true],
    [SATURDAY, '17:00', false],
    [SATURDAY, '09:00', true],
  ])('%s %s -> available: %s', async (date, time, available) => {
    const { app } = buildKantoApp();

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .set(AUTH)
      .send(fromMember('ja', 'check_availability', { date, time }));

    expect(response.body.results[0].result).toMatch(
      available ? new RegExp(`${time} on ${date} is available`) : /not available/i,
    );
  });

  test('Sunday is closed', async () => {
    const { app } = buildKantoApp();

    const response = await request(app)
      .post(CHECK_AVAILABILITY)
      .set(AUTH)
      .send(fromMember('ja', 'check_availability', { date: SUNDAY, time: '10:00' }));

    // Says "company", not the clinic default — the model reads this and may repeat it to the caller.
    expect(response.body.results[0].result).toMatch(/^The company is closed on /);
  });
});

describe('booking a gas opening / closing', () => {
  test('records the booking against the Kanto client with its prefixed service, no returning-patient flag', async () => {
    const { app, appointments } = buildKantoApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(
        fromMember('en', 'book_appointment', {
          serviceId: 'kanto-gas-opening',
          patientName: 'Tanaka',
          date: MONDAY,
          time: '10:30',
        }),
      );

    expect(response.body.results[0].result).toMatch(/^Booked\. Reservation number: /);
    expect(appointments.booked[0]).toMatchObject({
      clientId: KANTO_ID,
      serviceId: 'kanto-gas-opening',
      serviceName: 'Gas opening',
      isReturningPatient: false,
      appointmentDate: MONDAY,
      appointmentTime: '10:30',
    });
  });

  test("refuses a service id that is not one of this client's (e.g. a clinic service)", async () => {
    const { app, appointments } = buildKantoApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(
        fromMember('ja', 'book_appointment', {
          serviceId: 'general-consultation',
          patientName: 'Tanaka',
          date: MONDAY,
          time: '10:30',
        }),
      );

    expect(response.body.results[0].error).toMatch(/serviceId/);
    expect(appointments.booked).toEqual([]);
  });

  test('refuses a time outside the business hours even if the model skipped check_availability', async () => {
    const { app, appointments } = buildKantoApp();

    const response = await request(app)
      .post(BOOK_APPOINTMENT)
      .set(AUTH)
      .send(
        fromMember('ja', 'book_appointment', {
          serviceId: 'kanto-gas-closing',
          patientName: 'Tanaka',
          date: SATURDAY,
          time: '17:00',
        }),
      );

    expect(response.body.results[0].error).toMatch(/no longer available/i);
    expect(appointments.booked).toEqual([]);
  });
});

describe('the gas-smell report', () => {
  const SAFETY_REASON = 'SAFETY: caller reported possible gas smell/leak';

  test('the flagged callback is saved against the Kanto client, even with no name given', async () => {
    const { app, callbacks } = buildKantoApp();

    await request(app)
      .post(CALLBACK_REQUEST)
      .set(AUTH)
      .send(fromMember('ja', 'request_callback', { callerName: 'Unknown', reason: SAFETY_REASON }))
      .expect(200);

    expect(callbacks.saved[0]).toMatchObject({
      clientId: KANTO_ID,
      callerName: 'Unknown',
      reason: SAFETY_REASON,
    });
  });

  test('the call lands as needs_callback with the safety-flagged summary, under the Kanto client', async () => {
    const { app, callLogs } = buildKantoApp();
    const name = `${KANTO_ID}--ja`;
    const body = {
      message: {
        type: 'end-of-call-report',
        endedReason: 'assistant-ended-call',
        startedAt: '2026-10-12T01:00:00.000Z',
        endedAt: '2026-10-12T01:01:00.000Z',
        call: { id: CALL_ID },
        assistant: { id: assistantIds[name], name },
        artifact: {
          messages: [
            {
              role: 'tool_calls',
              toolCalls: [
                {
                  id: 't1',
                  function: {
                    name: 'request_callback',
                    arguments: JSON.stringify({ callerName: 'Unknown', reason: SAFETY_REASON }),
                  },
                },
              ],
            },
            {
              role: 'tool_call_result',
              toolCallId: 't1',
              name: 'request_callback',
              result: 'saved',
            },
          ],
          structuredOutputs: {
            so1: {
              name: 'outcome',
              result: {
                topic: 'gas-smell',
                resolved: false,
                summary: `${SAFETY_REASON}. Callback requested.`,
              },
            },
          },
        },
      },
    };

    await request(app).post(END_OF_CALL_REPORT).set(AUTH).send(body).expect(200);

    expect(callLogs.recorded[0]).toMatchObject({
      clientId: KANTO_ID,
      status: 'needs_callback',
      topic: 'gas-smell',
    });
    expect(callLogs.recorded[0]?.summary).toMatch(
      /^SAFETY: caller reported possible gas smell\/leak/,
    );
  });
});
