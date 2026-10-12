import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import type { RetrySummary } from '../../src/google/archiveService.js';
import { buildVoiceApp, WEBHOOK_SECRET } from '../helpers/voiceFixtures.js';

const PATH = '/api/internal/archive-retry';
const RETRY_SECRET = 'archive-retry-secret-0123456789-abcdef';
const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });

const SUMMARY: RetrySummary = {
  claimed: 2,
  done: 1,
  failed: 1,
  queue: { pending: 1, done: 5, failed: 0 },
};

function appWithRetry() {
  const service = {
    retryPending: vi.fn((_options?: { budgetMs?: number }) => Promise.resolve(SUMMARY)),
  };
  const built = buildVoiceApp({ archiveRetry: { retrySecret: RETRY_SECRET, service } });
  return { ...built, service };
}

describe('the archive retry endpoint', () => {
  test('rejects a request with no credentials', async () => {
    const { app, service } = appWithRetry();
    await request(app).post(PATH).expect(401);
    expect(service.retryPending).not.toHaveBeenCalled();
  });

  test('rejects a wrong secret', async () => {
    const { app, service } = appWithRetry();
    await request(app).post(PATH).set(bearer('nope-nope-nope-nope-nope-nope-nope')).expect(401);
    expect(service.retryPending).not.toHaveBeenCalled();
  });

  test('the Vapi webhook secret does NOT unlock it (separate secrets, separate blast radius)', async () => {
    const { app, service } = appWithRetry();
    await request(app).post(PATH).set(bearer(WEBHOOK_SECRET)).expect(401);
    expect(service.retryPending).not.toHaveBeenCalled();
  });

  test('runs a retry pass for POST with the right secret and returns counts only', async () => {
    const { app, service } = appWithRetry();

    const response = await request(app).post(PATH).set(bearer(RETRY_SECRET)).expect(200);

    expect(service.retryPending).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({ status: 'ok', ...SUMMARY });
  });

  test('also answers GET, which is how Vercel Cron calls it', async () => {
    const { app, service } = appWithRetry();
    await request(app).get(PATH).set(bearer(RETRY_SECRET)).expect(200);
    expect(service.retryPending).toHaveBeenCalledTimes(1);
  });

  test('a retry-run crash is a 500 with no detail leaked', async () => {
    const { app, service } = appWithRetry();
    service.retryPending.mockRejectedValue(new Error('db password is hunter2'));

    const response = await request(app).post(PATH).set(bearer(RETRY_SECRET)).expect(500);

    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  test('does not exist when the archive is not configured', async () => {
    const { app } = buildVoiceApp();
    await request(app).post(PATH).set(bearer(RETRY_SECRET)).expect(404);
  });
});
