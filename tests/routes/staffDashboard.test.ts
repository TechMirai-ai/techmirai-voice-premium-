import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { hashPassword } from '../../src/lib/auth.js';
import {
  buildStaffApp,
  MemoryCallbackAdmin,
  MemoryStaffUsers,
  OTHER_CLIENT_ID,
  sampleCallback,
  STAFF_CLIENT_ID,
} from '../helpers/staffFixtures.js';

const LOGIN = '/staff/login';
const DASHBOARD = '/staff/dashboard';

async function loggedInAgent(app: ReturnType<typeof buildStaffApp>['app']) {
  const agent = request.agent(app);
  await agent.post(LOGIN).send({ email: 'owner@example.com', password: 'a-real-password-123' });
  return agent;
}

async function buildLoggedInApp(callbacks: MemoryCallbackAdmin) {
  const staffUsers = new MemoryStaffUsers();
  staffUsers.seed({
    email: 'owner@example.com',
    passwordHash: await hashPassword('a-real-password-123'),
    clientId: STAFF_CLIENT_ID,
    mustChangePassword: false,
  });
  const { app } = buildStaffApp({ staffUsers, callbacks });
  const agent = await loggedInAgent(app);
  return { app, agent };
}

// The Callbacks page is gone (VP-14): its list/escaping/placeholder-phone behaviour is covered by
// the "Needs Callback filter" tests in staffCalls.test.ts. Only the legacy URL and the POST remain.
describe('GET /staff/dashboard (retired Callbacks page)', () => {
  test('redirects to the call list so old bookmarks and the post-login landing keep working', async () => {
    const { agent } = await buildLoggedInApp(new MemoryCallbackAdmin());

    const response = await agent.get(DASHBOARD);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/staff/calls');
  });
});

describe('POST /staff/dashboard/callbacks/:id/handled', () => {
  test('updates status and handled_at correctly', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1', status: 'pending' }));
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.post(`${DASHBOARD}/callbacks/cb-1/handled`);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/staff/calls?status=needs_callback');
    const row = callbacks.rows.get('cb-1');
    expect(row?.status).toBe('handled');
    expect(row?.handledAt).toBeInstanceOf(Date);
  });

  test('a request for a callback belonging to a different client is rejected', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(
      sampleCallback({ id: 'cb-theirs', clientId: OTHER_CLIENT_ID, status: 'pending' }),
    );
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.post(`${DASHBOARD}/callbacks/cb-theirs/handled`);

    expect(response.status).toBe(404);
    expect(callbacks.rows.get('cb-theirs')?.status).toBe('pending');
  });

  test('an unknown id is rejected', async () => {
    const { agent } = await buildLoggedInApp(new MemoryCallbackAdmin());

    const response = await agent.post(`${DASHBOARD}/callbacks/no-such-id/handled`);

    expect(response.status).toBe(404);
  });

  test('requires authentication', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1' }));
    const { app } = buildStaffApp({ callbacks });

    const response = await request(app).post(`${DASHBOARD}/callbacks/cb-1/handled`);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(LOGIN);
    expect(callbacks.rows.get('cb-1')?.status).toBe('pending');
  });
});
