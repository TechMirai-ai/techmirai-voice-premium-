/**
 * The `request_consultation` tool as the voice webhook serves it (TechMirai's own agent).
 * Mocks only: an in-memory store and a recording notifier — no database, no SMS, no LINE.
 */
import request from 'supertest';
import { describe, expect, test } from 'vitest';

import {
  MemoryConsultations,
  RecordingConsultationNotifier,
  TECHMIRAI_ASSISTANT,
  TECHMIRAI_ID,
  techmiraiResolver,
} from '../helpers/consultationFixtures.js';
import { AUTH, buildVoiceApp, toolCallsBody } from '../helpers/voiceFixtures.js';
import {
  MAX_CONTACT_NAME_LENGTH,
  MAX_REASON_LENGTH,
} from '../../src/routes/requestConsultation.js';

const PATH = '/api/voice/request-consultation';
const TOOL = 'request_consultation';
const CALL = 'call-tm-1';

function setup(resolver = techmiraiResolver) {
  const consultations = new MemoryConsultations();
  const notifier = new RecordingConsultationNotifier();
  const { app } = buildVoiceApp({
    consultations,
    consultationNotifier: notifier,
    resolver,
  });
  return { app, consultations, notifier };
}

function body(
  args: Record<string, unknown>,
  callFields: Record<string, unknown> = { customer: { number: '+819012345678' } },
  callId = CALL,
) {
  const envelope = toolCallsBody(TOOL, args, 'sdk', {
    assistant: TECHMIRAI_ASSISTANT,
    callId,
  });
  Object.assign(envelope.message.call, callFields);
  return envelope;
}

const resultOf = (response: request.Response): { result?: string; error?: string } =>
  (response.body as { results: { result?: string; error?: string }[] }).results[0] ?? {};

describe('request_consultation', () => {
  test('a caller_id request saves one row, notifies once, and says a text should arrive', async () => {
    const { app, consultations, notifier } = setup();

    const response = await request(app)
      .post(PATH)
      .set(AUTH)
      .send(body({ contact_name: 'Taro Yamada', phone_source: 'caller_id' }));

    const { result, error } = resultOf(response);
    expect(error).toBeUndefined();
    expect(result).toMatch(/^The consultation request was saved\./);
    expect(result).toMatch(/text message should reach them shortly/);
    expect(consultations.rows).toHaveLength(1);
    expect(consultations.rows[0]).toMatchObject({
      clientId: TECHMIRAI_ID,
      callId: CALL,
      language: 'ja',
      contactName: 'Taro Yamada',
      // Japanese numbers are stored as national digits, the same form the call log uses.
      contactPhone: '09012345678',
      phoneSource: 'caller_id',
      reason: null,
    });
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toMatchObject({ contactPhone: '09012345678', callId: CALL });
  });

  test('the same call twice: one row, one notification, the same good answer', async () => {
    const { app, consultations, notifier } = setup();
    const send = () =>
      request(app)
        .post(PATH)
        .set(AUTH)
        .send(body({ contact_name: 'Taro', phone_source: 'caller_id' }));

    const first = await send();
    const second = await send();

    expect(resultOf(second).result).toBe(resultOf(first).result);
    expect(consultations.rows).toHaveLength(1);
    expect(notifier.calls).toHaveLength(1);
  });

  test('a request with no call id is rejected and nothing is saved', async () => {
    const { app, consultations, notifier } = setup();

    const response = await request(app)
      .post(PATH)
      .set(AUTH)
      .send(body({ contact_name: 'Taro', phone_source: 'caller_id' }, {}, ''));

    expect(response.status).toBe(400);
    expect(consultations.rows).toHaveLength(0);
    expect(notifier.calls).toHaveLength(0);
  });

  test('the model cannot supply the call id, client or caller-ID number', async () => {
    const { app, consultations } = setup();

    await request(app)
      .post(PATH)
      .set(AUTH)
      .send(
        body({
          contact_name: 'Taro',
          phone_source: 'caller_id',
          call_id: 'forged-call',
          client_id: 'sakura-seikotsuin',
          caller_number: '08000000000',
          spoken_phone: '08000000000',
        }),
      );

    expect(consultations.rows).toHaveLength(1);
    expect(consultations.rows[0]).toMatchObject({
      callId: CALL,
      clientId: TECHMIRAI_ID,
      contactPhone: '09012345678',
    });
  });

  describe('spoken numbers', () => {
    test('a spoken number is normalised and stored with phone_source "spoken"', async () => {
      const { app, consultations, notifier } = setup();

      const response = await request(app)
        .post(PATH)
        .set(AUTH)
        .send(
          body(
            {
              contact_name: 'Taro',
              phone_source: 'spoken',
              spoken_phone: '０８０-１１１１-２２２２',
            },
            { customer: { number: '+819012345678' } },
          ),
        );

      expect(resultOf(response).error).toBeUndefined();
      expect(consultations.rows[0]).toMatchObject({
        contactPhone: '08011112222',
        phoneSource: 'spoken',
      });
      expect(notifier.calls).toHaveLength(1);
    });

    test.each(['', '12345', 'not a number', '+81'])(
      'an invalid spoken number (%j) is rejected and nothing is saved',
      async (spoken) => {
        const { app, consultations, notifier } = setup();

        const response = await request(app)
          .post(PATH)
          .set(AUTH)
          .send(body({ contact_name: 'Taro', phone_source: 'spoken', spoken_phone: spoken }));

        expect(resultOf(response).error).toMatch(/not valid, so nothing was saved/);
        expect(consultations.rows).toHaveLength(0);
        expect(notifier.calls).toHaveLength(0);
      },
    );

    test('a missing spoken number is rejected too', async () => {
      const { app, consultations } = setup();

      const response = await request(app)
        .post(PATH)
        .set(AUTH)
        .send(body({ contact_name: 'Taro', phone_source: 'spoken' }));

      expect(resultOf(response).error).toMatch(/nothing was saved/);
      expect(consultations.rows).toHaveLength(0);
    });
  });

  describe('caller ID cases', () => {
    test.each([
      ['withheld (anonymous)', { customer: { number: 'anonymous' } }],
      ['absent', {}],
    ])(
      'caller_id with a %s number: nothing saved, the model is told to ask for one',
      async (_n, call) => {
        const { app, consultations, notifier } = setup();

        const response = await request(app)
          .post(PATH)
          .set(AUTH)
          .send(body({ contact_name: 'Taro', phone_source: 'caller_id' }, call));

        expect(resultOf(response).error).toMatch(/no caller ID.*nothing was saved.*"spoken"/is);
        expect(consultations.rows).toHaveLength(0);
        expect(notifier.calls).toHaveLength(0);
      },
    );

    test('a landline is saved but the result says no text will be sent', async () => {
      const { app, consultations } = setup();

      const response = await request(app)
        .post(PATH)
        .set(AUTH)
        .send(
          body(
            { contact_name: 'Taro', phone_source: 'caller_id' },
            { customer: { number: '+81312345678' } },
          ),
        );

      expect(resultOf(response).result).toMatch(/No text message will be sent/);
      expect(consultations.rows[0]?.contactPhone).toBe('0312345678');
    });

    test('a non-Japanese number is saved as +digits and gets no text', async () => {
      const { app, consultations } = setup();

      const response = await request(app)
        .post(PATH)
        .set(AUTH)
        .send(
          body(
            { contact_name: 'Jo', phone_source: 'caller_id' },
            { customer: { number: '+14155550100' } },
          ),
        );

      expect(resultOf(response).result).toMatch(/No text message will be sent/);
      expect(consultations.rows[0]?.contactPhone).toBe('+14155550100');
    });
  });

  describe('sanitising', () => {
    test('control characters become one clean line and the name is length-limited', async () => {
      const { app, consultations } = setup();
      const longName = `Taro\n【URGENT】 call this\u0000 ${'x'.repeat(500)}`;

      await request(app)
        .post(PATH)
        .set(AUTH)
        .send(
          body({
            contact_name: longName,
            phone_source: 'caller_id',
            reason: `a\r\nb‮c${'y'.repeat(900)}`,
          }),
        );

      const row = consultations.rows[0]!;
      // eslint-disable-next-line no-control-regex
      expect(row.contactName).not.toMatch(/[\u0000-\u001f‮]/);
      expect(Array.from(row.contactName).length).toBeLessThanOrEqual(MAX_CONTACT_NAME_LENGTH);
      expect(row.contactName.startsWith('Taro 【URGENT】 call this')).toBe(true);
      expect(Array.from(row.reason ?? '').length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
      expect(row.reason?.startsWith('a b')).toBe(true);
    });

    test('a name that is nothing but control characters is refused', async () => {
      const { app, consultations } = setup();

      const response = await request(app)
        .post(PATH)
        .set(AUTH)
        .send(body({ contact_name: '\n\t​', phone_source: 'caller_id' }));

      expect(resultOf(response).error).toMatch(/name is missing/);
      expect(consultations.rows).toHaveLength(0);
    });
  });

  describe('clients', () => {
    test('an assistant of a client with no consultation section saves nothing', async () => {
      const kanto = { resolve: () => ({ clientId: 'kanto-city-gas-demo', language: 'ja' }) };
      const { app, consultations, notifier } = setup(kanto);

      const response = await request(app)
        .post(PATH)
        .set(AUTH)
        .send(body({ contact_name: 'Taro', phone_source: 'caller_id' }));

      expect(resultOf(response).error).toMatch(/not available here/);
      expect(consultations.rows).toHaveLength(0);
      expect(notifier.calls).toHaveLength(0);
    });

    test('a TechMirai request never shows in another client’s list, and the reverse', async () => {
      const { app, consultations } = setup();
      await request(app)
        .post(PATH)
        .set(AUTH)
        .send(body({ contact_name: 'Taro', phone_source: 'caller_id' }));
      // The same call id under another client is its own row.
      await consultations.create({
        clientId: 'sakura-seikotsuin',
        callId: CALL,
        language: 'ja',
        contactName: 'Hanako',
        contactPhone: '09099998888',
        phoneSource: 'caller_id',
        reason: null,
      });

      expect((await consultations.listByClient(TECHMIRAI_ID)).map((r) => r.contactName)).toEqual([
        'Taro',
      ]);
      expect(
        (await consultations.listByClient('sakura-seikotsuin')).map((r) => r.contactName),
      ).toEqual(['Hanako']);
      expect(await consultations.listByClient('kanto-city-gas-demo')).toEqual([]);
    });

    test('an unknown assistant saves nothing', async () => {
      const { app, consultations } = setup();
      const envelope = toolCallsBody(
        TOOL,
        { contact_name: 'T', phone_source: 'caller_id' },
        'sdk',
        {
          assistant: { id: 'nobody', name: 'nobody' },
        },
      );

      const response = await request(app).post(PATH).set(AUTH).send(envelope);

      expect(resultOf(response).error).toBeDefined();
      expect(consultations.rows).toHaveLength(0);
    });
  });

  test('the route needs the webhook secret', async () => {
    const { app } = setup();

    const response = await request(app)
      .post(PATH)
      .send(body({ contact_name: 'Taro', phone_source: 'caller_id' }));

    expect(response.status).toBe(401);
  });
});
