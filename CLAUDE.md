# techmirai-voice-premium

Premium-tier AI voice receptionist for Japanese clinics, built on Vapi.
This is a standalone product. It has no connection to `techmirai-voice-agent` — never import, copy, or reference code from that repo.

## Read before every work order
1. `docs/FUTURE-FEATURES.md` — features we deliberately postponed. Do NOT build them. Do NOT make design choices that block them.
2. `docs/VAPI-FACTS.md` — Vapi facts already verified against the docs. For anything not listed there, check the current Vapi docs before writing code (Vapi docs MCP server: https://docs.vapi.ai/_mcp/server, or https://docs.vapi.ai/llms.txt). Never guess Vapi field names, endpoints, or payload shapes. If you verify a new fact, add it to `VAPI-FACTS.md` with the source URL and date.

## Architecture rules
- Clinic-specific data lives ONLY in `clients/<clientId>/client.yaml`. Never hard-code a clinic name, address, phone number, FAQ, script, voice, or language in code or prompt templates.
- Every database row that belongs to a client has a `client_id` column.
- Languages are data, not code. No `if (lang === "ja")` business logic.
- FAQ content is read only through the `KnowledgeSource` interface.
- Secrets only in `.env`. Never commit secrets.
- Never log caller names or phone numbers in plain text — use `src/lib/redact.ts`.
- Vapi resource names are prefixed with the client id (e.g. `sakura-seikotsuin--ja`).

## Workflow
- One branch + one PR per work order (`work/vp-N-<slug>`). Run `npm test`, `npm run typecheck`, `npm run lint` before opening the PR.
- If a work order conflicts with this file or with what you find in the docs, stop and ask.

## Reporting
The project owner cannot read Japanese. Every Japanese string you mention in a PR or report must be followed by its English meaning in parentheses.
