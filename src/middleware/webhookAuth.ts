/**
 * Authenticates Vapi's webhooks (VP-4 §3: no exceptions, not even in development).
 *
 * Vapi sends the secret from the Custom Credential referenced by each tool's
 * `server.credentialId`, as `Authorization: Bearer <token>` (VAPI-FACTS.md,
 * VP-4 R4). The token is compared in constant time against WEBHOOK_SECRET.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { logger } from '../lib/logger.js';

const BEARER_PREFIX = /^Bearer\s+/i;

/** The scheme is mandatory: a bare secret with no `Bearer ` is not what Vapi sends. */
const hasBearerScheme = (header: string | undefined): header is string =>
  header !== undefined && BEARER_PREFIX.test(header);

/** Hashing first gives equal-length buffers, so the comparison leaks nothing about length. */
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export function webhookAuth(secret: string): RequestHandler {
  if (secret.length === 0) throw new Error('webhookAuth: the webhook secret must not be empty');

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    const presented = hasBearerScheme(header) ? header.replace(BEARER_PREFIX, '') : undefined;

    if (presented === undefined || presented.length === 0 || !tokenMatches(presented, secret)) {
      logger.warn('webhook rejected: bad or missing credentials', { path: req.path });
      res.status(401).json({ status: 'error', error: 'unauthorized' });
      return;
    }
    next();
  };
}
