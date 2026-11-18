/**
 * The two Vapi "speaking plans": when the assistant starts talking after the caller stops
 * (`startSpeakingPlan`) and when it stops talking because the caller started (`stopSpeakingPlan`).
 * Pure — no network, no filesystem. Used by render.ts for each assistant and by squad.ts for the
 * handoff overrides (a handed-off-to leg is not assumed to inherit either plan, VAPI-FACTS.md
 * VP-6 R3).
 *
 * Both are driven by client.yaml and default to exactly what the project sent before they existed:
 * a client that sets nothing renders the same bytes as before.
 */
import type { ClientConfig } from '../config/schema.js';
import { consultationLine } from './promptConsultationSection.js';
import type {
  VapiCustomEndpointingRule,
  VapiStartSpeakingPlan,
  VapiStopSpeakingPlan,
} from './types.js';

/**
 * VP-6 §A: text-based smart endpointing (works for any language). The "vapi"
 * smartEndpointingPlan provider decides using transcriptionEndpointingPlan's
 * own heuristic rules (VAPI-FACTS.md VP-6 R7) — leaving that unset meant it
 * silently used the default 1.5s `onNoPunctuationSeconds` wait, identical to
 * the behavior it was meant to shorten. Set explicitly here.
 *
 * NOT applied when the transcriber is Deepgram Flux — see `isFluxModel` below.
 */
const NO_PUNCTUATION_WAIT_SECONDS = 1.1;

/**
 * Wait after a transcript that ends with punctuation (Vapi default 0.1s). A real English call
 * (2026-10-11, VP-10) showed short punctuated fragments — "Yeah.", "Okay." — each firing the
 * model within ~100ms while the caller was still mid-thought: six model calls in nine seconds,
 * each aborting the last. A longer wait here lets the next fragment arrive first.
 */
const PUNCTUATION_WAIT_SECONDS = 0.45;

/** Deepgram's Flux models are named `flux-general-en` / `flux-general-multi`. */
export function isFluxModel(model: string | undefined): boolean {
  return model?.startsWith('flux-') ?? false;
}

/** Escapes regex metacharacters so a literal script line is safe to use as a Vapi endpointing-rule regex. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A trailing fragment of a script line, to use as a `customEndpointingRules` regex that survives
 * the model paraphrasing the line when it actually speaks it.
 *
 * History (VAPI-FACTS.md Vendor-swap R18–R21): anchoring on the whole line, and then on its last
 * sentence, both failed on real calls because the model dropped the first word of whatever was
 * anchored ("スタッフ"). So instead of guessing which word is unstable, this drops the first HALF
 * of the line by character count, then snaps forward to the next word boundary where one exists
 * (space-delimited languages), and ignores trailing punctuation (the model used "。" and "?"
 * interchangeably). Vapi's match is `RegExp.test`, i.e. substring, so the anchor only has to
 * appear somewhere inside what is spoken.
 */
export function stableQuestionAnchor(text: string): string {
  const core = text.replace(/[.!?。！？]+$/, '');
  const midpoint = Math.floor(core.length / 2);
  const nextSpace = core.indexOf(' ', midpoint);
  const cut = nextSpace === -1 ? midpoint : nextSpace + 1;
  return core.slice(cut);
}

/**
 * The extra-patience rule for the turn after the assistant asks the caller to SAY a phone number
 * (VP-27 M5). Real Sakura calls (R18, R22) showed callers reading digits in paused groups and the
 * default wait cutting in after three digits; Vapi evaluates this rule on the last assistant
 * message and, on a match, replaces the endpointing timeout for that turn.
 */
function numberQuestionRule(
  config: ClientConfig,
  language: string,
  waitSeconds: number,
): VapiCustomEndpointingRule {
  const question = consultationLine(config, language, 'askSpokenNumber');
  return {
    type: 'assistant',
    regex: escapeRegex(stableQuestionAnchor(question)),
    timeoutSeconds: waitSeconds,
  };
}

/**
 * `language` is the CONTENT language of the member (never the raw `ja-return` id).
 * Key order matters for clients that set nothing: it is the order the project always sent.
 */
export function buildStartSpeakingPlan(
  config: ClientConfig,
  language: string,
): VapiStartSpeakingPlan {
  const transcriberModel = config.languages.settings[language]?.transcriber?.model;
  const dictation = config.consultation?.numberDictation;

  return {
    // Vapi's docs say explicitly not to set smartEndpointingPlan for a transcriber with its own
    // built-in end-of-turn detection (Deepgram Flux) — leaving it set would silently override
    // Flux's own detection and defeat the reason to use it (VAPI-FACTS.md Vendor-swap R7).
    ...(isFluxModel(transcriberModel) ? {} : { smartEndpointingPlan: { provider: 'vapi' } }),
    // Left in place even for Flux, deliberately: whether this text-heuristic wait also gets
    // bypassed by Flux's built-in EOT, or stacks as a second silence timer on top of it, is the
    // open question from VAPI-FACTS.md Vendor-swap R7 — a real test call (long/hesitant turn)
    // decides whether this should be removed for Flux. Do not remove this without that evidence.
    transcriptionEndpointingPlan: {
      onNoPunctuationSeconds: NO_PUNCTUATION_WAIT_SECONDS,
      onPunctuationSeconds: PUNCTUATION_WAIT_SECONDS,
      // The fallback when the rule below misses (the model reworded the question): a transcript
      // that ENDS in a number waits this long, so digits dictated in chunks are not cut off.
      ...(dictation?.onNumberSeconds === undefined
        ? {}
        : { onNumberSeconds: dictation.onNumberSeconds }),
    },
    // Explicitly empty (not omitted) when unused, so a re-sync clears a rule left on the live
    // assistant by an earlier sync.
    customEndpointingRules: dictation
      ? [numberQuestionRule(config, language, dictation.waitSeconds)]
      : [],
  };
}

/**
 * The language's `stopSpeakingPlan` from client.yaml, or `undefined` when it sets none (then the
 * field is not sent at all and Vapi's defaults apply, exactly as before VP-27).
 */
export function buildStopSpeakingPlan(
  config: ClientConfig,
  language: string,
): VapiStopSpeakingPlan | undefined {
  const plan = config.languages.settings[language]?.stopSpeakingPlan;
  if (!plan || Object.keys(plan).length === 0) return undefined;
  return {
    ...(plan.numWords === undefined ? {} : { numWords: plan.numWords }),
    ...(plan.voiceSeconds === undefined ? {} : { voiceSeconds: plan.voiceSeconds }),
    ...(plan.backoffSeconds === undefined ? {} : { backoffSeconds: plan.backoffSeconds }),
    ...(plan.acknowledgementPhrases ? { acknowledgementPhrases: plan.acknowledgementPhrases } : {}),
    ...(plan.interruptionPhrases ? { interruptionPhrases: plan.interruptionPhrases } : {}),
  };
}
