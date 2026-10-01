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
import type { VapiSilenceHangupHook } from './types.js';

/**
 * How long the caller may stay silent, after the assistant stops speaking, before Vapi ends the
 * call. Originally 40s (VP-7 R8) to avoid cutting off a caller looking for a phone number or a
 * card. Lowered to 20s (VP-7 R10, 2026-10-01, project owner's call) after a real call showed the
 * model drop the log_call_topic/endCall chain and the caller hang up himself after ~25s of dead
 * air — shorter than the original 40s threshold ever got a chance to fire. Still long enough for
 * a short lookup pause, but short enough to beat observed real caller patience.
 */
export const SILENCE_HANGUP_SECONDS = 20;

/** `language`'s configured hang-up phrases, or `undefined` when the client sets none. */
export function endCallPhrasesFor(config: ClientConfig, language: string): string[] | undefined {
  return config.languages.settings[language]?.endCallPhrases;
}

/** Ends the call after `SILENCE_HANGUP_SECONDS` of silence; `endCallMessage` still plays the goodbye. */
export function silenceHangupHook(): VapiSilenceHangupHook {
  return {
    on: 'customer.speech.timeout',
    name: 'silence-hangup',
    options: {
      timeoutSeconds: SILENCE_HANGUP_SECONDS,
      triggerMaxCount: 1,
      triggerResetMode: 'onUserSpeech',
    },
    do: [{ type: 'tool', tool: { type: 'endCall' } }],
  };
}
