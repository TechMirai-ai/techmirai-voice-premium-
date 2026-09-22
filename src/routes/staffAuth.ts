/**
 * Staff login, logout, and the forced "set a new password" flow (VP-5 §4.7).
 * Plain HTML forms — no client-side JS needed, matching the project's
 * no-framework pattern (src/vapi/testPage.ts is the existing precedent).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';

import { hashPassword, newPasswordSchema, verifyPassword } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { staffLoginRateLimit, type RateLimitOptions } from '../middleware/rateLimit.js';
import { requireStaffAuth, staffUserFromLocals } from '../middleware/staffSession.js';
import type { StaffUserRepository } from '../repositories/staffUserRepository.js';
import { SESSION_COOKIE_NAME } from './staffRouter.js';
import { STAFF_DASHBOARD_PATH, STAFF_LOGIN_PATH } from './staffPaths.js';
import { renderChangePasswordPage, renderLoginPage } from './staffViews.js';

export interface StaffAuthRouteDeps {
  staffUsers: StaffUserRepository;
  loginRateLimit?: RateLimitOptions;
}

const loginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  newPassword: newPasswordSchema,
  confirmPassword: z.string(),
});

const GENERIC_LOGIN_ERROR = 'Incorrect email or password.';

/**
 * Hashed once at module load and compared against on every failed lookup, so
 * a nonexistent email and a wrong password take the same code path AND
 * roughly the same time — the response never leaks which one was wrong
 * (§6.1), and neither does a timing difference between "ran bcrypt" and
 * "didn't bother".
 */
const DUMMY_HASH_PROMISE = hashPassword(
  'no-such-account-placeholder-used-only-for-constant-time-comparison',
);

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error as Error) : resolve()));
  });
}

export function staffAuthRouter(deps: StaffAuthRouteDeps): Router {
  const router = Router();

  router.get('/login', (_req, res) => {
    res.status(200).type('html').send(renderLoginPage({}));
  });

  router.post('/login', staffLoginRateLimit(deps.loginRateLimit), async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(401)
        .type('html')
        .send(renderLoginPage({ error: GENERIC_LOGIN_ERROR }));
      return;
    }

    const staffUser = await deps.staffUsers.findByEmail(parsed.data.email);
    const passwordOk = await verifyPassword(
      parsed.data.password,
      staffUser?.passwordHash ?? (await DUMMY_HASH_PROMISE),
    );

    if (!staffUser || !passwordOk) {
      logger.warn('staff login failed', { path: req.path });
      res
        .status(401)
        .type('html')
        .send(renderLoginPage({ error: GENERIC_LOGIN_ERROR }));
      return;
    }

    await regenerateSession(req);
    req.session.staffUserId = staffUser.id;
    logger.info('staff login succeeded', {
      staffUserId: staffUser.id,
      clientId: staffUser.clientId,
    });
    res.redirect(303, STAFF_DASHBOARD_PATH);
  });

  router.post('/logout', requireStaffAuth(deps.staffUsers), (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE_NAME);
      res.redirect(303, STAFF_LOGIN_PATH);
    });
  });

  router.get('/change-password', requireStaffAuth(deps.staffUsers), (_req, res) => {
    res.status(200).type('html').send(renderChangePasswordPage({}));
  });

  router.post('/change-password', requireStaffAuth(deps.staffUsers), async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.newPassword !== parsed.data.confirmPassword) {
      res
        .status(400)
        .type('html')
        .send(
          renderChangePasswordPage({
            error: 'Passwords must match and be at least 12 characters.',
          }),
        );
      return;
    }

    const staffUser = staffUserFromLocals(res);
    const passwordHash = await hashPassword(parsed.data.newPassword);
    await deps.staffUsers.completePasswordChange(staffUser.id, passwordHash);
    logger.info('staff password changed', { staffUserId: staffUser.id });
    res.redirect(303, STAFF_DASHBOARD_PATH);
  });

  return router;
}
