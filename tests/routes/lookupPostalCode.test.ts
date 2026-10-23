/** VP-20: POST /api/voice/lookup-postal-code — the tool's endpoint, over the in-memory fixtures. */
import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { AUTH, buildVoiceApp, toolCallsBody } from '../helpers/voiceFixtures.js';

const LOOKUP_POSTAL_CODE = '/api/voice/lookup-postal-code';

describe('POST /api/voice/lookup-postal-code', () => {
  test('returns the area for a postal code, and passes the digits through', async () => {
    const { app, postalCodes } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_POSTAL_CODE)
      .set(AUTH)
      .send(toolCallsBody('lookup_postal_code', { postalCode: '1500002' }));

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toContain('東京都');
    expect(response.body.results[0].result).toContain('渋谷区');
    expect(response.body.results[0].error).toBeUndefined();
    expect(postalCodes.asked).toEqual(['1500002']);
  });

  test.each(['not_found', 'invalid', 'unavailable'] as const)(
    'a %s lookup is answered with HTTP 200 and an error that falls back to the spoken address',
    async (kind) => {
      const { app, postalCodes } = buildVoiceApp();
      postalCodes.result = { kind };

      const response = await request(app)
        .post(LOOKUP_POSTAL_CODE)
        .set(AUTH)
        .send(toolCallsBody('lookup_postal_code', { postalCode: '1500002' }));

      expect(response.status).toBe(200);
      expect(response.body.results[0].error).toContain('full address');
      expect(response.body.results[0].result).toBeUndefined();
    },
  );

  test('a missing postalCode is an error and never reaches the lookup', async () => {
    const { app, postalCodes } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_POSTAL_CODE)
      .set(AUTH)
      .send(toolCallsBody('lookup_postal_code', {}));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toMatch(/postalCode/);
    expect(postalCodes.asked).toEqual([]);
  });

  test('requires the webhook credential', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(LOOKUP_POSTAL_CODE)
      .send(toolCallsBody('lookup_postal_code', { postalCode: '1500002' }));

    expect(response.status).toBe(401);
  });
});
