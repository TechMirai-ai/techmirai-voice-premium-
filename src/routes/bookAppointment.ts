/**
 * POST /api/voice/book-appointment — the `book_appointment` tool's endpoint.
 * Re-checks availability server-side right before writing: decision 4 (VP-8
 * work order §1) says no concurrency handling is needed, but a same-request
 * re-check is nearly free and stops a booking for a time check_availability
 * never actually cleared (e.g. the model inventing a time on its own).
 */
import { Router } from 'express';
import { z } from 'zod';

import { summarizeError } from '../lib/errorSummary.js';
import { logger } from '../lib/logger.js';
import { loadClient } from '../config/loadClient.js';
import { DEMO_PLACEHOLDER_PHONE } from '../lib/demoCallerPhone.js';
import type { BookingNotification, BookingNotifier } from '../notifications/bookingNotifier.js';
import { checkAvailability } from '../reservation/availability.js';
import type { AppointmentRepository } from '../repositories/appointmentRepository.js';
import type { ReservationServiceRepository } from '../repositories/reservationServiceRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { BOOK_APPOINTMENT_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const BOOK_APPOINTMENT_PATH = '/book-appointment';

const MAX_NAME_LENGTH = 100;

const argumentsSchema = z.object({
  serviceId: z.string().min(1).optional(),
  patientName: z
    .string()
    .transform((value) => value.normalize('NFKC').trim())
    .pipe(z.string().min(1).max(MAX_NAME_LENGTH)),
  isReturningPatient: z.boolean().optional().default(false),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 24-hour'),
});

export interface BookAppointmentRouteDeps {
  resolver: AssistantResolver;
  appointments: AppointmentRepository;
  services: ReservationServiceRepository;
  /** VP-23: caller SMS + staff LINE alert after a booking. Omitted = no notifications. */
  bookingNotifier?: BookingNotifier;
}

/**
 * The booking is already saved, so nothing the notifier does may turn into an error for the
 * caller ("a system problem prevented this from being saved" would be false). The real notifier
 * never rejects; this guards against any other implementation that does.
 */
async function notifyBookedSafely(
  notifier: BookingNotifier | undefined,
  booking: BookingNotification,
): Promise<void> {
  try {
    await notifier?.notifyBooked(booking);
  } catch (error) {
    logger.error('booking notifier threw', {
      clientId: booking.clientId,
      appointmentId: booking.appointmentId,
      ...summarizeError(error),
    });
  }
}

/** Names the invalid field only — never echoes the value back into logs or the model. */
function invalidFields(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'arguments')))].join(', ');
}

export function bookAppointmentRouter(deps: BookAppointmentRouteDeps): Router {
  const router = Router();

  router.post(
    BOOK_APPOINTMENT_PATH,
    toolWebhook({
      toolName: BOOK_APPOINTMENT_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = argumentsSchema.safeParse(call.args);
        if (!parsed.success) {
          return errorResult(
            call,
            `Invalid or missing: ${invalidFields(parsed.error)}. Ask the caller to repeat it, then try again.`,
          );
        }
        const { date, time } = parsed.data;

        const config = loadClient(context.clientId);
        const takenTimes = await deps.appointments.listTakenTimes(context.clientId, date);
        const availability = checkAvailability(config, date, time, takenTimes);
        if (!availability.requestedAvailable) {
          return errorResult(
            call,
            // Wording matters: "for a new time" invited the model to invent one (test batch 2026-11-09,
            // X02). check_availability on the same date and time returns the times that really are open.
            'That time is no longer available. Call check_availability again with the same date and ' +
              'time to get the times that are open.',
          );
        }

        let serviceName: string | null = null;
        if (parsed.data.serviceId) {
          const services = await deps.services.listByClient(context.clientId);
          const service = services.find((entry) => entry.id === parsed.data.serviceId);
          if (!service) {
            return errorResult(
              call,
              'Invalid or missing: serviceId. Ask the caller to choose again.',
            );
          }
          // Internal record only — never spoken from this field; the model already knows the
          // service name itself from collecting it earlier in the conversation.
          serviceName = service.name.en ?? service.name.ja ?? null;
        }

        const booked = await deps.appointments.create({
          clientId: context.clientId,
          callId: context.callId,
          language: context.language,
          serviceId: parsed.data.serviceId ?? null,
          serviceName,
          patientName: parsed.data.patientName,
          // The number typed on the demo page (VP-15); the placeholder only when a call has none.
          patientPhone: context.callerPhone ?? DEMO_PLACEHOLDER_PHONE,
          isReturningPatient: parsed.data.isReturningPatient,
          appointmentDate: date,
          appointmentTime: time,
        });

        logger.info('appointment booked', {
          clientId: context.clientId,
          callId: context.callId,
          appointmentId: booked.id,
        });

        // The booking is saved; telling people about it is best-effort and never rejects. It is
        // awaited, not fire-and-forget: a serverless function may be frozen the moment the
        // response is sent, which would silently drop an unfinished send.
        await notifyBookedSafely(deps.bookingNotifier, {
          clientId: context.clientId,
          appointmentId: booked.id,
          callId: context.callId,
          reservationNumber: booked.reservationNumber,
          language: context.language,
          patientName: booked.patientName,
          serviceName,
          date,
          time,
          // Only a real number: the demo placeholder stored above is not dialable.
          ...(context.callerPhone ? { callerPhone: context.callerPhone } : {}),
        });

        return okResult(call, `Booked. Reservation number: ${booked.reservationNumber}.`);
      },
    }),
  );

  return router;
}
