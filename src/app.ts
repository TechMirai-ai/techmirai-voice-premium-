/**
 * Builds the Express app. Kept separate from server.ts so tests can mount it
 * without opening a port or a real database connection.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import { LANGUAGE_CODE_PATTERN, SLUG_PATTERN } from './config/schema.js';
import type { Queryable } from './db/pool.js';
import { isDatabaseReachable } from './db/pool.js';
import { logger } from './lib/logger.js';
import { readState, type StateStoreOptions } from './vapi/stateStore.js';
import {
  VAPI_WIDGET_SCRIPT_ORIGIN,
  renderTestCallBootstrapScript,
  renderTestCallPage,
} from './vapi/testPage.js';

/** Vapi tool payloads are small; anything larger is not ours. */
export const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  db: Queryable;
  isProduction: boolean;
  /** Vapi's public key — safe for the browser. Only used by /vapi-test-call, gated out of production. */
  vapiPublicKey: string;
  /** Overrides for tests: where .vapi-state.<clientId>.json is resolved from. */
  vapiStateRepoRoot?: StateStoreOptions['repoRoot'];
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
  // allow it — every other route keeps the strict default.
  const testCallCsp = helmet.contentSecurityPolicy({
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", VAPI_WIDGET_SCRIPT_ORIGIN],
    },
  });

  app.get('/vapi-test-call', testCallCsp, (req: Request, res: Response) => {
    if (options.isProduction) {
      res.status(404).json({ status: 'error', error: 'not_found' });
      return;
    }

    const query = parseTestCallQuery(req);
    if (!query) {
      res.status(400).type('text').send('Usage: /vapi-test-call?clientId=<id>&language=<code>');
      return;
    }

    res.status(200).type('html').send(renderTestCallPage(query));
  });

  // Same-origin bootstrap script for the page above — see testPage.ts for why
  // this isn't inlined into the HTML.
  app.get('/vapi-test-call.js', (req: Request, res: Response) => {
    if (options.isProduction) {
      res.status(404).json({ status: 'error', error: 'not_found' });
      return;
    }

    const query = parseTestCallQuery(req);
    if (!query) {
      res.status(400).type('text').send('Usage: /vapi-test-call.js?clientId=<id>&language=<code>');
      return;
    }

    const stateOptions: StateStoreOptions = options.vapiStateRepoRoot
      ? { repoRoot: options.vapiStateRepoRoot }
      : {};
    const state = readState(query.clientId, stateOptions);
    const assistantId = state.assistants[`${query.clientId}--${query.language}`];

    if (!assistantId) {
      res
        .status(404)
        .type('text')
        .send(
          `No synced assistant found for "${query.clientId}" / "${query.language}". ` +
            `Run: npm run vapi:sync -- ${query.clientId} --language ${query.language} --apply`,
        );
      return;
    }

    res
      .type('application/javascript')
      .send(renderTestCallBootstrapScript({ publicKey: options.vapiPublicKey, assistantId }));
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

interface TestCallQuery {
  clientId: string;
  language: string;
}

function parseTestCallQuery(req: Request): TestCallQuery | undefined {
  const clientId = req.query['clientId'];
  const language = req.query['language'];

  if (
    typeof clientId !== 'string' ||
    typeof language !== 'string' ||
    !SLUG_PATTERN.test(clientId) ||
    !LANGUAGE_CODE_PATTERN.test(language)
  ) {
    return undefined;
  }

  return { clientId, language };
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
