# Scope: server-side endpointing (`custom-endpointing-model`)

Status: **scoping only — not built, not approved.** Written 2026-10-11 (VP-10 follow-up).
Nothing in this file changes behavior. It exists so the owner can decide whether to commit to a work order.

## Why

A flat silence timer has a ceiling. Real evidence, English call `01a12b1f` (2026-10-11, at
`onNoPunctuationSeconds: 1.1`): the model was invoked on an unfinished sentence at least five times, three of them
while voice detection still showed the caller speaking (1.2s, 1.4s and 5.8s early). Raising the
timer further adds latency to every turn (no-punctuation turns already take 1.1–1.4s to endpoint).
The tuned values (`onNoPunctuationSeconds` 1.1, `onPunctuationSeconds` 0.45) are the fallback for this work.

## What Vapi sends and expects (verified against the live OpenAPI spec, 2026-10-11)

- Enable with `startSpeakingPlan.smartEndpointingPlan = { provider: "custom-endpointing-model", server: { url, credentialId?, timeoutSeconds?, headers?, backoffPlan? } }`.
- Request: `POST` with `{ "message": { "type": "call.endpointing.request", "messages": [ { "role", "message", "time", "secondsFromStart" } ], ...call metadata } }`.
- Response: `{ "timeoutSeconds": <number 0–15> }` — "seconds to wait before considering the user's speech as finished".
- A new request is sent **every time a new transcript is received**; the timeout restarts each time.
- `server.timeoutSeconds` defaults to **20s**. `backoffPlan` defaults to none (no retry).
- `customEndpointingRules` still outranks it (highest precedence).
- If `server.url` is omitted it falls back to `assistant.server`, then `org.server`.

## What the endpoint must do

1. Authenticate (shared Bearer Custom Credential, same as other voice routes — `webhookAuth`).
2. Read the last user message(s) from `messages`; resolve client + language from the call's assistant (VP-4 R2 resolver).
3. Judge whether the running transcript looks finished, and return a timeout:
   - looks finished (terminal punctuation, complete closing form) → short (~0.3s)
   - looks unfinished (trailing connective / particle / article / preposition / filler) → long (~2.0s)
   - otherwise → the current default (~1.1s)
4. Return in well under ~150ms. No database, no LLM on the hot path.

### Completeness rules (data, not code — CLAUDE.md "languages are data")

Per-language lists live in `client.yaml` (or a shared language-data file), e.g. `endpointing.continuationEndings` and `completeEndings`:

- **English:** trailing conjunctions (and, but, so, because, then, if), prepositions and infinitive "to", articles, auxiliaries ("I have", "I will"), fillers (um, uh), degree words ("a little").
- **Japanese:** trailing particles and connectives (が, けど, て, で, と, から, ので, を, は, も, の), fillers (えーと, あの, その); complete: ですます-form plus terminal 。/？ and `callerDoneExamples`. Matching is by trailing-string comparison, so no tokenizer is needed.

### How much of the observed problem this would actually catch

Call `01a12b1f`, the six cut-ins found:

| Said (at the cut) | Trailing-word rule catches it? |
|---|---|
| "Yes." then "Um, I have a little" | **No** for the "Yes." cut — a complete answer by itself. |
| "Yes. Um, I have" | Yes ("I have") |
| "I shall there." | No (garbled, ends in a period) |
| "Okay. Then" | Yes ("Then") |
| "Then I want to" | Yes ("to") |
| "I will come tom" | No (truncated word) |

Roughly **half** by this sample, which is small. The rules do not use audio: the request carries
transcript text and timestamps only, so "still speaking according to voice detection" cannot be used.
Treat the real-world gain as an estimate until the offline evaluation below is run.

## Engineering cost (estimate, not a commitment)

| Piece | Work | Est. |
|---|---|---|
| Spike: failure/timeout fallback, field semantics, request payload shape (real throwaway call) | Needed first — see unknowns | 0.5 d |
| Classifier + per-language data + schema/validation + unit tests (≥40 cases per language) | Core logic | 1.5 d |
| Route `/api/voice/endpointing`: auth, body parsing, strict response bounds, **its own rate limiter**, redacted logging, route tests | The existing limiter is 60 req/min/IP; one call can send roughly one request per transcript update, so it would throttle itself | 1 d |
| `render.ts` / `types.ts` / `sync.ts` plumbing, `server.credentialId`, short `server.timeoutSeconds`, render tests, read-back | Small | 0.5 d |
| Offline evaluation harness: replay real logged calls (about 25 exist) and measure false-cut vs added latency before going live | Highest-value safety net | 1 d |
| Live validation with a Japanese speaker and English speaker; tuning | Needs a tester | 1 d |
| **Total** | | **≈5–6 days** |

### Latency and reliability risks

- **Network hop on every transcript update.** Expect roughly 50–150ms (Vapi → our host → back), added to each endpointing decision. This only pays off if the timeouts it returns are shorter than the flat timer on finished sentences.
- **Cold starts.** The Vercel deployment runs Express behind `api/index.ts`; a cold start can cost 300ms to over a second, and the first request of a call is the likeliest to hit one. The route must stay light (no DB pool init), and a warm-up may be needed. Measure it in the spike.
- **LLM-based judging is not recommended on this path.** It would add roughly 300–800ms per transcript update. If wanted later, use it only on ambiguous cases.
- **Unknown failure behavior.** Vapi's docs do not say what happens when the endpoint errors or times out: fall back to `transcriptionEndpointingPlan`, hang for the 20s default, or never endpoint. A hang would be a worse failure than today's cut-ins. This must be settled in the spike, before building the rest.
- **Privacy.** Transcripts can contain names and phone numbers. Log only the decision, language and lengths, never the text (CLAUDE.md redaction rule; use `src/lib/redact.ts`).
- **Payload size.** Other tool webhooks grew to 40KB+; the endpointing request carries "other metadata about the call" — confirm size and the existing 2MB body limit in the spike.

## Unknowns to resolve in the spike (do not assume)

1. What happens on endpoint error, slow response, or timeout?
2. Does the returned timeout **replace** `transcriptionEndpointingPlan` or stack on top of it?
3. Exact payload: does `messages` include the in-progress partial utterance or only finalized turns?
4. Request frequency per second of speech (sizes the rate limiter and the Vercel invocation cost).
5. Does it interact with `customEndpointingRules`? (The phone-number rule is being removed separately, which simplifies this.)

## Recommendation

Do the spike first (0.5 d) — it decides whether the failure mode is safe. If the fallback is
sane, build behind a flag on one language (English), run the offline harness, and only then roll to Japanese.
