/**
 * Builds the Express app. Kept separate from server.ts so tests can mount it
 * without opening a port or a real database connection.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import type { Queryable } from './db/pool.js';
import { isDatabaseReachable } from './db/pool.js';
import { logger } from './lib/logger.js';
import { TEST_PAGE_URL_PREFIX, defaultTestPageDir } from './vapi/generateTestPage.js';
import {
  DAILY_CALL_ORIGINS,
  DAILY_CALL_WSS_ORIGINS,
  DAILY_SENTRY_ORIGIN,
  VAPI_API_ORIGIN,
  VAPI_WIDGET_ICON_ORIGIN,
  VAPI_WIDGET_SCRIPT_ORIGIN,
} from './vapi/testPage.js';

/** Vapi tool payloads are small; anything larger is not ours. */
export const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  db: Queryable;
  isProduction: boolean;
  /** Override for tests: the directory of generated test pages (default: public/vapi-test-call). */
  vapiTestPageDir?: string;
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get('/healthz', async (_req: Request, res: Response) => {
    const databaseUp = await isDatabaseReachable(options.db);

    if (!databaseUp) {
      logger.error('health check failed: database unreachable');
      res.status(503).json({ status: 'error', error: 'database_unavailable' });
      return;
    }

    res.status(200).json({ status: 'ok' });
  });

  // Internal QA tool (work order VP-2 §6.8) — never mounted in production.
  // helmet's default CSP is `script-src 'self'`; the widget it loads comes
  // from VAPI_WIDGET_SCRIPT_ORIGIN, so only this route's CSP is widened to
  // allow it — every other route keeps the strict default. img-src is
  // widened the same way for VAPI_WIDGET_ICON_ORIGIN, which the widget
  // fetches its button icon from at runtime (helmet's default img-src is
  // `'self' data:`, which otherwise blocks it). connect-src/script-src/
  // worker-src are widened for Vapi's own API plus Daily's WebRTC transport
  // that Vapi's web calls run on — see testPage.ts for the full rationale
  // and source (Daily's CSP guide).
  const testCallCsp = helmet.contentSecurityPolicy({
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", VAPI_WIDGET_SCRIPT_ORIGIN, ...DAILY_CALL_ORIGINS],
      'img-src': ["'self'", 'data:', VAPI_WIDGET_ICON_ORIGIN],
      'connect-src': [
        "'self'",
        VAPI_API_ORIGIN,
        ...DAILY_CALL_ORIGINS,
        ...DAILY_CALL_WSS_ORIGINS,
        DAILY_SENTRY_ORIGIN,
      ],
      'worker-src': ["'self'", 'blob:'],
    },
  });

  // The page and its bootstrap script are pre-generated static files
  // (`npm run vapi:test-page`), served by express.static() — no per-request
  // rendering. Never mounted in production (falls through to the JSON 404).
  if (!options.isProduction) {
    app.use(
      TEST_PAGE_URL_PREFIX,
      testCallCsp,
      express.static(options.vapiTestPageDir ?? defaultTestPageDir(), {
        index: false,
        redirect: false,
      }),
    );
  }

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

    logger.error('request failed', {
      status,
      error: message,
      ...(isProduction ? {} : { stack: error instanceof Error ? error.stack : undefined }),
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
