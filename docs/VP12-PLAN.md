# VP-12 plan — call logging & analysis

Branch `work/vp-12-call-logging-analysis`. This is FUTURE-FEATURES **F-10** plus the logging work order.

## 0. Audit result (what existed)

| Piece | Before VP-12 |
| --- | --- |
| `end-of-call-report` handler | **Did not exist.** Only `tool-calls` webhooks. No assistant-level `server.url`. |
| `call_topics` (VP-9) | Written by the model via `log_call_topic`; zero-PII by schema test. Unreliable (VAPI-FACTS VP-7 R8). **Left untouched.** |
| Staff dashboard (VP-5) | Sessions + callbacks + reservations pages. No call list. |
| Recording | No `artifactPlan` anywhere. Vapi's default is `recordingEnabled: true`, so it may already be on — verify on the live assistants. |
| Google credentials | None. |

## 1. Data split (decisions 2, 3, 5 of the work order)

- `call_logs` (Neon, staff-visible): timestamp, language, caller name, intent (topic), status, AI summary, matched patient name. **No transcript or audio column — a schema test enforces it.**
- `call_archive_jobs` (Neon, developer-only, never read by any staff route): call id, state (`pending|done|failed`), attempts, Sheet row ref, permanent Drive link. **Holds no transcript** — retries re-fetch the call from Vapi (`GET /call/{id}`), so Neon never stores one.
- Private Google Sheet + Drive folder: full transcript + audio, shared only with the service account and the developer.

## 2. Status enum (decision 4)

`reservation_made` > `needs_callback` > `resolved_by_ai` > `unresolved`, first match wins:

1. `book_appointment` tool result succeeded (`Booked.` prefix, no error) → `reservation_made`
2. `request_callback` tool call present → `needs_callback`
3. structured output `resolved === true` → `resolved_by_ai`
4. otherwise (including a missing/null structured output) → `unresolved`

Rule 4 is the safe default: an unknown call is surfaced to staff rather than silently called "resolved".

## 3. Webhook

`POST /api/voice/end-of-call-report`, mounted in the existing `voiceRouter` (same rate limit + Custom Credential auth; no second handler). Assistants get `server: { url, credentialId }` and `serverMessages: ["end-of-call-report"]` so only that event goes to it (tools keep their own `server`).

Order inside the handler: parse → resolve client → derive status → write `call_logs` (idempotent on `(client_id, call_id)`) → enqueue `call_archive_jobs` row → attempt archive within a time budget → always answer 200 once the staff row is saved. A failed/slow Drive upload only leaves the job `pending`; `npm run archive:retry` (and a protected retry endpoint) re-runs it.

## 4. Recording & structured output (sync engine)

- `artifactPlan: { recordingEnabled: true, structuredOutputIds: [<id>] }` on all assistants incl. the `-return` leg.
- One structured output per client, named `<clientId>--call-outcome`, created idempotently by `vapi:sync`.

## 5. Order of building

1. Migration + repositories + status derivation + report parser + route (first slice, TDD).
2. Sync: `server`, `serverMessages`, `artifactPlan`, structured output.
3. Recording-disclosure line in both greetings (`client.yaml`).
4. Google client (service account) + archive job + retry.
5. Staff dashboard: All Calls / Callbacks / Reservations.
6. Real-call validation (needs the developer): resolved FAQ, callback, booking, unresolved, **endCallPhrases hangup, silence timeout** — check the structured output arrives on each path.
