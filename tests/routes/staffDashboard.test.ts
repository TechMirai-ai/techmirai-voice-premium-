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

describe('GET /staff/dashboard', () => {
  test('lists the logged-in client’s callbacks', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1', callerName: 'Hanako Yamada' }));
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.get(DASHBOARD);

    expect(response.status).toBe(200);
    expect(response.text).toContain('Hanako Yamada');
    expect(response.text).toContain('class="callback-row');
    expect(response.text).toContain('id="callback-cb-1"');
  });

  test('shows an empty state with no callbacks', async () => {
    const { agent } = await buildLoggedInApp(new MemoryCallbackAdmin());

    const response = await agent.get(DASHBOARD);

    expect(response.status).toBe(200);
    expect(response.text).toContain('No callback requests yet.');
  });

  test('never shows another client’s callback', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(
      sampleCallback({ id: 'cb-mine', clientId: STAFF_CLIENT_ID, callerName: 'Hanako Yamada' }),
    );
    callbacks.seed(
      sampleCallback({ id: 'cb-theirs', clientId: OTHER_CLIENT_ID, callerName: 'Someone Else' }),
    );
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.get(DASHBOARD);

    expect(response.text).toContain('Hanako Yamada');
    expect(response.text).not.toContain('Someone Else');
    expect(response.text).not.toContain('cb-theirs');
  });

  test('escapes an HTML-like reason so it renders as inert text, not markup (§3, §6.5)', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(
      sampleCallback({ id: 'cb-1', reason: '<script>alert(document.cookie)</script>' }),
    );
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.get(DASHBOARD);

    expect(response.text).not.toContain('<script>alert(document.cookie)</script>');
    expect(response.text).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
    // A real assertion on the rendered output: no executable <script> tag
    // exists anywhere in the page — this page ships no inline script at all.
    expect(response.text.match(/<script\b/g)).toBeNull();
  });

  test('escapes an HTML-like caller name too', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1', callerName: '<img src=x onerror=alert(1)>' }));
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.get(DASHBOARD);

    expect(response.text).not.toContain('<img src=x onerror=alert(1)>');
    expect(response.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('POST /staff/dashboard/callbacks/:id/handled', () => {
  test('updates status and handled_at correctly', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1', status: 'pending' }));
    const { agent } = await buildLoggedInApp(callbacks);

    const response = await agent.post(`${DASHBOARD}/callbacks/cb-1/handled`);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(DASHBOARD);
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
