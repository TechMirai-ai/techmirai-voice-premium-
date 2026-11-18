/**
 * The consultation flow, for a client with a `consultation` section: it REPLACES the callback flow
 * (such a client has no `request_callback` tool). Every spoken line comes from
 * `consultation.scripts` and every language is served by the same code — no language is named.
 *
 * The hard rules (what may be saved, who gets a text) are enforced by the server in
 * src/routes/requestConsultation.ts; this section only makes the model behave sensibly around them.
 */
import type { ClientConfig } from '../config/schema.js';
import type { ConsultationScriptKey } from '../config/consultationSchema.js';
import {
  CONFIRMATION_ACK_INSTRUCTIONS,
  fillClinicPlaceholders,
  pick,
  scriptLine,
} from './promptShared.js';
import { END_CALL_FUNCTION_NAME, REQUEST_CONSULTATION_FUNCTION_NAME } from './toolNames.js';

/** One consultation script line for `language`, with [[clinicName]], [[contactHours]] and [[contactEmail]] filled. */
export function consultationLine(
  config: ClientConfig,
  language: string,
  key: ConsultationScriptKey,
): string {
  const consultation = config.consultation;
  if (!consultation) return '';
  const hours = pick(consultation.contactHours, language);
  return fillClinicPlaceholders(config, language, pick(consultation.scripts[key], language))
    .replaceAll('[[contactHours]]', hours)
    .replaceAll('[[contactEmail]]', consultation.contactEmail);
}

/** Empty when the client has no `consultation` section. */
export function consultationSection(config: ClientConfig, language: string): string[] {
  const consultation = config.consultation;
  if (!consultation) return [];

  const tool = REQUEST_CONSULTATION_FUNCTION_NAME;
  const line = (key: ConsultationScriptKey): string => consultationLine(config, language, key);
  const hours = pick(consultation.contactHours, language);

  return [
    [
      'Consultation requests (this is the only thing you take for staff — there is no "callback" ' +
        'here; wherever another instruction says to offer a staff callback, it means this flow):',
      `Staff contact callers: ${hours}. Say it exactly like that — it is the only statement about ` +
        'when staff are reachable; never add anything about public holidays, a day, or a time of ' +
        'your own.',
      'Offer it when the caller wants to talk to someone, wants a meeting or a demo, asks to be ' +
        `put through to a person. Say: "${scriptLine(config, language, 'staffContactOffer')}" If you ` +
        `cannot answer a question from the information below, say: "${scriptLine(config, language, 'noMatch')}"`,
      'Transfer: this phone line cannot transfer calls. Never offer, promise or imply that you ' +
        'can connect the caller to a person or forward the call, whatever the information below ' +
        'says about forwarding in general (describing what the product can do for businesses is ' +
        `fine). If the caller asks to be connected, say: "${line('noTransfer')}" and offer this flow.`,
      'Never say a phrase like "please wait" or "let me check" unless you are calling a tool in ' +
        'that exact same turn.',
      'One item per turn, skipping anything the caller already gave you:',
      `1. Name: say "${line('askName')}" A first name or short name is enough. In Japanese, use ` +
        "katakana so it's pronounced exactly as heard, and never ask how it's written in " +
        "kanji. In English, ask them to spell it only if it's unusual or unclear. Do NOT ask why " +
        'they are calling; keep a reason only if the caller volunteers one.',
      `2. Name read-back, as its own turn: say "${line('confirmName')}" with the name in place of ` +
        '[[name]], never speaking the placeholder. Wait for a clear yes before anything else; on ' +
        'a no or a correction, fix the name and read it back again. That turn is only the ' +
        'read-back: no tool call and no next question.',
      `3. Contact number: ask, as its own turn, "${line('askContactNumber')}" Never read out the ` +
        'number they are calling from.',
      `4. If they say yes: call ${tool} with phone_source "caller_id" and the name. Do not pass a ` +
        `number. If the result says there is no caller ID, go to step 5.`,
      `5. If they want another number, or say the number is withheld (非通知, "caller ID not ` +
        `notified"), or the tool says there is no caller ID: ask, word for word, ` +
        `"${line('askSpokenNumber')}" then read it back as its own turn, "${line('confirmSpokenNumber')}" — substituting the ` +
        'number for [[number]], never speaking the placeholder. Say every digit on its own as a ' +
        'word, never as a combined number (never "ninety"): Japanese in katakana, English as ' +
        'words, grouped the way the caller said it. If the count looks wrong (a Japanese ' +
        'mobile number has 11 digits, a landline 10), ask for the number again instead. Wait for ' +
        `a clear yes; on a no or a correction, fix it and read it back again. Only after a yes call ` +
        `${tool} with phone_source "spoken", spoken_phone as digits, and the name.`,
      'Hearing the number: callers dictate digits in groups with pauses, so wait for the whole ' +
        'number and never cut in after a few digits. The transcript may mix Arabic digits and ' +
        'kanji numerals (零, 〇 and レイ are 0; 一 is 1, 二 2, 三 3, 四 4, 五 5, 六 6, 七 7, 八 8, ' +
        '九 9): count them all the same. A full stop or question mark in the middle of a digit ' +
        'sequence (for example after the 4th digit) is not the end of the number: keep counting ' +
        'across it as one sequence until you have a full group (11 digits for a mobile, 10 for a ' +
        'landline). Ask for the number again only when digits are really missing.',
      `6. If the caller will not give a number: take the name only and do NOT call ${tool}. Say: ` +
        `"${line('numberRefused')}"`,
      `7. After the tool call: if it succeeded, say "${line('saved')}" — then, ONLY if the tool ` +
        `result says a text message should arrive, add "${line('smsNote')}" (say "shortly", never ` +
        'a guarantee; if the result says none will be sent, say nothing about a text). If it ' +
        `failed, say "${line('failed')}" — and do NOT say staff will contact them. Never speak ` +
        'any placeholder text.',
      `8. Then ask: "${scriptLine(config, language, 'anythingElse')}" — same as after answering a ` +
        'question. Do not go quiet and wait for the caller to speak first.',
      CONFIRMATION_ACK_INSTRUCTIONS,
      `Never call ${tool} before a clear yes to the name read-back and a clear yes to the ` +
        'contact-number question (or, for a spoken number, a clear yes to the number read-back). ' +
        `If the call ends before that, never call it. Call ` +
        `it at most once per call; after it has succeeded, never call it again or take another request.`,
      `After a successful request the call goes on normally; end it only as the "Ending the call" ` +
        `section says (${END_CALL_FUNCTION_NAME} is only for ending).`,
    ].join('\n'),
  ];
}
