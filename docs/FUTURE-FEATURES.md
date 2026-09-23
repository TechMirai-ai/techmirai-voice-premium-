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

## F-9 — Prompt guard for switching language mid-collection (name/phone)
**What:** If the caller asks to switch language while the assistant is in the middle of collecting
their name or phone number, finish collecting that one piece of information first, then hand off —
instead of switching immediately and losing the partly-collected detail.
**Why later:** Never observed on a real call — hypothetical edge case only. Dropped from VP-6
(2026-09-23) rather than spending test-call budget confirming it, since it's cheap to add whenever
it does come up.
**Build when:** A real call actually hits this (caller switches language mid-name/phone), or before
a client goes live if the owner wants it covered preemptively.
**The fix, ready to apply (no engineering, one prompt instruction):** in
`languageSwitchSection()` (`src/vapi/promptTemplate.ts`), add to the language-switching bullet list:
> "Exception: if you are in the middle of collecting the caller's name or phone number when they ask
> to switch languages, do NOT switch immediately. First finish collecting that one piece of
> information, in the current language, then call the handoff tool right after — never switch
> mid-collection and lose what you were in the middle of asking for."

This was drafted and reverted along with the rest of VP-6's original attempt (`git show e57103d --
src/vapi/promptTemplate.ts`) — the full history already transfers on handoff (VP-3), so the
destination assistant should be able to resume from context even without this, but the instruction
makes it explicit rather than relying on that.
**Base must allow:** Nothing — this is prompt text only, no schema/type change.

---

---

## VP-6 backlog — conversation polish (found during VP-3; do not build yet)
Prioritized. Evidence for each is in docs/VAPI-FACTS.md ("VP-3 latency investigation").
1. **Answer latency: shorten the end-of-speech wait (highest value, small change).** ~~Try lower values via the assistant's `startSpeakingPlan`.~~ **Implemented, not yet verified by a real call (2026-09-23) — see `docs/VAPI-FACTS.md` VP-6 R4.** Cause was the default `transcriptionEndpointingPlan.onNoPunctuationSeconds = 1.5` (≈41% of turn time). Fix: `smartEndpointingPlan: { provider: "vapi" }` (text-based, language-agnostic — `livekit` is English-only per Vapi's own docs) replaces the fixed wait for both `ja`/`en`, plus one `customEndpointingRules` entry giving a 2.5s timeout specifically for the turn right after the assistant asks for the phone number (regex-matched against that language's `scripts.askPhone` text), so the general speedup doesn't make the "digits arrive in chunks" problem worse. Synced to the real assistants; the next real call is what confirms the latency actually dropped and that the phone-number rule neither cuts callers off nor over-waits.
2. **Japanese speech-recognition accuracy.** Two misrecognised turns on the opening question in the VP-3 call. First separate mic/speaker effects from Azure ja-JP quality (repeat with a headset); if it is the transcriber, compare another Japanese-capable provider — but only with a measured before/after, since a provider swap changes cost and the language table (VAPI-FACTS R1).
3. **Only if the model turns out to be slow later:** the "Ultra Fast" model preset / a faster model, and moving the FAQ out of the inline prompt (F-1 note: Knowledge Base). Today's evidence does *not* support this (model ≈425ms, prompt ≈1.7k tokens per turn) — do not start here.
4. **English pronunciation of the clinic name.** ~~Listen, and if wrong consider a phonetic spelling in `business.name.en`.~~ **Implemented (2026-09-23) — see `docs/VAPI-FACTS.md` VP-6 R6.** Re-checked current Vapi docs/SDK/OpenAPI spec first (no Azure pronunciation-hint mechanism exists, confirmed again). Fix: a new optional `business.namePronunciation` field (kept separate from `business.name`, which stays the correct written romanization) — set to `Sakura Say-koh-tsoo-in` for `en` in `client.yaml`, used only when filling the spoken `[[clinicName]]` placeholder and the prompt's own Identity line. Synced and confirmed live on the standalone EN assistant and the JA→EN handoff override alike.
5. ~~Known gap (VP-3 §3.6): switching language mid-way through giving a name/phone number.~~ **Dropped from VP-6 (2026-09-23) — moved to F-9 below.** Never observed on a real call; not worth spending test-call budget on right now.
6. **Real bug found 2026-09-22: the assistant sometimes skips the spoken goodbye entirely and silently ends the call.** ~~This is VP-6 §G's "natural end-of-call" test item — it currently fails.~~ **Fixed and verified live (2026-09-23) — see `docs/VAPI-FACTS.md` VP-6 R2/R3.** Root cause was two-fold: (a) the model sometimes jumped straight to the silent `endCall`/`log_call_topic` tool calls without a `bot` goodbye message in between (confirmed on unmodified `main`, not a VP-6 A–E regression); (b) the fix — Vapi's `assistant.endCallMessage`, spoken automatically by the platform before hangup — doesn't carry over to an assistant reached via Squad handoff and had to be threaded through the handoff destination's `assistantOverrides`, same as `firstMessage`. Confirmed by real test calls: Japanese standalone goodbye and English goodbye-after-handoff both play correctly now.

## Suggested, not yet decided (do not build — raise with the owner)
- **S-2 AI disclosure in the greeting.** Consider saying "AI receptionist" in the greeting so callers know they are talking to an AI.

---

## VP-5 decisions: retention, access, and escaping for callback personal data

The staff dashboard (VP-5) is the first screen that displays `callback_requests.reason` to a
human. VP-4's security review already flagged that `reason` — a caller's own words about why
they're calling — often qualifies as health information under Japan's APPI (Act on the
Protection of Personal Information: 個人情報保護法 — Personal Information Protection Act),
which carries stricter handling expectations than a plain name or phone number. These three
points are the explicit, written decision required before VP-5 could ship, replacing the old
"S-1" placeholder above.

1. **Retention — still an open gap, not silently ignored.** No retention policy exists yet:
   `callback_requests` rows are kept forever, `handled` or not, with no automatic deletion. This
   is fine for the internal demo (one clinic, low volume, an audience that knows the data is
   there), but it must not reach a real client this way. **Build when:** before onboarding the
   first real paying clinic. Decide then, with legal input if available: how long a `handled` row
   is kept, whether `reason` specifically should be deleted or anonymized sooner than the rest of
   the row (since it is the field most likely to hold health information), and whether deletion is
   a scheduled job, a manual admin action, or both.
2. **Access — a conscious choice for one clinic, revisit at the second.** Today there is one
   staff role (`admin`) and one clinic, so anyone who can log in sees every `reason` for that
   clinic — there is no narrower "callbacks only, no health detail" view. This is a deliberate
   choice for VP-5's scope, not an oversight. **Build when:** F-3 (a second real clinic) or a
   clinic asks for more than one staff role — `staff_users.role` (already a string, not a fixed
   enum, per §4.2) is designed so a narrower role needs no schema migration, just new
   authorization logic in the dashboard routes.
3. **Escaping — resolved now, not deferred.** Every place `reason` (or any other caller-supplied
   free text) is written into a dashboard page goes through `src/lib/htmlEscape.ts` — see
   `src/routes/staffViews.ts`. This was a hard requirement for VP-5 itself: `reason` is both
   untrusted (caller-controlled) and potentially sensitive (may hold health information), so
   letting it render as live markup would be both an XSS vector and a way for sensitive content to
   end up somewhere unexpected (e.g. exfiltrated via injected script). Covered by an automated
   test that injects HTML-like content and asserts it renders as inert text
   (`tests/routes/staffDashboard.test.ts`).
