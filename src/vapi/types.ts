/**
 * Hand-written types for exactly the Vapi fields this project sets — not a
 * model of Vapi's whole API. `@vapi-ai/server-sdk` ships its own generated
 * types (huge discriminated unions: 18+ model providers, 20+ voice
 * providers, ...); `client.ts` is the one place that bridges these narrow
 * types onto the SDK's real request types.
 *
 * See docs/VAPI-FACTS.md for what's confirmed and what's still open.
 */

export interface VapiVoiceConfig {
  /** "cartesia" as of the vendor swap (VAPI-FACTS.md Vendor-swap R2) — client.yaml's configured provider. */
  provider: string;
  /**
   * Cartesia voiceIds are opaque UUIDs read from the project owner's own
   * Cartesia dashboard, not guessed — VAPI-FACTS.md Vendor-swap R3.
   */
  voiceId: string;
}

export interface VapiTranscriberConfig {
  /** "cartesia" as of the vendor swap (VAPI-FACTS.md Vendor-swap R2). */
  provider: string;
  /** Cartesia's Ink Whisper model requires this alongside `provider`/`language` — VAPI-FACTS.md Vendor-swap R2. */
  model?: string;
  /** e.g. "ja" (Cartesia; plain ISO code, not "ja-JP") — VAPI-FACTS.md Vendor-swap R2. */
  language: string;
}

export interface VapiModelMessage {
  role: 'system';
  content: string;
}

export interface VapiModelConfig {
  /** "openai" (primary) or "anthropic" (fallback) — VAPI-FACTS.md R3. */
  provider: string;
  /** e.g. "gpt-5.6-terra" — confirmed as a valid model literal, VAPI-FACTS.md Vendor-swap R1. */
  model: string;
  /**
   * Required for reasoning-tier OpenAI models (e.g. gpt-5.6-terra) to use function tools at all —
   * "none" is the only value that doesn't 400 with tools attached (VAPI-FACTS.md Vendor-swap R4).
   * Omit for non-reasoning models.
   */
  reasoningEffort?: string;
  messages: VapiModelMessage[];
  /** UUIDs of tools this assistant may call, resolved by sync.ts before render output is sent. */
  toolIds: string[];
  /** Transient built-in tools inlined directly (no separate create/sync step) — used for `endCall`. */
  tools?: VapiEndCallToolPayload[];
}

/**
 * Vapi's built-in end-call tool (VAPI-FACTS.md VP-4 R5): no server, fixed
 * function name `endCall`. It has no `messages` of its own — a tool
 * `request-start`/`blocking` message is a function-tool concept (it delays
 * *returning the tool result to the model*) and does nothing for a tool with
 * no server round-trip and no next model turn to gate. Confirmed by a real
 * call: setting one typechecked but never triggered any TTS (VAPI-FACTS.md
 * VP-6 R2). The real hook is `VapiAssistantPayload.endCallMessage`.
 */
export interface VapiEndCallToolPayload {
  type: 'endCall';
}

/**
 * Assistant hook that hangs up after a long caller silence, with no model decision involved
 * (VAPI-FACTS.md VP-7 R8; shape checked against the live OpenAPI `CallHookCustomerSpeechTimeout`).
 */
export interface VapiSilenceHangupHook {
  on: 'customer.speech.timeout';
  name: string;
  options: {
    /** 1–1000 seconds. */
    timeoutSeconds: number;
    /** 1–10. */
    triggerMaxCount: number;
    triggerResetMode: 'onUserSpeech' | 'never';
  };
  do: [{ type: 'tool'; tool: VapiEndCallToolPayload }];
}

export interface VapiServerConfig {
  url: string;
  credentialId?: string;
}

/**
 * A tool's webhook. The Custom Credential is mandatory (VP-4 §3): it is created
 * by hand in the Vapi dashboard, since credentials have no API (VAPI-FACTS.md, VP-4 R4).
 */
export interface VapiToolServerConfig {
  url: string;
  credentialId: string;
}

/**
 * A custom endpointing rule matching the assistant's own last message (or the
 * customer's current speech) by regex, overriding the endpointing timeout for
 * that one turn. Highest precedence — see `VapiStartSpeakingPlan` (VP-6 §A).
 */
export interface VapiCustomEndpointingRule {
  type: 'assistant' | 'customer' | 'both';
  regex: string;
  timeoutSeconds: number;
}

/**
 * Controls how long the assistant waits to decide the caller has finished
 * speaking (VP-6 §A / VAPI-FACTS.md "VP-3 latency investigation"). Narrowed
 * to just what this project sets: Vapi's own text-based smart endpointing
 * (works for any language, unlike LiveKit's endpointing which docs say is
 * English-only) as the general mechanism, plus a `customEndpointingRules`
 * override for the one turn that needs extra patience — the caller reading a
 * phone number back in chunks.
 */
export interface VapiStartSpeakingPlan {
  smartEndpointingPlan?: { provider: 'vapi' };
  customEndpointingRules?: VapiCustomEndpointingRule[];
  /**
   * The "vapi" smartEndpointingPlan provider is not an independent adaptive
   * system — it decides using these same heuristic rules (VAPI-FACTS.md
   * VP-6 R7): number-ending → onNumberSeconds, punctuation-ending →
   * onPunctuationSeconds, otherwise → onNoPunctuationSeconds (default 1.5s).
   * Leaving this unset means smartEndpointingPlan silently falls back to
   * that 1.5s default — exactly the wait it was meant to shorten.
   */
  transcriptionEndpointingPlan?: { onNoPunctuationSeconds: number };
}

export interface VapiAssistantPayload {
  /** Vapi's own assistant.name field — CLAUDE.md naming convention, e.g. "sakura-seikotsuin--ja". */
  name: string;
  firstMessage: string;
  voice: VapiVoiceConfig;
  transcriber: VapiTranscriberConfig;
  model: VapiModelConfig;
  startSpeakingPlan?: VapiStartSpeakingPlan;
  /**
   * Spoken automatically whenever the assistant ends the call (e.g. via the
   * `endCall` tool) — "If unspecified, it will hang up without saying
   * anything" (Vapi OpenAPI spec, `CreateAssistantDto.endCallMessage`).
   * VAPI-FACTS.md VP-6 R2: this, not a tool message, is the guaranteed
   * canned goodbye.
   */
  endCallMessage: string;
  /**
   * Hang up as soon as the assistant SAYS one of these (case-insensitive substring) — the
   * platform-level backstop for a model that speaks a farewell instead of calling `endCall`
   * (VAPI-FACTS.md VP-7 R8). Omitted when the client configures none.
   */
  endCallPhrases?: string[];
  /** Silence-hangup hook — see `callEnding.ts`. */
  hooks: VapiSilenceHangupHook[];
  /** Not set in VP-2 — the callback webhook is reached via the tool's own server.url instead. */
  server?: VapiServerConfig;
}

export type VapiFunctionParameterType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface VapiFunctionParameterSchema {
  type: VapiFunctionParameterType;
  description?: string;
  /** Restricts a string parameter to a fixed set — used for `log_call_topic`. */
  enum?: string[];
}

export interface VapiFunctionParameters {
  type: 'object';
  properties: Record<string, VapiFunctionParameterSchema>;
  required?: string[];
}

export interface VapiFunctionDefinition {
  /**
   * The plain, short identifier the model calls (e.g. "request_callback") —
   * NOT the CLAUDE.md-prefixed resource name. A function tool has no
   * resource-level `name` field in Vapi's API; the prefixed name
   * (`<clientId>--<language>--request-callback`) is our own bookkeeping key
   * in `.vapi-state.<clientId>.json`, never sent to Vapi. See VAPI-FACTS.md.
   */
  name: string;
  description?: string;
  parameters: VapiFunctionParameters;
}

/** Confirmed directly from @vapi-ai/server-sdk's shipped types — see VAPI-FACTS.md. */
export type VapiToolMessageType =
  'request-start' | 'request-complete' | 'request-failed' | 'request-response-delayed';

export interface VapiToolMessage {
  type: VapiToolMessageType;
  content: string;
}

export interface VapiFunctionToolPayload {
  type: 'function';
  function: VapiFunctionDefinition;
  server: VapiToolServerConfig;
  /**
   * `true` = the assistant moves on without waiting for our server (VAPI-FACTS.md,
   * VP-4 §4.3). Set for `log_call_topic`, so analytics can never delay the caller.
   */
  async?: boolean;
  messages?: VapiToolMessage[];
}

/**
 * A handoff destination: another assistant in the same squad, by name.
 * Field names confirmed from @vapi-ai/server-sdk's HandoffDestinationAssistant
 * and proven by a real call — VAPI-FACTS.md, VP-3 R2/R5.
 */
export interface VapiHandoffDestination {
  type: 'assistant';
  /** Resolved within the squad, so no assistant id is needed (R5). */
  assistantName: string;
  /** What the model reads to decide when to hand off. */
  description: string;
  /** "all" = the full history travels with the caller (Vapi's default; set explicitly). */
  contextEngineeringPlan: { type: 'all' };
  /**
   * Overrides the destination's own `firstMessage` for this handoff only
   * (R5). `endCallMessage` is included too: VAPI-FACTS.md VP-6 R3 found the
   * destination's own saved `endCallMessage` is NOT spoken when that
   * assistant is reached via handoff — it must be threaded through here,
   * the same as `firstMessage`, or a handed-off-to leg hangs up silently.
   */
  assistantOverrides: {
    firstMessage: string;
    endCallMessage: string;
    /**
     * Threaded through for the same reason as `endCallMessage`: the destination's own saved
     * `endCallPhrases`/`hooks` are not assumed to carry over a handoff (VAPI-FACTS.md VP-7 R8).
     */
    endCallPhrases?: string[];
    hooks: VapiSilenceHangupHook[];
  };
}

export interface VapiHandoffToolPayload {
  type: 'handoff';
  destinations: VapiHandoffDestination[];
  /** An empty `request-start` silences Vapi's default English filler ("One moment") — R5. */
  messages: VapiToolMessage[];
}

export type VapiToolPayload = VapiFunctionToolPayload | VapiHandoffToolPayload;

export interface VapiSquadMember {
  assistantId: string;
}

/** `members[0]` starts the call — VAPI-FACTS.md, VP-3 R1. */
export interface VapiSquadPayload {
  name: string;
  members: VapiSquadMember[];
}

/** The only part of Vapi's create/update response this project reads. */
export interface VapiCreatedResource {
  id: string;
}
