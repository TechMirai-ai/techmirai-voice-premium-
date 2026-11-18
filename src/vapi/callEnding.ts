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
import { DEFAULT_SILENCE_TIMINGS } from '../config/silenceTimingsSchema.js';
import { fillClinicPlaceholders, pick } from './promptTemplate.js';
import { SILENCE_END_CALL_FUNCTION_NAME } from './toolNames.js';
import type { VapiServerConfig, VapiSilenceHangupHook, VapiSilenceHookAction } from './types.js';

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

/** The announcement text for `language`, shared by the hook config and the silence-end route. */
export function silenceEndingLine(config: ClientConfig, language: string): string {
  return fillClinicPlaceholders(config, language, pick(config.scripts.silenceEnding, language));
}

/**
 * The server-driven announcement + hang-up (VP-16 R3). A hook's own `say` neither counts as
 * assistant speech for `endCallPhrases` nor suppresses the standard `endCallMessage` goodbye on the
 * following `endCall` (real calls, VP-16 R2), so the last step is a tool call to our server, which
 * uses Vapi's Live Call Control to speak the line and hang up in one platform operation.
 */
function silenceEndAction(server: VapiServerConfig): VapiSilenceHookAction {
  return {
    type: 'tool',
    tool: {
      type: 'function',
      async: true,
      function: {
        name: SILENCE_END_CALL_FUNCTION_NAME,
        description:
          'Announces that the call is ending because the caller is silent, then hangs up.',
        parameters: { type: 'object', properties: {} },
      },
      server,
    },
  };
}

/**
 * The five escalating hooks, in order: a fixed gentle nudge, two "are you there?" checks, the
 * server-driven announcement + hang-up (`silence_end_call`), then the built-in `endCall` as a
 * backstop if that did not end the call. Each fires once and only while the caller stays silent.
 */
export function silenceHooks(
  config: ClientConfig,
  language: string,
  silenceEndServer: VapiServerConfig,
): VapiSilenceHangupHook[] {
  // Per-client `silenceTimings` (client.yaml), else the shared defaults 4 / 9 / 14 / 19 / 31 s:
  // absolute seconds of caller silence since the assistant stopped speaking (VAPI-FACTS.md VP-16 R1).
  const timings = config.silenceTimings ?? DEFAULT_SILENCE_TIMINGS;
  const at1 = timings.nudgeAfterSeconds;
  const at2 = timings.firstCheckAfterSeconds;
  const at3 = timings.secondCheckAfterSeconds;
  const at4 = timings.announceEndAfterSeconds;
  const at5 = timings.hangUpAfterSeconds;

  return [
    // Step 1 is a FIXED per-language line (client.yaml `scripts.silenceRepeat`). It used to be a
    // model-written `say.prompt`; the real call 01a1e78d (2026-11-17) showed that route speaking
    // outside the transcript with an English instruction and no conversation context.
    silenceHook(
      'silence-repeat-question',
      at1,
      exactLine(config, language, config.scripts.silenceRepeat),
    ),
    silenceHook('silence-check-1', at2, exactLine(config, language, config.scripts.silenceCheck1)),
    silenceHook('silence-check-2', at3, exactLine(config, language, config.scripts.silenceCheck2)),
    silenceHook('silence-announce-end', at4, silenceEndAction(silenceEndServer)),
    silenceHook('silence-hangup', at5, { type: 'tool', tool: { type: 'endCall' } }),
  ];
}
