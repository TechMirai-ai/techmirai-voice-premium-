/**
 * POST /api/voice/check-availability — the `check_availability` tool's endpoint.
 * Purely algorithmic (VP-8 decision 4): fixed clinic hours minus already-taken
 * times, no real capacity tracking, no concurrency handling.
 */
import { Router } from 'express';
import { z } from 'zod';

import { loadClient } from '../config/loadClient.js';
import { checkAvailability } from '../reservation/availability.js';
import type { AppointmentRepository } from '../repositories/appointmentRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { CHECK_AVAILABILITY_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const CHECK_AVAILABILITY_PATH = '/check-availability';

const argumentsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 24-hour'),
});

export interface CheckAvailabilityRouteDeps {
  resolver: AssistantResolver;
  appointments: AppointmentRepository;
}

export function checkAvailabilityRouter(deps: CheckAvailabilityRouteDeps): Router {
  const router = Router();

  router.post(
    CHECK_AVAILABILITY_PATH,
    toolWebhook({
      toolName: CHECK_AVAILABILITY_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = argumentsSchema.safeParse(call.args);
        if (!parsed.success) {
          return errorResult(
            call,
            'Invalid or missing date/time. Ask the caller to repeat it, then try again.',
          );
        }
        const { date, time } = parsed.data;

        const config = loadClient(context.clientId);
        const takenTimes = await deps.appointments.listTakenTimes(context.clientId, date);
        const result = checkAvailability(config, date, time, takenTimes);

        if (result.closed) {
          return okResult(
            call,
            `The clinic is closed on ${date}. Ask the caller for a different date.`,
          );
        }
        if (result.requestedAvailable) {
          return okResult(call, `${time} on ${date} is available.`);
        }
        if (result.alternatives.length === 0) {
          return okResult(
            call,
            `${time} on ${date} is not available, and no other times are open that day. Ask the caller for a different date.`,
          );
        }
        return okResult(
          call,
          `${time} on ${date} is not available. Available instead: ${result.alternatives.join(', ')}.`,
        );
      },
    }),
  );

  return router;
}
