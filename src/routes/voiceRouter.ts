/** Mounts both voice webhooks behind the shared rate limit and Custom Credential auth. */
import express, { Router } from 'express';

import { voiceRateLimit, type RateLimitOptions } from '../middleware/rateLimit.js';
import { webhookAuth } from '../middleware/webhookAuth.js';
import { callbackRequestRouter, type CallbackRequestRouteDeps } from './callbackRequest.js';
import { callTopicRouter, type CallTopicRouteDeps } from './callTopic.js';

export const VOICE_API_PREFIX = '/api/voice';

/**
 * A tool-calls message embeds the full assistant config (~8KB, mostly the FAQ
 * prompt) plus the call artifact/transcript so far, which grows with call
 * length. Real call 01a0c74e-0aaf-7000-9fdb-a73f0c2e0890 (2026-09-22) hit the
 * old 20kb limit on both webhooks — see VAPI-FACTS.md VP-4 R5.
 */
export const VOICE_BODY_LIMIT = '2mb';

export interface VoiceRouterOptions extends CallbackRequestRouteDeps, CallTopicRouteDeps {
  webhookSecret: string;
  rateLimit?: RateLimitOptions;
}

export function voiceRouter(options: VoiceRouterOptions): Router {
  const router = Router();

  // Order matters: throttle first so credential guessing is limited, then authenticate.
  router.use(voiceRateLimit(options.rateLimit), webhookAuth(options.webhookSecret));
  // Parsed only after the request has been throttled and authenticated.
  router.use(express.json({ limit: VOICE_BODY_LIMIT }));
  router.use(callbackRequestRouter(options));
  router.use(callTopicRouter(options));

  return router;
}
