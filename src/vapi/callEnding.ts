/**
 * Platform-level ways a call ends that do NOT depend on the model choosing to call the built-in
 * `endCall` tool (VAPI-FACTS.md VP-7 R8). The text-tester suite showed the model calling
 * `log_call_topic` + `endCall` in only 1 of 4 endings — the same reliability pattern as the
 * VP-6 goodbye and `confirmDetails` bugs — and no Vapi setting makes the model call a tool.
 *
 * Two mechanisms, both set on the assistant AND threaded through every handoff leg's
 * `assistantOverrides` (squad.ts), because a destination's own saved settings are not reliably
 * carried across a handoff (VP-6 R3):
 *
 *  - `endCallPhrases` — Vapi hangs up once the assistant has SAID one of the phrases in
 *    `languages.settings.<lang>.endCallPhrases`. Catches the observed failure where the model
 *    speaks a farewell instead of calling the tools.
 *  - a `customer.speech.timeout` hook that runs the built-in `endCall` after a long silence, so a
 *    call the model never closes still ends.
 *
 * Neither can be exercised by the local text-tester and neither is proven by a real call yet.
 */
import type { ClientConfig } from '../config/schema.js';
import { fillClinicPlaceholders, pick } from './promptTemplate.js';
import type { VapiSilenceHangupHook } from './types.js';

/**
 * Graduated caller-silence flow (VP-16), replacing the flat 20s hang-up (VP-7 R10, itself a
 * shortening of the original 40s). Each step is its own `customer.speech.timeout` hook; Vapi's docs
 * describe staggered hooks for exactly this. Offsets are seconds of caller silence counted from
 * when the assistant stopped speaking, read as ABSOLUTE (VAPI-FACTS.md VP-16 R1). Specified by the
 * owner: 4s, +5s, +5s, and a hang-up 3s after the announcement. Whether a hook's own `say` restarts
 * the clock is undocumented and is what the first real call checks; if it does, switch these to
 * the gaps themselves.
 */
const SILENCE_GAP_SECONDS = {
  repeatQuestion: 4,
  check1: 5,
  check2: 5,
  /**
   * ASSUMED TIMING — NOT FROM THE OWNER. The work order gives no delay between the second check and
   * the end announcement; 5s mirrors the other gaps. Confirm during the real-call test.
   */
  announceEnd: 5,
  hangUp: 3,
} as const;

/**
 * Step 1 is written by the model from the actual conversation, so the repeat is the real last
 * question and never a generic line (the work order's hard requirement). Language-neutral on
 * purpose: "the language of the call" keeps it correct for every language and handoff leg.
 */
const REPEAT_LAST_QUESTION_PROMPT =
  'The caller has gone quiet. Repeat the last question you asked them, in the same language and ' +
  'the same polite tone, using fresh wording. Say only that question — no greeting, no apology, ' +
  'no extra commentary. If your last turn was not a question, gently ask how you can help.';

/** `language`'s configured hang-up phrases, or `undefined` when the client sets none. */
export function endCallPhrasesFor(config: ClientConfig, language: string): string[] | undefined {
  return config.languages.settings[language]?.endCallPhrases;
}

function silenceHook(
  name: string,
  timeoutSeconds: number,
  action: VapiSilenceHangupHook['do'][number],
): VapiSilenceHangupHook {
  return {
    on: 'customer.speech.timeout',
    name,
    options: { timeoutSeconds, triggerMaxCount: 1, triggerResetMode: 'onUserSpeech' },
    do: [action],
  };
}

function exactLine(config: ClientConfig, language: string, line: Record<string, string>) {
  return {
    type: 'say',
    exact: fillClinicPlaceholders(config, language, pick(line, language)),
  } as const;
}

/**
 * The five escalating hooks, in order: repeat the last question, two "are you there?" checks, an
 * announcement that the call is ending, then the built-in `endCall` (so call-end bookkeeping is
 * the same path as any other ending). Each fires once and only while the caller stays silent.
 */
export function silenceHooks(config: ClientConfig, language: string): VapiSilenceHangupHook[] {
  const gap = SILENCE_GAP_SECONDS;
  const at1 = gap.repeatQuestion;
  const at2 = at1 + gap.check1;
  const at3 = at2 + gap.check2;
  const at4 = at3 + gap.announceEnd;
  const at5 = at4 + gap.hangUp;

  return [
    silenceHook('silence-repeat-question', at1, {
      type: 'say',
      prompt: REPEAT_LAST_QUESTION_PROMPT,
    }),
    silenceHook('silence-check-1', at2, exactLine(config, language, config.scripts.silenceCheck1)),
    silenceHook('silence-check-2', at3, exactLine(config, language, config.scripts.silenceCheck2)),
    silenceHook(
      'silence-announce-end',
      at4,
      exactLine(config, language, config.scripts.silenceEnding),
    ),
    silenceHook('silence-hangup', at5, { type: 'tool', tool: { type: 'endCall' } }),
  ];
}
