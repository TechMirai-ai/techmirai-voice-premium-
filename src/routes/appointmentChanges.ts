/**
 * VP-25: the `find_my_appointments`, `cancel_appointment` and `reschedule_appointment` tools —
 * callers changing a booking they made, matched by the number the call came from.
 *
 * The server decides who may change what, never the model:
 *  - the caller's number comes from the call only (`context.callerPhone`); no tool takes a phone
 *    number, so an argument cannot widen the search or reach another caller's booking;
 *  - a booking must belong to that number, be active and not have started yet — and "not yours",
 *    "does not exist", "cancelled" and "in the past" all get the SAME answer, so there is nothing
 *    to probe;
 *  - a reschedule goes through the same availability check as a booking, so an invented time is
 *    refused; the change itself is one atomic statement (see the repository);
 *  - a call may change ONE booking (owner decision) — enforced by a unique index.
 *
 * Phone-number matching is not authentication: caller ID can be spoofed, and on the demo /talk page
 * the number is simply typed in. Documented as a known limitation in docs/VP25-APPOINTMENT-CHANGES.md.
 *
 * The change is saved before anyone is told; a notifier problem never undoes it or reaches the
 * caller (same policy as bookings).
 */
import { Router } from 'express';
import { z } from 'zod';

import { loadClient } from '../config/loadClient.js';
import type { ClientConfig } from '../config/schema.js';
import { clinicNow, type ClinicNow } from '../lib/clinicTime.js';
import { summarizeError } from '../lib/errorSummary.js';
import { logger } from '../lib/logger.js';
import type {
  AppointmentChangeNotification,
  BookingNotifier,
} from '../notifications/bookingNotifier.js';
import { checkAvailability } from '../reservation/availability.js';
import {
  ChangeLimitError,
  SlotTakenError,
  type AppointmentRepository,
  type ChangedAppointment,
  type UpcomingAppointment,
} from '../repositories/appointmentRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import {
  CANCEL_APPOINTMENT_FUNCTION_NAME,
  FIND_MY_APPOINTMENTS_FUNCTION_NAME,
  RESCHEDULE_APPOINTMENT_FUNCTION_NAME,
} from '../vapi/toolNames.js';
import {
  errorResult,
  okResult,
  type ToolCallRequest,
  type ToolCallResult,
} from '../vapi/toolCallsMessage.js';
import { toolWebhook, type WebhookContext } from './voiceWebhook.js';

export const FIND_MY_APPOINTMENTS_PATH = '/find-my-appointments';
export const CANCEL_APPOINTMENT_PATH = '/cancel-appointment';
export const RESCHEDULE_APPOINTMENT_PATH = '/reschedule-appointment';

/** At most this many bookings are listed to the caller. */
const MAX_LISTED_APPOINTMENTS = 5;
/** How far into a caller's bookings a change may reach (generous: ids come from a list of 5). */
const LOOKUP_LIMIT = 50;

export const CANCELLED_PREFIX = 'Cancelled.';
export const RESCHEDULED_PREFIX = 'Rescheduled.';

const NOT_AVAILABLE_FOR_CLIENT =
  'Changing appointments by phone is not available here. Tell the caller you cannot do that and ' +
  'offer a staff callback instead.';
const NO_CALLER_NUMBER =
  'This call carries no caller phone number, so no appointment can be looked up or changed. ' +
  'Say you could not find an appointment and offer a staff callback.';
const NOT_FOUND =
  'No upcoming appointment of this caller matches that. Do not guess another one: say the change ' +
  'could not be made and offer a staff callback.';
const ONE_CHANGE_PER_CALL =
  'Only one change per call is allowed, and this call has already made one. Say you cannot make ' +
  'another change in this call and offer a staff callback.';
// Same wording as book_appointment: "for a new time" invited the model to invent one (test batch
// 2026-11-09, X02). check_availability on the same date and time returns the times that are open.
const NO_LONGER_AVAILABLE =
  'That time is no longer available. Call check_availability again with the same date and time ' +
  'to get the times that are open.';
const SAME_SLOT =
  'The appointment already has that date and time. Ask the caller for a different one.';
const TIME_PASSED =
  'That date and time has already passed. Ask the caller for a later date and time, then call ' +
  'check_availability for it.';
const NONE_FOUND =
  "No upcoming appointment was found for this caller's phone number. Say you could not find one " +
  'and offer a staff callback; do not guess or ask for another number.';

export interface AppointmentChangeRouteDeps {
  resolver: AssistantResolver;
  appointments: AppointmentRepository;
  /** Tells staff (and the caller) about a change. Omitted = nobody is notified. */
  bookingNotifier?: BookingNotifier;
  /** The clock; tests pin it. */
  now?: () => Date;
}

const appointmentIdSchema = z.uuid();
/** `2026-02-31` has the right shape but is not a day (Date.UTC would roll it into March). */
function isRealCalendarDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(value);
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(isRealCalendarDate, 'must be a real calendar date');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM, 24-hour');

const cancelArgumentsSchema = z.object({ appointmentId: appointmentIdSchema });
const rescheduleArgumentsSchema = z.object({
  appointmentId: appointmentIdSchema,
  date: dateSchema,
  time: timeSchema,
});

/** Names the invalid field only — never echoes the value back into logs or the model. */
function invalidFields(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'arguments')))].join(', ');
}

const invalidArguments = (call: ToolCallRequest, error: z.ZodError): ToolCallResult => {
  const fields = invalidFields(error);
  // The id is never the caller's to give: send the model back to the lookup, not to the caller.
  return errorResult(
    call,
    fields.includes('appointmentId')
      ? `Invalid or missing: ${fields}. Call find_my_appointments again and use the id it returns; ` +
          'do not ask the caller for an id.'
      : `Invalid or missing: ${fields}. Ask the caller to repeat it, then try again.`,
  );
};

const cancelledText = (changed: ChangedAppointment): string =>
  `${CANCELLED_PREFIX} The appointment on ${dateWithWeekday(changed.oldDate)} at ` +
  `${changed.oldTime} is cancelled.`;

const rescheduledText = (date: string, time: string): string =>
  `${RESCHEDULED_PREFIX} The appointment is now on ${dateWithWeekday(date)} at ${time}.`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Thursday 2026-11-12" — the weekday saves the model from working it out (and getting it wrong). */
function dateWithWeekday(isoDate: string): string {
  const weekday = WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
  return weekday ? `${weekday} ${isoDate}` : isoDate;
}

type Refusal = 'not_available' | 'no_number';

interface ChangeSession {
  config: ClientConfig;
  phone: string;
  now: ClinicNow;
}

/** Everything every change tool needs first: the client opted in, and the call has a number. */
function openSession(
  context: WebhookContext,
  now: () => Date,
): ChangeSession | { refusal: Refusal } {
  const config = loadClient(context.clientId);
  if (!config.reservationFlow?.changes) return { refusal: 'not_available' };
  // `callerPhone` is undefined — never the demo placeholder — when the call carried no number.
  if (!context.callerPhone) return { refusal: 'no_number' };
  return {
    config,
    phone: context.callerPhone,
    now: clinicNow(config.business.hours.timezone, now()),
  };
}

function refusalResult(call: ToolCallRequest, refusal: Refusal): ToolCallResult {
  return errorResult(
    call,
    refusal === 'not_available' ? NOT_AVAILABLE_FOR_CLIENT : NO_CALLER_NUMBER,
  );
}

function describeAppointment(entry: UpcomingAppointment, index: number): string {
  const service = entry.serviceName ?? 'service not recorded';
  return (
    `${index + 1}. id: ${entry.id} — ${dateWithWeekday(entry.appointmentDate)} at ` +
    `${entry.appointmentTime}, ${service}`
  );
}

/**
 * The booking was saved as changed; telling people is best-effort and never rejects. Awaited, not
 * fire-and-forget: a serverless function may be frozen the moment the response is sent.
 */
async function notifyChangedSafely(
  notifier: BookingNotifier | undefined,
  change: AppointmentChangeNotification,
): Promise<void> {
  try {
    await notifier?.notifyChanged(change);
  } catch (error) {
    logger.error('change notifier threw', {
      clientId: change.clientId,
      appointmentId: change.appointmentId,
      event: change.kind,
      ...summarizeError(error),
    });
  }
}

function changeNotification(
  kind: AppointmentChangeNotification['kind'],
  context: WebhookContext,
  changed: ChangedAppointment,
): AppointmentChangeNotification {
  return {
    kind,
    clientId: context.clientId,
    appointmentId: changed.id,
    callId: context.callId,
    reservationNumber: changed.reservationNumber,
    language: context.language,
    patientName: changed.patientName ?? '',
    serviceName: changed.serviceName,
    date: changed.newDate ?? changed.oldDate,
    time: changed.newTime ?? changed.oldTime,
    oldDate: changed.oldDate,
    oldTime: changed.oldTime,
    ...(context.callerPhone ? { callerPhone: context.callerPhone } : {}),
  };
}

export function appointmentChangesRouter(deps: AppointmentChangeRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  router.post(
    FIND_MY_APPOINTMENTS_PATH,
    toolWebhook({
      toolName: FIND_MY_APPOINTMENTS_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const session = openSession(context, now);
        if ('refusal' in session) {
          // A call with no number simply has nothing to find; only a client that has not opted in is an error.
          return session.refusal === 'no_number'
            ? okResult(call, NONE_FOUND)
            : refusalResult(call, session.refusal);
        }

        // One more than is listed, to know whether the list is cut short.
        const found = await deps.appointments.listUpcomingForPhone(
          context.clientId,
          session.phone,
          session.now,
          MAX_LISTED_APPOINTMENTS + 1,
        );
        logger.info('find_my_appointments', {
          clientId: context.clientId,
          callId: context.callId,
          found: found.length,
        });
        if (found.length === 0) return okResult(call, NONE_FOUND);

        const listed = found.slice(0, MAX_LISTED_APPOINTMENTS);
        const noun = listed.length === 1 ? 'appointment' : 'appointments';
        const truncated =
          found.length > listed.length
            ? ` Only the next ${MAX_LISTED_APPOINTMENTS} are listed; the caller has more.`
            : '';
        return okResult(
          call,
          [
            `Found ${listed.length} upcoming ${noun} for this caller's phone number, soonest ` +
              `first. Read back only the date, time and service; never say an id aloud.${truncated}`,
            ...listed.map(describeAppointment),
          ].join('\n'),
        );
      },
    }),
  );

  router.post(
    CANCEL_APPOINTMENT_PATH,
    toolWebhook({
      toolName: CANCEL_APPOINTMENT_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = cancelArgumentsSchema.safeParse(call.args);
        if (!parsed.success) return invalidArguments(call, parsed.error);
        const session = openSession(context, now);
        if ('refusal' in session) return refusalResult(call, session.refusal);

        let changed: ChangedAppointment | undefined;
        try {
          changed = await deps.appointments.cancel({
            clientId: context.clientId,
            appointmentId: parsed.data.appointmentId,
            phone: session.phone,
            callId: context.callId,
            now: session.now,
          });
        } catch (error) {
          if (error instanceof ChangeLimitError) return errorResult(call, ONE_CHANGE_PER_CALL);
          throw error;
        }
        if (!changed) {
          // A call delivered twice finds nothing to cancel the second time — repeat the outcome.
          const earlier = await deps.appointments.findChangeInCall(
            context.clientId,
            context.callId,
            parsed.data.appointmentId,
            session.phone,
          );
          return earlier && earlier.newDate === undefined
            ? okResult(call, cancelledText(earlier))
            : errorResult(call, NOT_FOUND);
        }

        logger.info('appointment cancelled', {
          clientId: context.clientId,
          callId: context.callId,
          appointmentId: changed.id,
        });
        await notifyChangedSafely(
          deps.bookingNotifier,
          changeNotification('cancelled', context, changed),
        );
        return okResult(call, cancelledText(changed));
      },
    }),
  );

  router.post(
    RESCHEDULE_APPOINTMENT_PATH,
    toolWebhook({
      toolName: RESCHEDULE_APPOINTMENT_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const parsed = rescheduleArgumentsSchema.safeParse(call.args);
        if (!parsed.success) return invalidArguments(call, parsed.error);
        const { appointmentId, date, time } = parsed.data;
        const session = openSession(context, now);
        if ('refusal' in session) return refusalResult(call, session.refusal);

        // Only this caller's own upcoming bookings can be found here — the same filter the write uses.
        const upcoming = await deps.appointments.listUpcomingForPhone(
          context.clientId,
          session.phone,
          session.now,
          LOOKUP_LIMIT,
        );
        const mine = upcoming.find((entry) => entry.id === appointmentId);
        if (!mine) return errorResult(call, NOT_FOUND);
        if (mine.appointmentDate === date && mine.appointmentTime === time) {
          // Either a pointless "move", or this very call already moved it here (a repeated tool call).
          const earlier = await deps.appointments.findChangeInCall(
            context.clientId,
            context.callId,
            appointmentId,
            session.phone,
          );
          return earlier?.newDate === date && earlier.newTime === time
            ? okResult(call, rescheduledText(date, time))
            : errorResult(call, SAME_SLOT);
        }
        if (`${date} ${time}` <= `${session.now.date} ${session.now.time}`) {
          return errorResult(call, TIME_PASSED);
        }

        // The same re-check a booking gets: a time check_availability never cleared is refused.
        const taken = await deps.appointments.listTakenTimes(context.clientId, date);
        if (!checkAvailability(session.config, date, time, taken).requestedAvailable) {
          return errorResult(call, NO_LONGER_AVAILABLE);
        }

        let changed: ChangedAppointment | undefined;
        try {
          changed = await deps.appointments.reschedule({
            clientId: context.clientId,
            appointmentId,
            phone: session.phone,
            callId: context.callId,
            now: session.now,
            newDate: date,
            newTime: time,
          });
        } catch (error) {
          if (error instanceof SlotTakenError) return errorResult(call, NO_LONGER_AVAILABLE);
          if (error instanceof ChangeLimitError) return errorResult(call, ONE_CHANGE_PER_CALL);
          throw error;
        }
        if (!changed) return errorResult(call, NOT_FOUND);

        logger.info('appointment rescheduled', {
          clientId: context.clientId,
          callId: context.callId,
          appointmentId: changed.id,
        });
        await notifyChangedSafely(
          deps.bookingNotifier,
          changeNotification('rescheduled', context, changed),
        );
        return okResult(call, rescheduledText(date, time));
      },
    }),
  );

  return router;
}
