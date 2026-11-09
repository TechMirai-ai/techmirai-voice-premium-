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
  formatWeeklyHours,
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
  LOOKUP_POSTAL_CODE_FUNCTION_NAME,
  REQUEST_CALLBACK_FUNCTION_NAME,
  TRANSFER_TO_STAFF_FUNCTION_NAME,
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
 * VP-24: live transfer to staff. Returns `[]` unless the client has an enabled `transfer` block.
 *
 * Two triggers, both gated on clinic hours (reusing `business.hours`, never a second definition):
 *  - an explicit request for a person → call `transfer_to_staff` at once, no confirmation;
 *  - something the assistant cannot handle → take the callback FIRST (the safety net: on Telnyx a
 *    failed transfer cannot return the caller, docs/VAPI-FACTS.md VP-24), then offer, and transfer
 *    only on a clear yes.
 * The announcement is spoken by the platform when the tool runs (see transferTool.ts), so the
 * model is told to say nothing of its own before calling it.
 *
 * Hours are judged by the model against "Today" at the end of the prompt so it behaves sensibly
 * (offers, wording); the real gate is server-side — src/routes/transferToStaff.ts refuses outside
 * hours, over the daily cap and on a second transfer, whatever the model does.
 */
export function transferSection(config: ClientConfig, language: string): string[] {
  const transfer = config.transfer;
  if (!transfer?.enabled) return [];

  const noun = businessNoun(config);
  const { hours } = config.business;
  const line = (key: keyof typeof transfer.scripts): string =>
    fillClinicPlaceholders(config, language, pick(transfer.scripts[key], language));
  const callback = REQUEST_CALLBACK_FUNCTION_NAME;

  return [
    [
      'Staff transfer (connecting the caller to a staff member by phone):',
      ...(config.emergency ? ['The safety emergency path above overrides this section.'] : []),
      `Staff can answer the phone only while the ${noun} is open (${hours.timezone}): ` +
        `${formatWeeklyHours(hours.weekly)}${hours.closedOnNationalHolidays ? '; closed on national holidays' : ''}. ` +
        `Use Today (below) to decide: "staff reachable" means the current time is inside today's ` +
        `opening hours and at least ${transfer.closingBufferMinutes} minutes before closing. ` +
        'If you are unsure, or the caller says today is a holiday, treat staff as not reachable.',
      `The ${TRANSFER_TO_STAFF_FUNCTION_NAME} tool is the only way to connect the caller. Never say ` +
        'you are connecting, transferring or putting them through unless you call the tool in ' +
        'that same turn — and when you call it, your turn must contain ONLY the tool call: no ' +
        'words before it, none after it, not even a short acknowledgement (this is about that one ' +
        'turn: when the result says the transfer has started, say nothing more; if it returns an ' +
        'error, rule 3 applies). The system speaks the announcement itself, so anything you add ' +
        'would be said twice.',
      '1. The caller asks to speak to a person — staff, a human, a receptionist, someone at the ' +
        `${noun}, in any language (an explicit request, not a question you could not answer):`,
      `   - Staff reachable: call ${TRANSFER_TO_STAFF_FUNCTION_NAME} immediately. Do not ask for ` +
        'confirmation and do not collect a name first.',
      `   - Staff not reachable: say "${line('closedOffer')}" then "${scriptLine(config, language, 'staffContactOffer')}" ` +
        'and continue with the Callback requests steps. Never offer a transfer.',
      `2. You cannot answer what the caller needs (the situation for "${scriptLine(config, language, 'noMatch')}") and staff are reachable:`,
      `   a. Do the Callback requests steps first, through ${callback}. Do NOT offer a transfer ` +
        `before ${callback} has succeeded: the saved callback is the safety net if the transfer ` +
        'cannot be completed.',
      '   b. After it succeeds, say the saved line, then make the transfer offer exactly once, as ' +
        'step 8 of the Callback requests steps says (it replaces the usual closing question).',
      `   c. An explicit yes: call ${TRANSFER_TO_STAFF_FUNCTION_NAME} right away. A clear no: accept ` +
        `it, say staff will call back, and ask: "${scriptLine(config, language, 'anythingElse')}". An ambiguous ` +
        'reply ("that\'s fine", "OK"): check explicitly. Never offer a second time unless the ' +
        'caller asks for staff themselves.',
      `   d. If ${callback} failed or the caller declined the callback, do not offer a transfer ` +
        '(they can still ask for staff themselves — rule 1).',
      `   If staff are not reachable, never mention a transfer: take the callback only.`,
      `3. If ${TRANSFER_TO_STAFF_FUNCTION_NAME} returns an error: say "${line('failed')}" and take ` +
        `the callback if none was saved yet; never retry the tool.`,
    ].join('\n'),
  ];
}

/**
 * VP-21: call-centre wording and guardrails, from `promptOverrides.phraseBank` / `refusalPatterns` /
 * `guardrails`. Wording only — it adds no tool and no behaviour; every refusal still ends in the
 * existing staff-callback offer. Returns `[]` when none is set, so other clients are unchanged.
 */
export function callCenterWordingSection(config: ClientConfig, language: string): string[] {
  const overrides = config.promptOverrides;
  const phrases = overrides?.phraseBank ? pick(overrides.phraseBank, language) : '';
  const refusals = overrides?.refusalPatterns ? pick(overrides.refusalPatterns, language) : '';
  const guardrails = overrides?.guardrails;
  if (!phrases && !refusals && !guardrails) return [];

  return [
    [
      'Call-centre wording and guardrails:',
      ...(phrases
        ? [
            'Phrase bank — draw on these when the situation fits, vary them, and never recite a ' +
              `list or use the same one twice in a row: ${phrases}`,
            '- Ask one question at a time. Never read a checklist of required details aloud — ask ' +
              'for the next missing detail only.',
          ]
        : []),
      ...(refusals
        ? [
            'Declining gracefully — for requests you cannot do, sound handled, not fumbled. ' +
              'Adapt the wording to the call; each ends in the staff-callback offer. ' +
              `Examples: ${refusals}`,
          ]
        : []),
      ...(guardrails ? [`Guardrails: ${guardrails}`] : []),
    ].join('\n'),
  ];
}

/**
 * VP-20: step 4 of the `simple` flow when the client configures `postalCodeLookup`: postal code,
 * read back and confirmed digit by digit, looked up server-side, area confirmed, then only the
 * building and room are free text. Any failure falls back to the spoken full address. Returns
 * `undefined` when the client doesn't configure it, so the plain spoken-address step is kept.
 */
function postalCodeAddressInstructions(config: ClientConfig, language: string): string | undefined {
  const flow = config.reservationFlow;
  const lookup = flow?.postalCodeLookup;
  if (!lookup || !flow.askServiceAddress) return undefined;

  return [
    'Collect the service address in these parts, each as its own turn:',
    `(a) Ask for the postal code: "${pick(lookup.askPostalCode, language)}" Then read the seven ` +
      'digits back one digit at a time, in the usual groups of three and four, and ask for an ' +
      'explicit yes. If the caller says no or corrects you, take the corrected digits and read ' +
      'them back again; never guess a digit.',
    `(b) After a clear yes, call ${LOOKUP_POSTAL_CODE_FUNCTION_NAME} with the seven digits ` +
      '(digits only, no hyphen). Never state or guess an area without calling it.',
    `(c) If it returns an area, say: "${pick(lookup.confirmArea, language)}" — you fill ` +
      '[[postalCode]] (as three digits, hyphen, four digits) and [[area]] (prefecture, city and ' +
      'town, in the language of this call; use the readings the tool gives for the spoken form), ' +
      'never speaking the placeholder text itself. If it lists several areas, offer them and ' +
      'let the caller pick. Wait for an explicit yes. If the caller says it is wrong, ask for ' +
      'the postal code once more and repeat (a)-(c); a second mismatch goes to (d).',
    `(d) If ${LOOKUP_POSTAL_CODE_FUNCTION_NAME} returns an error, or the caller does not know ` +
      `their postal code, or the area is wrong twice: say "${pick(lookup.lookupFailed, language)}" ` +
      `and then ask "${pick(flow.askServiceAddress, language)}" and take the full spoken ` +
      'address. Hear it clearly once; if speech recognition is uncertain, ask the caller to ' +
      'repeat or spell the unclear part; never guess. Then skip (e) and (f). Never leave the ' +
      'caller stuck and never end the booking because of a failed lookup.',
    `(e) Otherwise ask: "${pick(lookup.askBuildingAndRoom, language)}" — only the building ` +
      'name and room number are spoken; the prefecture, city and town come from the lookup and ' +
      'are not asked again. Hear it clearly once; if speech recognition is uncertain, ask the ' +
      'caller to repeat or spell the unclear part; never guess. If there is no building or ' +
      'room, accept that.',
    '(f) Say the complete address once, in one sentence, as: postal code, prefecture, city, ' +
      'town, then building and room exactly as heard. Do not ask for another confirmation of it ' +
      '(the caller can correct you if it is wrong), and go straight on to the next step in the ' +
      'same turn. The address is not an argument of any tool; saying it aloud is what puts the ' +
      'whole address in the call record.',
  ].join('\n');
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
  const spokenAddressStep =
    `Ask, as its own turn: "${address ? pick(address, language) : ''}" — hear it clearly once. ` +
    'If speech recognition is uncertain, ask the caller to repeat or spell the unclear part; ' +
    'never guess. Do not read the whole address back unless the caller asks. It is not an ' +
    'argument of any tool; it is kept in the call record, so just make sure you heard it.';
  const addressStep = address
    ? [`4. ${postalCodeAddressInstructions(config, language) ?? spokenAddressStep}`]
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
