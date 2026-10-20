/**
 * Prompt sections that only some clients use (VP-19): the safety-emergency path and the `simple`
 * booking flow. Each returns `[]` when the client's config doesn't enable it, so a client without
 * them gets exactly the prompt it had before these existed. Split from `promptTemplate.ts` to keep
 * that file under the size limit; the two share `promptShared.ts`, never each other.
 */
import type { ClientConfig } from '../config/schema.js';
import type { ReservationService } from '../repositories/reservationServiceRepository.js';
import {
  CONFIRMATION_ACK_INSTRUCTIONS,
  businessNoun,
  contactNumberInstructions,
  fillClinicPlaceholders,
  nameConfirmationInstructions,
  pick,
  reservationClosingInstructions,
  scriptLine,
} from './promptShared.js';
import {
  BOOK_APPOINTMENT_FUNCTION_NAME,
  CHECK_AVAILABILITY_FUNCTION_NAME,
  END_CALL_FUNCTION_NAME,
  LOG_CALL_TOPIC_FUNCTION_NAME,
  REQUEST_CALLBACK_FUNCTION_NAME,
} from './toolNames.js';

/**
 * The safety-emergency path (e.g. a gas smell). It sits first among the flows because it overrides
 * all of them. It is a script, not a system: the assistant says the client's fixed wording, takes a
 * minimal callback flagged with `emergency.callbackReason` (which also flags the dashboard summary,
 * see callReporting.ts), and ends. Nothing is paged or dispatched, so the prompt says so plainly —
 * the model must never claim otherwise.
 */
export function emergencySection(config: ClientConfig, language: string): string[] {
  const emergency = config.emergency;
  if (!emergency) return [];

  const triggers = emergency.triggers.map((trigger) => `"${trigger}"`).join(', ');
  const script = fillClinicPlaceholders(config, language, pick(emergency.script, language));

  return [
    [
      `Safety emergency — overrides every other instruction and flow: if at ANY point the caller ` +
        `reports ${emergency.label} (for example: ${triggers}, or anything clearly similar), ` +
        'stop whatever you were doing at once — booking, billing, an FAQ answer — and do this:',
      `1. Say this exactly, word for word: "${script}" — and in that same reply, ask: ` +
        `"${scriptLine(config, language, 'askName')}"`,
      '2. Add nothing else of your own: no safety instructions, no diagnosis, no reassurance that ' +
        'the situation is safe, no questions about the cause. You do not know the correct ' +
        'emergency procedure, so never improvise one.',
      '3. Nothing has been notified, paged or dispatched — you have no way to do that. Never say or ' +
        'imply that anyone has been alerted, that help or a technician is on the way, or give any ' +
        'time for a visit or a call.',
      `4. As soon as the caller answers, take the callback with fewer steps than the normal one: ` +
        'accept the name as given (no read-back, no contact-number question — this is an ' +
        'emergency; if they will not give a name, use "Unknown"), and call ' +
        `${REQUEST_CALLBACK_FUNCTION_NAME} right away with exactly "${emergency.callbackReason}" ` +
        'as the reason.',
      `5. After the tool call: if it succeeded, say "${scriptLine(config, language, 'callbackSaved')}"; ` +
        `if it failed, say "${scriptLine(config, language, 'callbackFailed')}". Do not ask whether ` +
        'there is anything else. Then end the call with the two silent classification calls ' +
        `(${LOG_CALL_TOPIC_FUNCTION_NAME}, then ${END_CALL_FUNCTION_NAME}), outcome "unresolved".`,
      '6. If the caller says it was a false alarm or changes their mind, still finish the steps ' +
        'above — a safety report is never silently dropped.',
    ].join('\n'),
  ];
}

/**
 * The `simple` booking flow: no first-time / returning split and no record lookup — service, date
 * and time, availability, an optional address, name, then book. Used by clients whose callers are
 * not "patients" (VP-19: gas opening / closing visits). The address, when asked for, is not a tool
 * argument: the call summary captures it from the conversation (callReporting.ts).
 */
export function simpleReservationSection(
  config: ClientConfig,
  language: string,
  services: ReservationService[],
): string[] {
  if (services.length === 0) return [];

  const address = config.reservationFlow?.askServiceAddress;
  const noun = businessNoun(config);
  const addressStep = address
    ? [
        `4. Ask, as its own turn: "${pick(address, language)}" — hear it clearly once. If speech ` +
          'recognition is uncertain, ask the caller to repeat or spell the unclear part; never ' +
          'guess. Do not read the whole address back unless the caller asks. It is not an ' +
          'argument of any tool; it is kept in the call record, so just make sure you heard it.',
      ]
    : [];
  const nextStep = (offset: number): number => (address ? offset + 1 : offset);

  return [
    [
      `Reservations: the ${noun}'s own booking system, separate from callback requests above — ` +
        'use this when the caller wants to book an appointment, not just leave a message for ' +
        'staff to call back. This flow asks only for a first name or short name — never a full ' +
        'formal name, an email address or a phone number. The name is read back and needs an ' +
        'explicit yes, and then you ask whether staff may contact the number the caller is ' +
        'calling from, which also needs an explicit yes. There is no first-time / returning ' +
        'split: ask every caller the same questions.',
      'Never say a phrase like "please wait" or "let me check" unless you are calling a tool in ' +
        'that exact same turn. If you are not confident you have a clear, complete date and time ' +
        '(or whatever else the tool needs), do not say you are checking or booking anything — ask ' +
        'a clarifying question instead. Saying you will do something and then not doing it leaves ' +
        'the caller stranded in silence.',
      `1. "${scriptLine(config, language, 'reservationAskService')}" — offer the services listed ` +
        'in Reservation services below, matching what the caller says to one of them. If the ' +
        'caller has already made clear which one they want, do not ask again — confirm it in a ' +
        'few words and move on.',
      `2. "${scriptLine(config, language, 'reservationAskDateTime')}"`,
      `3. Call ${CHECK_AVAILABILITY_FUNCTION_NAME} with the date as YYYY-MM-DD and the time as ` +
        '24-hour HH:MM, worked out from what the caller said. Never tell the caller a time is ' +
        'available or unavailable, and never assume a date is too far off to check, without ' +
        'calling this tool first. If it comes back unavailable, offer the alternative time(s) it ' +
        'gives you and wait for the caller to pick one, or offer a different date instead. ' +
        'Once the caller picks one of the offered times, names a different date, or names a ' +
        `different time, call ${CHECK_AVAILABILITY_FUNCTION_NAME} again for that exact choice ` +
        'before treating it as confirmed — an alternative merely being offered is NOT the same ' +
        'as it being confirmed available. Only move on once a check_availability call has ' +
        'actually returned the time as available.',
      ...addressStep,
      `${nextStep(4)}. Ask for the name — say this exact line, word for word: "${scriptLine(config, language, 'askName')}"`,
      `${nextStep(5)}. ${nameConfirmationInstructions(config, language)}`,
      `${nextStep(6)}. ${contactNumberInstructions(config, language)}`,
      `${nextStep(7)}. ${CONFIRMATION_ACK_INSTRUCTIONS}`,
      `${nextStep(8)}. Call ${BOOK_APPOINTMENT_FUNCTION_NAME} only after a clear yes to both the ` +
        'name confirmation and the contact-number question, with the chosen service id, the ' +
        "confirmed date/time, and the caller's confirmed name. There is no phone-number " +
        'argument and no returning-patient argument.',
      `${nextStep(9)}. ${reservationClosingInstructions(config, language)}`,
    ].join('\n'),
  ];
}
