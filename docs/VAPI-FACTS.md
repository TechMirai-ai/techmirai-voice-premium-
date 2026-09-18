# Vapi facts — verified against docs

Checked: 2026-09-17. Vapi changes often — re-check anything older than a few weeks before relying on it.
Rule: if a fact you need is not here, check the docs (MCP server https://docs.vapi.ai/_mcp/server or https://docs.vapi.ai/llms.txt), then add it here with the source URL.

## Verified
| Fact | Source |
| --- | --- |
| Squads: a squad has `members`; the **first member starts the call**. Handoff tools are the recommended way to define where an assistant can hand off to. | https://docs.vapi.ai/squads |
| Handoff tool can transfer to an assistant by ID or by name within a squad, control what history the next assistant receives, and extract variables. | https://docs.vapi.ai/squads/handoff |
| Known dashboard issue: configuring a handoff in the dashboard squad builder does not carry `function.parameters` through to runtime. → Define handoffs in code. | https://docs.vapi.ai/squads/passing-data-between-assistants |
| Function tool webhook response: HTTP **200** always, body `{"results":[{"toolCallId":"<id>","result":"<single-line string>"}]}`. For errors use `"error"` instead of `"result"` (still HTTP 200). No line breaks in the string. `toolCallId` must match the request. | https://docs.vapi.ai/tools/custom-tools , https://docs.vapi.ai/tools/custom-tools-troubleshooting |
| Function tool (not API Request tool) is the right type when our server implements Vapi's tool-calls webhook and needs call context. | https://docs.vapi.ai/tools/api-request-vs-function |
| Server authentication uses **Custom Credentials** (Bearer token, OAuth 2.0, or HMAC), referenced from `server.credentialId`. Bearer credential lets you set the header name and toggle the `Bearer ` prefix. Credentials are created in the dashboard. | https://docs.vapi.ai/server-url/server-authentication |
| `assistant.server.url` + `assistant.server.credentialId` can be set via the API. | https://docs.vapi.ai/server-url/setting-server-urls |
| `azure` is a supported voice provider string (`voice.provider`) and a supported transcriber provider (`transcriber.provider`). | https://docs.vapi.ai/providers/voice/overview.md , https://docs.vapi.ai/providers/transcriber/azure |
| Server SDK: `npm i @vapi-ai/server-sdk`; `import { VapiClient } from "@vapi-ai/server-sdk"; new VapiClient({ token })`. | https://github.com/VapiAI/server-sdk-typescript |
| Web SDK: `npm i @vapi-ai/web`; `new Vapi(publicKey)`; `vapi.start(assistantId)` or with an assistant object. Uses the **public** key. | https://www.npmjs.com/package/@vapi-ai/web |
| Official config-as-code template exists: `VapiAI/gitops` — assistants as `.md` (YAML frontmatter + prompt), tools/squads as `.yml`, state file mapping names → UUIDs, `validate` / `apply` / `pull` / `push`, snapshot before push, rollback. | https://github.com/VapiAI/gitops |

## Decision for VP-2 (sync approach)
`VapiAI/gitops` is built around one static folder per Vapi org. We need one template → many clients. Default plan: our own small sync engine that renders `client.yaml` + shared templates into Vapi payloads and syncs them with `@vapi-ai/server-sdk`, copying the good ideas from `VapiAI/gitops` (name → UUID state file, dry-run, snapshot before push, no secrets in files). VP-2 must re-evaluate this in its PR before building.

## NOT yet verified — check before use
- Whether Vapi accepts `ja-JP-NanamiNeural` / `en-US-JennyNeural` exactly as `voiceId` for the `azure` provider.
- Whether `ja-JP` is in Vapi's accepted Azure transcriber language list, and Japanese transcription quality vs. other providers.
- Current LLM options and per-minute costs for Japanese conversations.
- Current exact schema for squad members / handoff destinations.
- Whether Custom Credentials can be created through the API (docs describe the dashboard).
- The webhook envelope shape (`message.type`, `message.toolCallList` etc.) — confirm from the API reference.
- Trial credit amount, platform fee, call-log retention.
