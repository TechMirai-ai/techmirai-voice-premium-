<!-- DRAFT for the project owner's review. NOT sent. Placeholders in [square brackets]. -->

# Support report: assistant replies missing from the LLM message history, and consecutive user messages merged, after a squad handoff

**Severity:** high for us — a safety instruction ("hang up and call the emergency number") was repeated instead of the call ending.
**Product area:** Squads / handoff, call pipeline (turn handling), `messages` artifact.
**Frequency:** 1 of the 17 calls we have logs for (2026-09-21 → 2026-09-25).

## 1. Summary

In one web call, after a Squad handoff (`ja` → `en`), **none of the assistant's replies were included in the message history Vapi sent to OpenAI**, and each new caller utterance was **appended to the previous user message** instead of starting a new one. The model therefore believed it had never spoken and produced the same answer to the growing user message on every turn. The assistant *did* speak each reply (audio was synthesized and billed), but the replies are also absent from `artifact.messages`.

In the same call — and in none of the other 16 calls — the log contains a burst of **`Endpointing timeout 700ms (rule: heuristic)`** events (17 within 4.1 s during a single caller utterance), each followed by `Turn started` / `Pipeline cleared` / `LLM stream clearing`. We suspect, but cannot prove, that these turn restarts are what dropped the assistant's messages. Our own assistant config sets `transcriptionEndpointingPlan.onNoPunctuationSeconds = 0.7`.

## 2. Identifiers

| | |
|---|---|
| Failing call | `01a0d7e1-d0b6-744b-87e0-a5f96c70b53f` (web call, started 2026-09-25T09:24:56Z, ended 09:26:13Z, `endedReason` = `customer-ended-call`) |
| Healthy comparison call | `01a0d7e4-dfb2-7ffc-8555-a327ccfd1711` (same squad, same handoff, 2026-09-25T09:28Z) |
| Squad | `8f369634-2fb0-48d6-99a3-e940b97614b8` (members: `5783f9a4-7051-4595-b391-997c080fc61b` (ja, starts the call) → `b75e0b2a-080a-49d1-a236-649b81a85290` (en) → `0d766e19-593b-40fa-b8ef-8a1a4cfac0a8` (ja-return)) |
| Org | [org id — add from dashboard] |
| Model | `openai` / `gpt-4o-mini`, temperature unset (default 0.5; the request log shows `0.5`) |
| Transcriber | Azure, `ja-JP` (ja leg), `en-US` (en leg) |
| Handoff | function-tool handoff `ja` → `en`, `contextEngineeringPlan: {type: "all"}`, destination `assistantOverrides` = `{firstMessage, endCallMessage, endCallPhrases, hooks}` |

## 3. What happened (times = seconds from call start, from the call log)

| Time | Event |
|---|---|
| 6.2 | ja assistant speaks its first message |
| 22.1 | caller: "English." |
| 23.21 / 23.25 | `call.handoffInitiated` / `call.handoffCompleted`; 23.43 `call.assistantStarted`, `Assistant transfer successful` |
| 23.9 → 33.8 | en assistant speaks its arrival first message (10 s; `First message started` … `First message completed`) |
| 35.3 | caller starts speaking one long sentence |
| **36.4 → 40.5** | **17× `Endpointing timeout 700ms (rule: heuristic)`**, each with `Turn started`, `Pipeline cleared` (`wasInterruption: false`), `LLM stream clearing` |
| 41.19 | final transcript: "I have a emergency. I have a very heavy shoulder pain. Do your clinic treat shoulder pain?" |
| 41.29 | LLM request #1 (history in §4) |
| 42.62 → 48.43 | bot speaks: "If this is an emergency, please hang up and call 119 for an ambulance right away." |
| 54.91 | final transcript: "OK. Thank you." → LLM request → **same line** again (56.5 → 62.3) |
| 66.62 | final transcript: "OK. OK. Thank you." → LLM request → **same line** again (68.5 → 74.2) |
| 77.81 | `call.ended`, `customer-ended-call` |

The model output was identical each time (`Model output` → `LLM response completed`, no tool call). The caller therefore heard the same instruction three times.

## 4. Evidence

### 4a. The history Vapi actually sent to OpenAI (from the `OpenAI HTTP request` log events, `attributes.request.messages`)

Failing call — role sequence per request (`S` system, `A` assistant text, `A(t)` assistant tool call, `T` tool result, `U` user):

| Request at | History sent | Last user message (verbatim) |
|---|---|---|
| 22.4 s | `S A U` | "english" |
| **41.3 s** | `S A U A(t) T U` | "I have a emergency. I have a very heavy shoulder pain. Do your clinic treat shoulder pain?" |
| **54.7 s / 55.0 s** | `S A U A(t) T U` | "…Do your clinic treat shoulder pain? **OK thank you**" then "…? **OK. Thank you.**" |
| **66.7 s** | `S A U A(t) T U` | "…Do your clinic treat shoulder pain? OK. Thank you. OK. OK. Thank you." |

- The en assistant's arrival message (spoken 23.9–33.8 s) is **not** in the history.
- The three "call 119" replies (spoken 42.6, 56.5, 68.5 s) are **not** in the history.
- Each later caller utterance is **concatenated onto the same user message** (still a single trailing `U`), rather than being a new user message after an assistant message.

Healthy call (`01a0d7e4…`, same squad and handoff) — history at successive requests: `S A U` → `S A U A U` → `S A U A U A(t) T A U` → `… A U A U …` (strictly alternating; the en arrival message **is** present after the handoff: `…A(t) T A U`).

### 4b. `artifact.messages` also lacks the replies, but the audio was produced and billed

`GET /call/01a0d7e1…` → `artifact.messages` has 6 entries: `system`, `bot` (ja greeting), `user` ("English。"), `tool_calls`, `tool_call_result`, `user` (the caller's long sentence). **No `bot` message after the handoff, and no message for the later two caller turns.** Yet `costBreakdown.ttsCharacters` = **243**, which is exactly **3 × 81**, the length of the sentence "If this is an emergency, please hang up and call 119 for an ambulance right away." — i.e. it was synthesized three times. (First messages do not appear to be counted in `ttsCharacters`, consistent with our earlier calls.)

### 4c. Consequence of the history, reproduced deterministically

We took the exact request Vapi logged at 66.7 s (messages, tools, temperature 0.5, model) and replayed it directly against the OpenAI API 20 times: **20 of 20** responses were the same "If this is an emergency, please hang up and call 119…" line, with no tool call. So the repeated output is fully explained by the history above; the model is not misbehaving given what it was sent. (This replay reproduces the *effect*, not the missing-history bug itself, which we cannot trigger on demand.)

### 4d. Base rate

We fetched `artifact.logUrl` for every call that has one (17 calls, 2026-09-21 → 2026-09-25, 14 with a handoff). In the last logged request of each, the history alternates normally in all 16 others. The failing call is also the only one with any `Endpointing timeout 700ms` event at all in the healthy set (the failing call has one on the ja leg at 21.7 s and 20 more later, 17 of them in one burst):

| | failing `01a0d7e1` | healthy `01a0d7e4` | 15 older calls |
|---|---|---|---|
| `Endpointing timeout 700ms (rule: heuristic)` events | **21** (17 in one 4-second burst) | 0 | 0 |
| assistant replies in the model's history | **missing** | present | present |

### 4e. Our endpointing configuration (live `GET /assistant/…`, en assistant)

```json
"startSpeakingPlan": {
  "smartEndpointingPlan": { "provider": "vapi" },
  "transcriptionEndpointingPlan": { "onNoPunctuationSeconds": 0.7 },
  "customEndpointingRules": [ { "type": "assistant", "regex": "Thank you\\. May I have a phone number where our staff can reach you\\?", "timeoutSeconds": 2.5 } ]
},
"transcriber": { "provider": "azure", "language": "en-US" }
```

The caller's utterance was one long English sentence that ran on for about five seconds with pauses, which is consistent with the no-punctuation timeout firing repeatedly. Every other call in our set was short, or mostly Japanese with punctuation from Azure.

## 5. What we do not know

- **Why** the turn restarts (or anything else) caused the assistant's messages to be omitted from the history. The correlation is one call; we have not been able to reproduce it deliberately (calls cost credit; we would like your help instead).
- Whether the burst is the cause or a co-symptom of another condition (e.g. the first message after the handoff still being committed when the caller starts speaking 1.5 s after it ends).
- Whether `artifact.messages` omits the replies for the same reason as the LLM history, or independently.
- We checked, and are **not** claiming, acoustic echo: the transcriber emits `final transcript` events matching the assistant's own sentences in all calls, healthy ones included.

## 6. Questions for Vapi

1. When is an assistant message appended to the conversation history — at synthesis start, at `Bot stopped speaking`, or when the turn is committed? Can `Pipeline cleared` / `LLM stream clearing` discard an assistant message that has been spoken but not yet committed (with `wasInterruption: false`)?
2. Is merging consecutive user messages into one expected when no assistant message sits between them? (It changes model behaviour materially.)
3. Is `Endpointing timeout 700ms (rule: heuristic)` expected to fire ~17 times inside one utterance with `onNoPunctuationSeconds: 0.7` and `smartEndpointingPlan.provider: "vapi"` enabled, and is that the intended interaction of the two?
4. Is there a supported configuration that guarantees assistant replies are always kept in the history (or a per-call way to see why one was dropped)?
5. Is this a known issue for the first message spoken after a handoff (`assistantOverrides.firstMessage`)?

## 7. Impact and what we changed on our side

Impact: a caller in a (test) emergency was told the same instruction three times and the call did not end. For a receptionist product the same fault would also make any conversation repeat itself, not only emergencies.

Mitigation we shipped (prompt-level, not a fix): a declared emergency now gets a line that ends with a hang-up phrase (deterministic); an acknowledgement ("OK, thank you") together with an emergency description ends the call; the conditional line stays open. Replaying the logged requests against the new prompt (four runs of 20 each): the second-turn request still repeats the line in 11 of 80 (14 %) and the third-turn request in 37 of 80 (46 %), down from 20 of 20 — so it is only a **partial** defence with high run-to-run variance. We have **not** changed `onNoPunctuationSeconds`, and would like your view before trading answer latency for it.

## 8. Attachments to include

1. Call log for `01a0d7e1…` (`GET /call/{id}` → `artifact.logUrl`, gzipped JSON lines — the presigned URL expires, download it first) — `docs/vp7-test-runs/prod-call-01a0d7e1/` has the condensed timeline.
2. The three logged OpenAI request bodies (`request-A-first-turn.json`, `request-B-after-first-ok.json`, `request-C-after-third-ok.json`; they contain our full system prompt for a demo clinic with fictional data).
3. `history-scan-17-calls.txt` (role sequence of the last request of each logged call).
4. The replay script `replay-prod-request.ts.txt` and its 20/20 output.
5. Same-squad healthy call `01a0d7e4…` for comparison.
