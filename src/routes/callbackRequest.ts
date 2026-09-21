/**
 * POST /api/voice/callback-request — the `request_callback` tool's endpoint.
 * Saves the caller's name, phone number and reason for staff to act on.
 * The ONLY place personal data is stored; it never reaches a log unredacted.
 */
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../lib/logger.js';
import { notifySafely, type CallbackNotifier } from '../lib/callbackNotifier.js';
import type { CallbackRequestRepository } from '../repositories/callbackRequestRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { REQUEST_CALLBACK_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const CALLBACK_REQUEST_PATH = '/callback-request';

const MAX_NAME_LENGTH = 100;
const MAX_REASON_LENGTH = 500;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

/** Full-width digits/spaces (common in Japanese input) are folded to ASCII first. */
const normalize = (value: string): string => value.normalize('NFKC').trim();
const digitCount = (value: string): number => value.replace(/\D/g, '').length;

const argumentsSchema = z.object({
  callerName: z.string().transform(normalize).pipe(z.string().min(1).max(MAX_NAME_LENGTH)),
  callerPhone: z
    .string()
    .transform(normalize)
    .pipe(
      z
        .string()
        .max(40)
        .refine((phone) => {
          const digits = digitCount(phone);
          return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS;
        }),
    ),
  reason: z.string().transform(normalize).pipe(z.string().max(MAX_REASON_LENGTH)).optional(),
});

export interface CallbackRequestRouteDeps {
  resolver: AssistantResolver;
  callbacks: CallbackRequestRepository;
  notifier: CallbackNotifier;
}

/** Names the invalid field only — never echoes the value back into logs or the model. */
function invalidFields(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'arguments')))].join(', ');
}

export function callbackRequestRouter(deps: CallbackRequestRouteDeps): Router {
  const router = Router();

  router.post(
    CALLBACK_REQUEST_PATH,
    toolWebhook({
      toolName: REQUEST_CALLBACK_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = argumentsSchema.safeParse(call.args);
        if (!parsed.success) {
          logger.warn('callback request rejected: invalid arguments', {
            clientId: context.clientId,
            callId: context.callId,
            fields: invalidFields(parsed.error),
          });
          return errorResult(
            call,
            `Invalid or missing: ${invalidFields(parsed.error)}. ` +
              'Ask the caller to repeat it, then try again.',
          );
        }

        const saved = await deps.callbacks.create({
          clientId: context.clientId,
          callId: context.callId,
          language: context.language,
          callerName: parsed.data.callerName,
          callerPhone: parsed.data.callerPhone,
          reason: parsed.data.reason ?? null,
        });

        logger.info('callback request saved', {
          callbackId: saved.id,
          clientId: context.clientId,
          callId: context.callId,
          language: context.language,
        });
        // Not awaited: a slow or failing channel must never delay or fail the save.
        void notifySafely(deps.notifier, saved);

        return okResult(call, 'The callback request was saved. Staff will call the caller back.');
      },
    }),
  );

  return router;
}
