/** Mounts both voice webhooks behind the shared rate limit and Custom Credential auth. */
import express, { Router } from 'express';

import { voiceRateLimit, type RateLimitOptions } from '../middleware/rateLimit.js';
import { webhookAuth } from '../middleware/webhookAuth.js';
import { callbackRequestRouter, type CallbackRequestRouteDeps } from './callbackRequest.js';
import { callTopicRouter, type CallTopicRouteDeps } from './callTopic.js';

export const VOICE_API_PREFIX = '/api/voice';

/** A tool-calls message is a few KB; anything bigger is not Vapi's. */
export const VOICE_BODY_LIMIT = '20kb';

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
