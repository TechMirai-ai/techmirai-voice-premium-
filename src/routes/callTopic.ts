/**
 * POST /api/voice/call-topic — the `log_call_topic` tool's endpoint.
 * Records which topic a call was about and how it ended. No personal data is
 * accepted, stored or logged here: the arguments are a slug and an enum.
 */
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../lib/logger.js';
import { allowedTopics, CALL_OUTCOMES } from '../lib/callTopics.js';
import type { KnowledgeSource } from '../knowledge/KnowledgeSource.js';
import type { CallTopicRepository } from '../repositories/callTopicRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { LOG_CALL_TOPIC_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const CALL_TOPIC_PATH = '/call-topic';

const argumentsSchema = z.object({
  topic: z.string().trim().max(64),
  outcome: z.enum(CALL_OUTCOMES),
});

export interface CallTopicRouteDeps {
  resolver: AssistantResolver;
  knowledge: KnowledgeSource;
  topics: CallTopicRepository;
}

export function callTopicRouter(deps: CallTopicRouteDeps): Router {
  const router = Router();

  router.post(
    CALL_TOPIC_PATH,
    toolWebhook({
      toolName: LOG_CALL_TOPIC_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = argumentsSchema.safeParse(call.args);
        const faq = await deps.knowledge.listFaq(context.clientId);
        const allowed = allowedTopics(faq.map((entry) => entry.id));

        if (!parsed.success || !allowed.includes(parsed.data.topic)) {
          logger.warn('call topic rejected: invalid topic or outcome', {
            clientId: context.clientId,
            callId: context.callId,
          });
          return errorResult(call, 'Invalid topic or outcome; nothing was logged.');
        }

        await deps.topics.record({
          clientId: context.clientId,
          callId: context.callId,
          topic: parsed.data.topic,
          outcome: parsed.data.outcome,
          language: context.language,
        });
        logger.info('call topic logged', {
          clientId: context.clientId,
          callId: context.callId,
          topic: parsed.data.topic,
          outcome: parsed.data.outcome,
        });

        return okResult(call, 'Logged.');
      },
    }),
  );

  return router;
}
