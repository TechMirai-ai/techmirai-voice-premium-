/**
 * Builds the Express app. Kept separate from server.ts so tests can mount it
 * without opening a port or a real database connection.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import type { Queryable } from './db/pool.js';
import { isDatabaseReachable } from './db/pool.js';
import { logger } from './lib/logger.js';

/** Vapi tool payloads are small; anything larger is not ours. */
export const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  db: Queryable;
  isProduction: boolean;
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
