/**
 * POST /api/voice/request-consultation — the `request_consultation` tool's endpoint.
 *
 * Saves a consultation request (name + a number staff may use) and tells the caller's SMS and the
 * staff LINE channel. The server, not the model, decides everything that matters:
 *  - the client and language come from the assistant that called (never a model argument);
 *  - `call_id` comes from the Vapi call object; a request without one never reaches this handler
 *    (the envelope is rejected) and nothing is saved;
 *  - with `phone_source: "caller_id"` the number is the call's own caller ID — the model supplies
 *    no number. With `"spoken"` it supplies one, which is normalised and rejected if invalid;
 *  - the name and reason are put on one line, stripped of control characters and length-limited
 *    BEFORE they are stored or reach any SMS/LINE text.
 * Saving is idempotent on (client_id, call_id): a repeated tool call returns the first result and
 * sends nothing again. Notification failures never undo or hide the saved request.
 *
 * Personal data (name, number, reason) is never logged — only ids and outcomes.
 */
import { Router } from 'express';
import { z } from 'zod';

import { loadClient } from '../config/loadClient.js';
import { normalizeCallerPhone } from '../lib/callerPhone.js';
import { logger } from '../lib/logger.js';
import type { ConsultationNotifier } from '../notifications/bookingNotifier.js';
import { checkSmsNumber } from '../notifications/smsEligibility.js';
import { sanitizeInline } from '../notifications/template.js';
import type { ConsultationRequestRepository } from '../repositories/consultationRequestRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { CONSULTATION_SUCCESS_PREFIX } from '../lib/callStatus.js';
import { REQUEST_CONSULTATION_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const REQUEST_CONSULTATION_PATH = '/request-consultation';

export const MAX_CONTACT_NAME_LENGTH = 100;
export const MAX_REASON_LENGTH = 300;

const argumentsSchema = z.object({
  contact_name: z.string(),
  phone_source: z.enum(['caller_id', 'spoken']),
  spoken_phone: z.string().optional(),
  reason: z.string().optional(),
  /** Accepted for the model's benefit; the call's language comes from the assistant, not from here. */
  language: z.string().optional(),
});

const NO_CALLER_ID =
  'There is no caller ID on this call, so nothing was saved. Ask the caller for a number they ' +
  'can be reached on, read it back digit by digit, and once they say yes call this tool again ' +
  'with phone_source "spoken".';
const INVALID_NUMBER =
  'That number is not valid, so nothing was saved. Ask the caller to say it again, read it back ' +
  'digit by digit, and call this tool again only after they say yes.';
const INVALID_NAME = 'The name is missing, so nothing was saved. Ask the caller for their name.';
const NOT_AVAILABLE = 'Consultation requests are not available here, so nothing was saved.';

export interface RequestConsultationRouteDeps {
  resolver: AssistantResolver;
  consultations: ConsultationRequestRepository;
  /** Omit to save requests without telling anyone (tests). */
  consultationNotifier?: ConsultationNotifier;
}

/** Names the invalid field only — never echoes the value back into logs or the model. */
function invalidFields(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'arguments')))].join(', ');
}

export function requestConsultationRouter(deps: RequestConsultationRouteDeps): Router {
  const router = Router();

  router.post(
    REQUEST_CONSULTATION_PATH,
    toolWebhook({
      toolName: REQUEST_CONSULTATION_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const config = loadClient(context.clientId);
        const consultation = config.consultation;
        if (!consultation) return errorResult(call, NOT_AVAILABLE);

        const parsed = argumentsSchema.safeParse(call.args);
        if (!parsed.success) {
          logger.warn('consultation request rejected: invalid arguments', {
            clientId: context.clientId,
            callId: context.callId,
            fields: invalidFields(parsed.error),
          });
          return errorResult(
            call,
            `Invalid or missing: ${invalidFields(parsed.error)}. Nothing was saved. Ask the caller again, then try again.`,
          );
        }
        const { phone_source: phoneSource } = parsed.data;

        const contactName = sanitizeInline(parsed.data.contact_name, MAX_CONTACT_NAME_LENGTH);
        if (!contactName) return errorResult(call, INVALID_NAME);

        // `callerPhone` is the call's caller ID (or, on the demo /talk page, the number typed
        // there); it is undefined for a withheld or missing number.
        const rawNumber =
          phoneSource === 'caller_id' ? context.callerPhone : parsed.data.spoken_phone;
        if (phoneSource === 'caller_id' && !rawNumber) return errorResult(call, NO_CALLER_ID);
        const contactPhone = rawNumber ? normalizeCallerPhone(rawNumber) : undefined;
        if (!contactPhone) return errorResult(call, INVALID_NUMBER);

        const reason = sanitizeInline(parsed.data.reason ?? '', MAX_REASON_LENGTH) || null;

        const { request, created } = await deps.consultations.create({
          clientId: context.clientId,
          callId: context.callId,
          language: context.language,
          contactName,
          contactPhone,
          phoneSource,
          reason,
        });

        logger.info('consultation request saved', {
          requestId: request.id,
          clientId: context.clientId,
          callId: context.callId,
          language: context.language,
          phoneSource,
          created,
        });

        // Only a NEW row notifies anyone: a repeated tool call in the same call is a no-op. The
        // send is awaited — a serverless function may be frozen once the response is sent.
        if (created) {
          await deps.consultationNotifier?.notifyConsultation({
            clientId: context.clientId,
            requestId: request.id,
            callId: context.callId,
            language: context.language,
            contactName,
            contactPhone,
            phoneSource,
            reason,
            createdAt: request.createdAt,
          });
        }

        // Whether a text is expected follows the number's type, from the client's own SMS rules.
        const sms = config.notifications?.sms;
        const smsExpected =
          sms !== undefined && checkSmsNumber(contactPhone, sms).rejection === undefined;
        return okResult(
          call,
          `${CONSULTATION_SUCCESS_PREFIX} Say staff will contact the caller to arrange a ` +
            'meeting, during the contact hours in your instructions. ' +
            (smsExpected
              ? 'A text message should reach them shortly: you may mention it, as something that ' +
                'should arrive, not a guarantee.'
              : 'No text message will be sent to this number: do not mention one.'),
        );
      },
    }),
  );

  return router;
}
