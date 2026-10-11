/**
 * POST /api/voice/lookup-patient — the `lookup_patient` tool's endpoint.
 * Matches by the caller's confirmed name: there is no real caller number on a browser web call
 * yet (src/lib/demoCallerPhone.ts). TODO(SV-5): match on caller-ID once phone calls exist.
 */
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../lib/logger.js';
import type { ReservationPatientRepository } from '../repositories/reservationPatientRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { LOOKUP_PATIENT_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const LOOKUP_PATIENT_PATH = '/lookup-patient';

const argumentsSchema = z.object({
  callerName: z.string().min(1),
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
            'Invalid or missing name. Ask the caller to repeat it, then try again.',
          );
        }

        const patient = await deps.patients.findByName(context.clientId, parsed.data.callerName);

        logger.info('lookup_patient', {
          clientId: context.clientId,
          callId: context.callId,
          found: Boolean(patient),
        });

        return okResult(
          call,
          patient ? `Found: ${patient.name}.` : 'No patient record was found for that name.',
        );
      },
    }),
  );

  return router;
}
