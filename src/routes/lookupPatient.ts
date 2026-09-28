/**
 * POST /api/voice/lookup-patient — the `lookup_patient` tool's endpoint.
 * Matches by phone number only (VP-8 decision 5) — the spoken name the model
 * sends back to the caller is only for a verbal confirmation, never the
 * lookup key, and is not accepted as an argument here.
 */
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../lib/logger.js';
import { normalizePhoneDigits } from '../lib/phone.js';
import type { ReservationPatientRepository } from '../repositories/reservationPatientRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { LOOKUP_PATIENT_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const LOOKUP_PATIENT_PATH = '/lookup-patient';

const argumentsSchema = z.object({
  callerPhone: z.string().min(1),
});

export interface LookupPatientRouteDeps {
  resolver: AssistantResolver;
  patients: ReservationPatientRepository;
}

export function lookupPatientRouter(deps: LookupPatientRouteDeps): Router {
  const router = Router();

  router.post(
    LOOKUP_PATIENT_PATH,
    toolWebhook({
      toolName: LOOKUP_PATIENT_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = argumentsSchema.safeParse(call.args);
        if (!parsed.success) {
          return errorResult(
            call,
            'Invalid or missing phone number. Ask the caller to repeat it, then try again.',
          );
        }

        const phoneDigits = normalizePhoneDigits(parsed.data.callerPhone);
        const patient = await deps.patients.findByPhone(context.clientId, phoneDigits);

        logger.info('lookup_patient', {
          clientId: context.clientId,
          callId: context.callId,
          found: Boolean(patient),
        });

        return okResult(
          call,
          patient
            ? `Found: ${patient.name}.`
            : 'No patient record was found for that phone number.',
        );
      },
    }),
  );

  return router;
}
