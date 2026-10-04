/**
 * Builds the Express app. Kept separate from server.ts so tests can mount it
 * without opening a port or a real database connection.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import * as helmetModule from 'helmet';

// helmet@8's package.json "exports" map has no explicit "types" condition
// (unlike bcryptjs's, which does) — it relies on TS's implicit sibling
// .d.mts/.d.cts pairing instead. That resolves correctly under every local
// tsc invocation tried, but proved fragile in a different build environment
// (Vercel's function-level typecheck saw helmet's default as non-callable
// with an identical TypeScript version). Binding to the named `default`
// export explicitly, rather than via a plain default import, sidesteps any
// esModuleInterop/synthetic-default ambiguity in how that import resolves.
const helmet = helmetModule.default;

import type { Queryable } from './db/pool.js';
import { isDatabaseReachable } from './db/pool.js';
import { summarizeError } from './lib/errorSummary.js';
import { logger } from './lib/logger.js';
import { STAFF_URL_PREFIX, staffRouter, type StaffRouterOptions } from './routes/staffRouter.js';
import { VOICE_API_PREFIX, voiceRouter, type VoiceRouterOptions } from './routes/voiceRouter.js';
import { TEST_PAGE_URL_PREFIX, defaultTestPageDir } from './vapi/generateTestPage.js';

/** Vapi tool payloads are small; anything larger is not ours. */
export const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  db: Queryable;
  isProduction: boolean;
  /** The Vapi webhooks. Required: there is deliberately no way to mount them unauthenticated. */
  voice: VoiceRouterOptions;
  /** The staff dashboard. `isProduction` is filled in from the field above. */
  staff: Omit<StaffRouterOptions, 'isProduction'>;
  /**
   * Number of reverse proxies (ngrok, a load balancer) in front of the app, so
   * rate limiting sees the real client IP. Leave unset when directly exposed.
   */
  trustProxyHops?: number;
  /** Override for tests: the directory of generated test pages (default: public/vapi-test-call). */
  vapiTestPageDir?: string;
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  if (options.trustProxyHops !== undefined) app.set('trust proxy', options.trustProxyHops);

  // Internal QA tool (work order VP-2 §6.8) — never mounted in production.
  // The pre-generated test-call page and its bootstrap script (`npm run
  // vapi:test-page`) are plain static files, served by express.static().
  //
  // Deliberately NO Content-Security-Policy on this route (helmet's other
  // headers still apply). A CSP here — helmet's default, and the widened
  // Vapi/Daily one — made Vapi web calls fail to join the Daily room
  // (`daily-call-join-error`), while the same page with the CSP off joins.
  // We stopped bisecting which directive is responsible: this is an
  // internal QA page, not customer-facing, and the CSP cost hours without a
  // confirmed benefit for it. Every other route keeps helmet's full default
  // CSP. See docs/VAPI-FACTS.md, "KNOWN ISSUE" (steps 12–13).
  //
  // Mounted before the global helmet() so a served file never reaches it;
  // a missing file falls through to the strict JSON 404 below.
  if (!options.isProduction) {
    app.use(
      TEST_PAGE_URL_PREFIX,
      helmet({ contentSecurityPolicy: false }),
      express.static(options.vapiTestPageDir ?? defaultTestPageDir(), {
        index: false,
        redirect: false,
      }),
    );
  }

  app.use(helmet());
  // Before the global body parser: the voice routes throttle, authenticate and only then parse.
  app.use(VOICE_API_PREFIX, voiceRouter(options.voice));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  // Self-contained cookie/session/urlencoded-body parsing, like the voice router above.
  app.use(STAFF_URL_PREFIX, staffRouter({ ...options.staff, isProduction: options.isProduction }));

  app.get('/healthz', async (_req: Request, res: Response) => {
    const databaseUp = await isDatabaseReachable(options.db);

    if (!databaseUp) {
      logger.error('health check failed: database unreachable');
      res.status(503).json({ status: 'error', error: 'database_unavailable' });
      return;
    }

    res.status(200).json({ status: 'ok' });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', error: 'not_found' });
  });

  app.use(errorHandler(options.isProduction));

  return app;
}

/**
 * Central error handler. Logs the detail (redacted) on the server side and
 * returns a short message to the caller — never a stack trace in production.
 */
function errorHandler(isProduction: boolean) {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const status = statusOf(error);
    const message = error instanceof Error ? error.message : String(error);

    // A client error (bad JSON, oversized body) can quote the request body in its
    // message — which on the voice routes may hold a caller's name. Log only its type.
    logger.error('request failed', {
      status,
      ...(status >= 500 ? { error: message } : summarizeError(error)),
      // A parse error's stack begins with a snippet of the body, so only server faults get one.
      ...(isProduction || status < 500
        ? {}
        : { stack: error instanceof Error ? error.stack : undefined }),
    });

    res.status(status).json({
      status: 'error',
      error: status === 400 ? 'bad_request' : 'internal_error',
      ...(isProduction ? {} : { message }),
    });
  };
}

/** body-parser and friends set `status`/`statusCode` on the error they throw. */
function statusOf(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = candidate.status ?? candidate.statusCode;
    if (typeof status === 'number' && status >= 400 && status <= 599) return status;
  }
  return 500;
}
