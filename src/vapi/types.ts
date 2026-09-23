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
  /** Always "azure" for now (client.yaml's only configured provider). */
  provider: string;
  /**
   * UNVERIFIED — see VAPI-FACTS.md (R2). Neither Vapi's docs nor the SDK's
   * shipped AzureVoiceId enum confirm "ja-JP-NanamiNeural"/"en-US-JennyNeural"
   * specifically (the SDK type accepts any string, so this is a runtime
   * question, not a type error). R7's real test call is the actual check.
   */
  voiceId: string;
}

export interface VapiTranscriberConfig {
  /** Always "azure" for now. */
  provider: string;
  /** e.g. "ja-JP" — confirmed in Azure's supported-language list, VAPI-FACTS.md R1. */
  language: string;
}

export interface VapiModelMessage {
  role: 'system';
  content: string;
}

export interface VapiModelConfig {
  /** "openai" (primary) or "anthropic" (fallback) — VAPI-FACTS.md R3. */
  provider: string;
  /** e.g. "gpt-4o-mini" — confirmed as a valid model literal, VAPI-FACTS.md R3. */
  model: string;
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

export interface VapiAssistantPayload {
  /** Vapi's own assistant.name field — CLAUDE.md naming convention, e.g. "sakura-seikotsuin--ja". */
  name: string;
  firstMessage: string;
  voice: VapiVoiceConfig;
  transcriber: VapiTranscriberConfig;
  model: VapiModelConfig;
  /**
   * Spoken automatically whenever the assistant ends the call (e.g. via the
   * `endCall` tool) — "If unspecified, it will hang up without saying
   * anything" (Vapi OpenAPI spec, `CreateAssistantDto.endCallMessage`).
   * VAPI-FACTS.md VP-6 R2: this, not a tool message, is the guaranteed
   * canned goodbye.
   */
  endCallMessage: string;
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
  assistantOverrides: { firstMessage: string; endCallMessage: string };
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
