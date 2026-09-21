# Future features (deliberately postponed)

These were decided and then postponed. Do not build them yet.
For each one, the "Base must allow" list is binding NOW: current code must not make these harder to add later.

---

## F-1 — Admin FAQ editing with automatic sync to Vapi
**What:** Clinic staff edit FAQ entries in the admin screen; saving automatically re-syncs the Vapi assistants.
**Why later:** Extra work; the demo can use the config file.
**Build when:** A real premium client needs to edit their own FAQ.
**Base must allow:**
- FAQ is read only through the `KnowledgeSource` interface (file-based now; a database-backed source later).
- The Vapi sync engine (VP-2) is idempotent and callable as a function from code, not only from the CLI.
- Admin auth (VP-5) supports roles, so a "client editor" role can be added.

**VP-2 note:** the FAQ is delivered inline in the system prompt (`promptTemplate.ts`), not through
Vapi's Knowledge Base feature — with 10 entries, pasting them into the prompt gives the model full
context for flexible matching and is far simpler to build/test/reason about than wiring file
uploads to Knowledge Base. Revisit that decision if a client's FAQ list grows substantially (rough
threshold: dozens of entries, or the prompt becoming noticeably large/slow) — Knowledge Base search
scales better than a growing inline list.

## F-2 — Email and LINE notifications for callback requests
**What:** When a caller leaves a callback request, staff are notified by email and/or LINE.
**Why later:** Database storage plus the admin page is enough for v1.
**Build when:** A real client needs push notifications.
**Base must allow:**
- All notifications go through the `CallbackNotifier` interface (VP-4). New channels = new notifier classes, no change to callback logic.
- Saving a callback request must succeed even if a notifier fails. Notification delivery status is tracked separately from the callback row.

## F-3 — Several live clients at once (multi-tenancy)
**What:** Multiple clinics running on the same deployment.
**Why later:** Only one (demo) client exists.
**Build when:** A second real premium client signs up. Decide then: one set of Vapi assistants per client (generated from config — current direction) vs. one shared assistant loading data dynamically.
**Base must allow:**
- `client_id` on every client-owned table row.
- One config folder per client under `clients/`.
- Vapi resource names prefixed with the client id.
- Admin users scoped to a `client_id`.

## F-4 — Real Japanese phone number (telephony)
**What:** Callers dial a real Japanese number instead of using a web call.
**Why later:** Web calls need no phone number; phone setup waits for a paying client.
**Build when:** A paying client needs a dial-in number.
**Notes (re-verify before building):**
- Vapi's free numbers were reported as US-only and not usable for international calls. A Japanese number would need to be imported from a provider such as Twilio, Telnyx or Vonage.
- Twilio has no Japan processing region. If Twilio is chosen, pin the account to the AU1 (Sydney) region, and first re-check whether Twilio can issue and route usable Japanese numbers.
- Also compare NTT Com and KDDI.
**Base must allow:**
- No code assumes calls are web-only.
- Phone numbers stored in a form that can hold E.164 (`+81...`).
- `client.yaml` may later gain a `telephony` section; the schema must tolerate adding it.
- Server URLs come from `PUBLIC_BASE_URL`, never hard-coded.

## F-5 — Automatic language detection
**What:** Detect the caller's language automatically instead of the spoken "English" handoff.
**Why later:** Explicit selection via Squad handoff is more reliable; auto-detection needs testing first.
**Base must allow:** Language selection logic is isolated in the Squad/handoff configuration, not spread through prompts and code.

## F-6 — More languages (beyond Japanese and English)
**What:** Possibly 5–6 languages in total.
**Base must allow:** Languages are a list in `client.yaml`; the schema accepts any BCP-47 code; every script/FAQ entry is validated for every supported language; no language-specific code paths.

## F-7 — Premium tier pricing
**What:** Set the monthly price for this tier.
**Why later:** Needs real per-minute cost measurements from test calls.
**Note:** The earlier architecture notes estimated roughly $0.10–$0.40 per minute all-in and $270–450/month for a busy clinic. These figures are unverified — measure real costs from VP-2+ test calls before pricing.
**R7 data point (2026-09-20, see docs/VAPI-FACTS.md):** First real measurement — a 15.9s throwaway call (azure/ja-JP-NanamiNeural voice, azure/ja-JP transcriber, openai/gpt-4o-mini, static first message only, no reply turn) cost $0.0237 total (≈$0.089/min): transport $0.0002, transcriber(STT) $0.0102, Vapi platform fee $0.0133, model(LLM) $0, voice(TTS) $0. The $0 LLM/TTS is because no real conversational turn happened (the model was never invoked past the static greeting) — **this is a floor, not a usable per-minute figure for pricing.**
**R7b data point (2026-09-20, see docs/VAPI-FACTS.md):** Follow-up call with a real question-and-answer turn (project owner spoke a real reply) — 20.6s, $0.0307 total (≈$0.089/min): transport $0.0002, STT $0.0129, Vapi platform fee $0.0172, LLM $0.000028 (99 prompt / 22 completion tokens), TTS $0.000465 (31 characters). LLM/TTS are now non-zero (confirming R7's zeros were an artifact of no real turn, not a platform bug), but the per-minute total barely moved from R7 because Vapi's platform fee + transcriber are time-based and dominate at this call length — llm/tts are usage-based and only grow with longer/more replies. **≈$0.089/min is still a floor** — a real multi-turn FAQ conversation will cost more per minute than this single-short-exchange measurement. F-7 pricing should use $0.089/min as a lower bound, not a final number, until a longer multi-turn test call is measured.
**VP-3 data point — first real multi-turn conversation WITH a handoff (2026-09-21, see docs/VAPI-FACTS.md):** call `01a0c334-7807-7000-9393-7c2295722c93`, 144.7s, Japanese FAQ turns → handoff to English → English FAQ turn → handoff back to Japanese → goodbye. **$0.2111 total (≈$0.0875/min)**: transcriber (STT) $0.0814, Vapi platform fee $0.1206, LLM $0.0016 (10,185 prompt / 163 completion tokens), TTS $0.0049 (324 characters). **Handoff cost shape:** Vapi records the whole conversation as **one call** with the Squad's id (not one call per assistant), and the handoff itself is **not a separate charge** — the call's `costs[]` simply has one transcriber/model/voice line per assistant segment, but only a single Vapi platform-fee line. The earlier 43.5s R5 call (`01a0c208-780a-7779-8e38-08f0d546ead5`, throwaway assistants) gave the same picture at $0.0621 (≈$0.086/min). **Takeaway for pricing:** with real turns, LLM+TTS were only ~3% of the bill; STT + the Vapi platform fee (both time-based, ~96%) set the price, so **≈$0.088/min is now a much firmer figure than the R7/R7b floor**, and cost scales with *call duration*, not with model choice — cheaper models barely move it. Caveat: still one 2.4-minute call by a person who knew the script; long, meandering real callers (and the ~1.5s endpointing waits, which lengthen calls) will cost more per call.
**Base must allow:** Nothing in code. (Optional later: record call duration per client for cost reporting.)

## F-8 — Deployment target (open decision)
**What:** Where the server runs in production — not decided yet.
**Base must allow:**
- All configuration via environment variables.
- No reliance on local disk for anything that must persist (except local dev).
- The Vapi-facing server must be reachable over public HTTPS; local development uses a tunnel (e.g. ngrok or cloudflared) set in `PUBLIC_BASE_URL`.

---

---

## VP-6 backlog — conversation polish (found during VP-3; do not build yet)
Prioritized. Evidence for each is in docs/VAPI-FACTS.md ("VP-3 latency investigation").
1. **Answer latency: shorten the end-of-speech wait (highest value, small change).** The owner found the pause before answering an FAQ question too slow. Measured per turn: endpointing 1206ms avg of 2918ms total (≈41%), model only 425ms, voice 442ms, STT 366ms. Cause is the default `transcriptionEndpointingPlan.onNoPunctuationSeconds = 1.5`. Try lower values (e.g. 0.6–0.8) via the assistant's `startSpeakingPlan`, measure with `artifact.performanceMetrics`, and listen for callers being cut off. **Constraint from VP-4:** collecting a phone number needs *longer* patience (digits arrive in chunks) — use `onNumberSeconds` / `customEndpointingRules` so the callback flow is not made worse. Per-language values are fine (ja vs en).
2. **Japanese speech-recognition accuracy.** Two misrecognised turns on the opening question in the VP-3 call. First separate mic/speaker effects from Azure ja-JP quality (repeat with a headset); if it is the transcriber, compare another Japanese-capable provider — but only with a measured before/after, since a provider swap changes cost and the language table (VAPI-FACTS R1).
3. **Only if the model turns out to be slow later:** the "Ultra Fast" model preset / a faster model, and moving the FAQ out of the inline prompt (F-1 note: Knowledge Base). Today's evidence does *not* support this (model ≈425ms, prompt ≈1.7k tokens per turn) — do not start here.
4. **English pronunciation of the clinic name.** The English voice said something transcribed as "Sakura Saikatsuan"; listen, and if wrong consider a phonetic spelling in `business.name.en` (client.yaml) rather than code.
5. **Known gap (VP-3 §3.6): switching language mid-way through giving a name/phone number.** Not handled or tested. The full history transfers on handoff, so the new assistant may still know the partly-collected details, but nothing guarantees it resumes the callback flow. VP-4 (real callback logic) should be aware; VP-6 should test it.

## Suggested, not yet decided (do not build — raise with the owner)
- **S-1 Retention policy for callback personal data.** Callers' names and phone numbers are personal data under Japan's APPI (Act on the Protection of Personal Information). Decide how long callback rows are kept and how they are deleted.
- **S-2 AI disclosure in the greeting.** Consider saying "AI receptionist" in the greeting so callers know they are talking to an AI.
