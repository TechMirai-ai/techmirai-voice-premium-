/**
 * GET|POST /api/internal/archive-retry — runs one pass over the developer-archive job queue (VP-12).
 *
 * Called by Vercel Cron (GET, with `Authorization: Bearer <CRON_SECRET>` — set CRON_SECRET to the same
 * value as ARCHIVE_RETRY_SECRET) and by hand. It has its OWN secret, deliberately not the Vapi
 * webhook secret: whoever holds one must not be able to use the other. Same throttle and constant-time
 * Bearer check as the voice webhooks. The response is counts only — never a transcript, id or error text.
 */
import { Router, type Request, type Response } from 'express';

import { summarizeError } from '../lib/errorSummary.js';
import { logger } from '../lib/logger.js';
import type { RetryOptions, RetrySummary } from '../google/archiveService.js';
import { voiceRateLimit } from '../middleware/rateLimit.js';
import { webhookAuth } from '../middleware/webhookAuth.js';

export const ARCHIVE_RETRY_PATH = '/api/internal/archive-retry';

export interface ArchiveRetryRouteDeps {
  retrySecret: string;
  service: { retryPending(options?: RetryOptions): Promise<RetrySummary> };
}

export function archiveRetryRouter(deps: ArchiveRetryRouteDeps): Router {
  const router = Router();

  router.use(voiceRateLimit(), webhookAuth(deps.retrySecret));
  router.all('/', async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ status: 'error', error: 'method_not_allowed' });
      return;
    }
    try {
      const summary = await deps.service.retryPending();
      logger.info('archive retry run finished', { ...summary.queue, claimed: summary.claimed });
      res.status(200).json({ status: 'ok', ...summary });
    } catch (error) {
      logger.error('archive retry run crashed', { ...summarizeError(error) });
      res.status(500).json({ status: 'error', error: 'internal_error' });
    }
  });

  return router;
}
