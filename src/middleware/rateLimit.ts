/**
 * Rate limiting for the voice webhooks (raised as needed by VP-1's security
 * review before any real webhook ships). Built on express-rate-limit.
 *
 * Applied BEFORE authentication so a guessing attack is throttled too. The
 * ceiling is generous for legitimate traffic (a call makes a handful of tool
 * calls) and low enough to stop a flood.
 */
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX = 60;

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
}

export function voiceRateLimit(options: RateLimitOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    limit: options.max ?? DEFAULT_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { status: 'error', error: 'rate_limited' },
  });
}
