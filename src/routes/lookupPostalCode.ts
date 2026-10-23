/**
 * POST /api/voice/lookup-postal-code — the `lookup_postal_code` tool's endpoint (VP-20).
 * Turns a confirmed 7-digit postal code into prefecture / city / town. Every outcome is answered
 * so the model can keep the call moving; a failed lookup tells it to ask for the full address.
 * The postal code and the resolved address are never logged — only the outcome kind.
 */
import { Router } from 'express';
import { z } from 'zod';

import { lookupReply } from '../address/lookupReply.js';
import type { PostalCodeLookup } from '../address/postalCodeLookup.js';
import { logger } from '../lib/logger.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { LOOKUP_POSTAL_CODE_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const LOOKUP_POSTAL_CODE_PATH = '/lookup-postal-code';

const argumentsSchema = z.object({
  postalCode: z.string().min(1),
});

export interface LookupPostalCodeRouteDeps {
  resolver: AssistantResolver;
  postalCodes: PostalCodeLookup;
}

export function lookupPostalCodeRouter(deps: LookupPostalCodeRouteDeps): Router {
  const router = Router();

  router.post(
    LOOKUP_POSTAL_CODE_PATH,
    toolWebhook({
      toolName: LOOKUP_POSTAL_CODE_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = argumentsSchema.safeParse(call.args);
        if (!parsed.success) {
          return errorResult(
            call,
            'Invalid or missing postalCode. Ask the caller to repeat the 7 digits, then try again.',
          );
        }

        const result = await deps.postalCodes.lookup(parsed.data.postalCode);
        logger.info('lookup_postal_code', {
          clientId: context.clientId,
          callId: context.callId,
          outcome: result.kind,
        });

        const reply = lookupReply(result);
        return reply.isError ? errorResult(call, reply.text) : okResult(call, reply.text);
      },
    }),
  );

  return router;
}
