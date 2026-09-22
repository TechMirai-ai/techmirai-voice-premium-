/**
 * Mounts the staff dashboard behind server-side sessions (VP-5 §4.1:
 * connect-pg-simple, not JWT). Self-contained cookie/session/body parsing,
 * like voiceRouter.ts is self-contained for its own auth and body parsing.
 *
 * The session Store is injected rather than constructed here so tests can
 * pass express-session's built-in MemoryStore instead of a real Postgres
 * pool (connect-pg-simple's PGStore requires a genuine `pg.Pool`, which
 * would force every test that builds an app — including the unrelated voice
 * webhook tests — to depend on a live database). Production wiring
 * (src/server.ts) passes a real connect-pg-simple PGStore.
 */
import express, { Router } from 'express';
import session from 'express-session';

import { staffAuthRouter, type StaffAuthRouteDeps } from './staffAuth.js';
import { staffDashboardRouter, type StaffDashboardRouteDeps } from './staffDashboard.js';

export const STAFF_URL_PREFIX = '/staff';
export const SESSION_COOKIE_NAME = 'tmvp.sid';

/** A staff work shift, roughly — long enough to not annoy, short enough to matter. */
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export interface StaffRouterOptions extends StaffAuthRouteDeps, StaffDashboardRouteDeps {
  sessionStore: session.Store;
  sessionSecret: string;
  /** Cookies are marked Secure (HTTPS-only) in production; local dev is plain HTTP. */
  isProduction: boolean;
}

export function staffRouter(options: StaffRouterOptions): Router {
  const router = Router();

  router.use(
    session({
      store: options.sessionStore,
      name: SESSION_COOKIE_NAME,
      secret: options.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: options.isProduction,
        maxAge: SESSION_MAX_AGE_MS,
      },
    }),
  );
  router.use(express.urlencoded({ extended: false }));
  router.use(staffAuthRouter(options));
  router.use(staffDashboardRouter(options));

  return router;
}
