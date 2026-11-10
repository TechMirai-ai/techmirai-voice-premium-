/**
 * VP-25: the prompt section for callers who want to cancel or reschedule a booking they made.
 * Present only for a client that opts in (`reservationFlow.changes`) and has bookable services —
 * the tools it names are rendered under the same conditions (render.ts), so the prompt never
 * mentions a tool the assistant does not have, and a client without it renders byte-identically.
 *
 * What the caller hears is the client's own wording (`reservationFlow.changes.scripts`); everything
 * else here is English instruction to the model, the same for every client. The server enforces the
 * rules that matter (whose booking, one change per call, real availability — see
 * src/routes/appointmentChanges.ts); this text only makes the conversation go the right way round.
 */
import type { ChangeScriptKey } from '../config/changesSchema.js';
import type { ClientConfig } from '../config/schema.js';
import type { ReservationService } from '../repositories/reservationServiceRepository.js';
import { fillClinicPlaceholders, pick, scriptLine } from './promptShared.js';
import {
  BOOK_APPOINTMENT_FUNCTION_NAME,
  CANCEL_APPOINTMENT_FUNCTION_NAME,
  CHECK_AVAILABILITY_FUNCTION_NAME,
  FIND_MY_APPOINTMENTS_FUNCTION_NAME,
  REQUEST_CALLBACK_FUNCTION_NAME,
  RESCHEDULE_APPOINTMENT_FUNCTION_NAME,
} from './toolNames.js';

const FIND = FIND_MY_APPOINTMENTS_FUNCTION_NAME;
const CANCEL = CANCEL_APPOINTMENT_FUNCTION_NAME;
const RESCHEDULE = RESCHEDULE_APPOINTMENT_FUNCTION_NAME;

export function appointmentChangeSection(
  config: ClientConfig,
  language: string,
  services: ReservationService[],
): string[] {
  const changes = config.reservationFlow?.changes;
  if (!changes || services.length === 0) return [];

  /** One of the client's change lines, clinic placeholders filled; `[[date]]` etc. are the model's to fill. */
  const line = (key: ChangeScriptKey): string =>
    `"${fillClinicPlaceholders(config, language, pick(changes.scripts[key], language))}"`;

  return [
    [
      'Changing or cancelling an existing appointment: when the caller wants to cancel, ' +
        'reschedule, move or change an appointment they already booked, use these steps instead of ' +
        'the booking steps above. Appointments are matched by the phone number the caller is ' +
        'calling from. Never ask for, repeat or accept a phone number, a name or a reservation ' +
        'number to look one up — you could not use it anyway. Only one change per call can be ' +
        'made: if the caller wants a second one, say you cannot do it in this call and offer a ' +
        'staff callback. Never say a phrase like "please wait" or "let me check" unless you are ' +
        'calling a tool in that exact same turn.',
      `1. Call ${FIND} (it takes no arguments) before you say anything about the caller's ` +
        'appointments. Never tell the caller what they have booked without calling it.',
      `2. If it says no upcoming appointment was found: say ${line('notFound')} — and if the ` +
        `caller says yes, follow the callback steps above (collect the name, then call ` +
        `${REQUEST_CALLBACK_FUNCTION_NAME} with a reason saying they wanted to cancel or change an ` +
        `appointment that could not be found). Do not call ${CANCEL}, ${RESCHEDULE} or ` +
        `${CHECK_AVAILABILITY_FUNCTION_NAME} in this case, and do not end on "not found" without ` +
        'offering the callback.',
      `3. If it found exactly one: read it back — ${line('found')} — filling [[date]], [[time]] ` +
        'and [[service]] from the result (leave the service out if it says "service not ' +
        'recorded"), never speaking the placeholder text itself — then stop and wait for an ' +
        'explicit yes that this is the right appointment. If the caller says no, or it is not ' +
        `theirs, change nothing: say ${line('failed')} and offer the callback.`,
      `4. If it found more than one: say ${line('askWhich')} — filling [[appointments]] with a ` +
        'brief spoken list (date and time, plus the service if it helps tell them apart) — and ' +
        'wait for the caller to say which. Then confirm that one as in step 3. Never say an id ' +
        'aloud; the ids are only for the tools.',
      `5. To cancel: once the caller has confirmed which appointment, ask ${line('confirmCancel')} ` +
        `and wait for an explicit yes. Only then call ${CANCEL} with that appointment's id.`,
      `6. To reschedule: once the caller has confirmed which appointment, ask ${line('askNewDateTime')} ` +
        `and wait for the caller's answer. Then call ${CHECK_AVAILABILITY_FUNCTION_NAME} with the new date as YYYY-MM-DD and time as ` +
        '24-hour HH:MM. If it is unavailable, offer only the alternatives it returns, and when the ' +
        `caller picks one call ${CHECK_AVAILABILITY_FUNCTION_NAME} again for that exact choice. ` +
        `Never name or suggest a time that ${CHECK_AVAILABILITY_FUNCTION_NAME} has not returned in ` +
        'this call. When a time is confirmed available, say the new date and time back and wait ' +
        `for an explicit yes, then call ${RESCHEDULE} with that appointment's id, the date and the ` +
        `time. Never call ${BOOK_APPOINTMENT_FUNCTION_NAME} for a reschedule — it would create a ` +
        'duplicate booking; the existing one is moved.',
      `7. After ${CANCEL} succeeds, say ${line('cancelled')} After ${RESCHEDULE} succeeds, say ` +
        `${line('rescheduled')} — filling [[date]] and [[time]] with the NEW date and time. Never ` +
        `say the reservation number. Then ask: "${scriptLine(config, language, 'anythingElse')}"`,
      `8. If ${RESCHEDULE} says the time is no longer available, call ` +
        `${CHECK_AVAILABILITY_FUNCTION_NAME} again right away with the same date and time and ` +
        'offer only what it returns. If it says the appointment already has that date and time, or ' +
        'that the date and time has passed, ask the caller for a different date and time and ' +
        `check it with ${CHECK_AVAILABILITY_FUNCTION_NAME}. For any other error — nothing matched, only one change per ` +
        `call, a system problem — say ${line('failed')} and offer the callback; never retry the ` +
        'same call and never say it was cancelled or changed when it was not.',
    ].join('\n'),
  ];
}
