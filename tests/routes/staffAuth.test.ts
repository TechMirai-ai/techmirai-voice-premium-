import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { hashPassword } from '../../src/lib/auth.js';
import {
  buildStaffApp,
  MemoryStaffUsers,
  OTHER_CLIENT_ID,
  STAFF_CLIENT_ID,
} from '../helpers/staffFixtures.js';

const LOGIN = '/staff/login';
const LOGOUT = '/staff/logout';
const CHANGE_PASSWORD = '/staff/change-password';
const DASHBOARD = '/staff/dashboard';

async function seededStaffUsers(password = 'a-real-password-123', mustChangePassword = true) {
  const staffUsers = new MemoryStaffUsers();
  const passwordHash = await hashPassword(password);
  const user = staffUsers.seed({
    email: 'owner@example.com',
    passwordHash,
    clientId: STAFF_CLIENT_ID,
    mustChangePassword,
  });
  return { staffUsers, user };
}

describe('GET /staff/login', () => {
  test('renders the login form', async () => {
    const { app } = buildStaffApp();

    const response = await request(app).get(LOGIN);

    expect(response.status).toBe(200);
    expect(response.text).toContain('id="login-form"');
  });
});

describe('POST /staff/login', () => {
  test('correct credentials succeed and redirect to the dashboard', async () => {
    const { staffUsers } = await seededStaffUsers('a-real-password-123', false);
    const { app } = buildStaffApp({ staffUsers });

    const response = await request(app)
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'a-real-password-123' });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(DASHBOARD);
    expect(response.headers['set-cookie']).toBeDefined();
  });

  test('wrong password fails with a generic error', async () => {
    const { staffUsers } = await seededStaffUsers();
    const { app } = buildStaffApp({ staffUsers });

    const response = await request(app)
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'the-wrong-password' });

    expect(response.status).toBe(401);
    expect(response.text).toContain('Incorrect email or password.');
  });

  test('a nonexistent email fails with the exact same response as a wrong password', async () => {
    const { staffUsers } = await seededStaffUsers();
    const { app } = buildStaffApp({ staffUsers });

    const wrongPassword = await request(app)
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'the-wrong-password' });
    const noSuchEmail = await request(app)
      .post(LOGIN)
      .send({ email: 'nobody@example.com', password: 'the-wrong-password' });

    expect(noSuchEmail.status).toBe(wrongPassword.status);
    expect(noSuchEmail.text).toBe(wrongPassword.text);
  });

  test('rate limiting kicks in after repeated failures', async () => {
    const { staffUsers } = await seededStaffUsers();
    const { app } = buildStaffApp({ staffUsers });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await request(app)
        .post(LOGIN)
        .send({ email: 'owner@example.com', password: 'wrong' });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('session', () => {
  test('an authenticated request to the dashboard succeeds', async () => {
    const { staffUsers } = await seededStaffUsers('a-real-password-123', false);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent.post(LOGIN).send({ email: 'owner@example.com', password: 'a-real-password-123' });

    const response = await agent.get(DASHBOARD);

    expect(response.status).toBe(200);
  });

  test('an unauthenticated request to the dashboard is redirected to login', async () => {
    const { app } = buildStaffApp();

    const response = await request(app).get(DASHBOARD);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(LOGIN);
  });

  test('a session referencing a deleted account is treated as unauthenticated, not a crash', async () => {
    const { staffUsers, user } = await seededStaffUsers('a-real-password-123', false);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent.post(LOGIN).send({ email: 'owner@example.com', password: 'a-real-password-123' });
    expect((await agent.get(DASHBOARD)).status).toBe(200);

    staffUsers.users.delete(user.id);

    const response = await agent.get(DASHBOARD);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(LOGIN);
  });

  test('logging out actually invalidates the session', async () => {
    const { staffUsers } = await seededStaffUsers('a-real-password-123', false);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent.post(LOGIN).send({ email: 'owner@example.com', password: 'a-real-password-123' });
    expect((await agent.get(DASHBOARD)).status).toBe(200);

    const logoutResponse = await agent.post(LOGOUT);
    expect(logoutResponse.status).toBe(303);
    expect(logoutResponse.headers.location).toBe(LOGIN);

    const afterLogout = await agent.get(DASHBOARD);
    expect(afterLogout.status).toBe(303);
    expect(afterLogout.headers.location).toBe(LOGIN);
  });
});

describe('forced password change (§4.7)', () => {
  test('an account with must_change_password=true cannot reach the dashboard directly', async () => {
    const { staffUsers } = await seededStaffUsers('a-temporary-password-123', true);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'a-temporary-password-123' });

    const response = await agent.get(DASHBOARD);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(CHANGE_PASSWORD);
  });

  test('the change-password flow succeeds with a valid new password, flips the flag, and the dashboard becomes reachable', async () => {
    const { staffUsers, user } = await seededStaffUsers('a-temporary-password-123', true);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'a-temporary-password-123' });

    const changeResponse = await agent.post(CHANGE_PASSWORD).send({
      newPassword: 'a-brand-new-real-password',
      confirmPassword: 'a-brand-new-real-password',
    });
    expect(changeResponse.status).toBe(303);
    expect(changeResponse.headers.location).toBe(DASHBOARD);

    const updated = await staffUsers.findById(user.id);
    expect(updated?.mustChangePassword).toBe(false);

    const dashboardResponse = await agent.get(DASHBOARD);
    expect(dashboardResponse.status).toBe(200);
  });

  test('rejects mismatched or too-short new passwords, and does not flip the flag', async () => {
    const { staffUsers, user } = await seededStaffUsers('a-temporary-password-123', true);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'a-temporary-password-123' });

    const mismatched = await agent
      .post(CHANGE_PASSWORD)
      .send({ newPassword: 'a-brand-new-real-password', confirmPassword: 'does-not-match' });
    expect(mismatched.status).toBe(400);

    const tooShort = await agent
      .post(CHANGE_PASSWORD)
      .send({ newPassword: 'short', confirmPassword: 'short' });
    expect(tooShort.status).toBe(400);

    expect((await staffUsers.findById(user.id))?.mustChangePassword).toBe(true);
  });

  test('a second visit to the change-password page after the flag is already false does not re-force it', async () => {
    const { staffUsers } = await seededStaffUsers('a-real-password-123', false);
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);
    await agent.post(LOGIN).send({ email: 'owner@example.com', password: 'a-real-password-123' });

    const response = await agent.get(CHANGE_PASSWORD);

    expect(response.status).toBe(200);
  });
});

describe('client scoping (F-3 groundwork)', () => {
  test('a staff account is bound to its own client_id, unaffected by another client existing', async () => {
    const staffUsers = new MemoryStaffUsers();
    staffUsers.seed({
      email: 'owner@example.com',
      passwordHash: await hashPassword('a-real-password-123'),
      clientId: OTHER_CLIENT_ID,
      mustChangePassword: false,
    });
    const { app } = buildStaffApp({ staffUsers });
    const agent = request.agent(app);

    const login = await agent
      .post(LOGIN)
      .send({ email: 'owner@example.com', password: 'a-real-password-123' });

    expect(login.status).toBe(303);
    expect(login.headers.location).toBe(DASHBOARD);
  });
});
