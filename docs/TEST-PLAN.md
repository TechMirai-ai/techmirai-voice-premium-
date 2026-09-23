# End-to-end test plan (VP-6)

Manual real-call test script for `sakura-seikotsuin`, covering every conversational flow the
assistant supports. Rebuilt from the current code (`src/config/schema.ts`'s `SCRIPT_KEYS`, one
flow per script) plus everything VP-6 actually learned from real calls: three separate bugs today
looked completely configured — correct types, correct payload, synced and confirmed live via the
Vapi API — and still silently didn't work at runtime. Read "How to verify" below before running
anything.

Every Japanese phrase below is followed by its English meaning in parentheses, per CLAUDE.md.

## How to verify a flow — read this first

**A flow "sounding right" on the call is not enough.** All three real bugs found during VP-6 would
have passed a casual listen:

- **The goodbye-skip bug** — the call just ended. Nothing sounded wrong; there was simply no
  goodbye. Easy to not notice if you're not specifically listening for it.
- **The confirmDetails-skip bug** — the assistant sounded natural and confident the whole way
  through; it just quietly skipped the one line where the caller could have caught a misheard name
  or phone number. Inconsistent, too — it worked correctly on one call and skipped it a few calls
  later with no code change in between.
- **The endpointing no-op** — `smartEndpointingPlan` was correctly saved, confirmed live via
  `GET /assistant`, and *looked* like an active setting. It had zero effect: the "smart" provider
  silently used the exact same 1.5s wait as before, because it reads its own thresholds from
  `transcriptionEndpointingPlan`, which was never set. Nothing about the config was wrong — it was
  just incomplete in a way that degraded to identical old behavior instead of failing loudly.

**The common thread: each one degraded silently to something that looked like acceptable behavior
instead of an obvious failure.** So for every flow below, do not conclude "pass" from how the call
sounded alone. After the call:

1. **Pull the real transcript** — `GET /call/{id}` from the Vapi Calls API — and read
   `artifact.messages` line by line. Confirm the specific scripted line you expect actually appears
   as its own `bot` message, in the right place, not skipped or merged into something else.
2. **For anything timing-related**, check `artifact.performanceMetrics.turnLatencies` — don't trust
   a subjective "felt faster." A flat, suspiciously round number repeated on every turn (like the
   1500ms that gave away the endpointing bug) is itself a signal something isn't engaging.
3. **For anything platform-guaranteed** (`endCallMessage`, tool `server.url`, `startSpeakingPlan`),
   re-fetch the live resource via the Vapi API (`GET /assistant/{id}`, `GET /tool/{id}`,
   `GET /squad/{id}`) and confirm the field is actually present with the value you expect — synced
   locally is not the same as live and correct.
4. **Run each flow at least twice** before calling it reliable. Both the goodbye bug and the
   confirmDetails bug were intermittent — the exact same prompt passed on one call and failed on
   another with no change in between. A single pass proves nothing; a single fail proves there's a
   real problem.

## Setup

1. Tunnel up and reachable: `curl -s -o /dev/null -w '%{http_code}' https://<your-ngrok-dev-domain>/healthz` → `200`.
2. `npm run dev` running.
3. Test page current: `npm run vapi:test-page -- sakura-seikotsuin` (regenerate after every sync).
4. Open `http://127.0.0.1:3000/vapi-test-call/sakura-seikotsuin--squad.html` — **`127.0.0.1`, not
   `localhost`** (see `docs/VAPI-FACTS.md`, "KNOWN ISSUE").
5. Each call costs real money (~$0.08–0.10/min) — don't loop retries mindlessly; verify via
   transcript before assuming a re-test is needed.

## Flows

### G1 — Greeting and a plain FAQ answer
Say nothing at first — confirm the greeting plays in full. Then ask something matching a FAQ entry
(e.g. hours: 「受付時間を教えてください」("please tell me the reception hours")).
**Verify:** the answer matches the FAQ content, clinic placeholders (`[[clinicName]]` etc.) are
filled with real text, not literal brackets. Confirm it then asks `anythingElse`
(「ほかに何かお手伝いできることはございますか？」/ "Is there anything else I can help you with
today?") — this must follow **every** FAQ answer, not just the first one.

### G2 — No FAQ match → callback flow → confirmDetails → save
Ask something off-FAQ. Confirm it says `noMatch`, then asks for your name, then `askPhone`
(「ありがとうございます。スタッフからご連絡できるお電話番号を教えていただけますか？」/ "Thank
you. May I have a phone number where our staff can reach you?").
**This is the highest-value check in the whole plan, per the confirmDetails-skip bug above.**
After giving the phone number, confirm:
- `confirmDetails` plays as **its own separate turn** — 「確認いたします。お名前は…お電話番号は…で
  よろしいでしょうか？」("Let me confirm. Your name is ___, phone number is ___, is that
  correct?") — not merged with the phone-number question or the save confirmation.
- The assistant **waits** — no tool call should appear in the transcript between you giving the
  number and you answering the confirmation question. Pull the transcript and check the
  `tool_calls` timestamp is *after* your "yes," not before.
- Say something wrong on purpose once (give a digit wrong when confirmed) and confirm it corrects
  and re-confirms rather than saving the wrong number.
- After it saves, confirm `anythingElse` fires again (same instruction as G1, different branch —
  this was the exact prompt-coverage gap found today).

### G3 — Callback save failure (staff-contact path)
Hard to trigger deliberately without breaking the tunnel — covered opportunistically. If the tunnel
happens to be down or a webhook fails, confirm `callbackFailed` plays
(「申し訳ございません。システムの不具合により、お客様の情報を保存できませんでした。お手数です
が、当院（電話番号）まで直接お電話ください。」/ "I'm sorry, I wasn't able to save your details
because of a system problem. Please call the clinic directly at [number].") with the real clinic
phone number substituted, not the placeholder text.

### G4 — Explicit staff request
Say something like 「スタッフにつないでください」("please connect me with a staff member") without
asking a question first. Confirm it goes straight to `staffContactOffer`, not `noMatch` — these are
two different scripted branches for two different triggers.

### G5 — Language handoff, both directions
From the Japanese greeting, say "English" or 「英語」. Confirm the English arrival greeting plays
(uses the phonetic pronunciation override, VP-6 D — should sound like "Sakura Say-koh-tsoo-in," not
the written spelling). Ask an English FAQ question, confirm it answers correctly. Then say
"Japanese" or 「日本語」 to hand back — confirm `handoffToJapanese` plays
(「日本語の受付にお繋ぎしました。ご用件をお聞かせください。」/ "Connected back to Japanese
reception. Please tell me what you need."). Test the handoff **mid-call**, not just at the start —
after already answering a question in one language.

### G6 — Emergency
Say something indicating a medical emergency (e.g. describing severe pain and explicitly asking
what to do). Confirm the `emergency` line plays instead of continuing the normal flow
(directs to call `119`, the real `emergencyNumber`), that it does **not** attempt to collect a name
or phone number, and does **not** call `request_callback`. Pull the transcript afterward and
confirm `log_call_topic` was still called with `topic: "emergency"` — classification must still
happen even on the emergency path.

### G7 — No medical advice
Ask for a specific medical recommendation (e.g. "what medicine should I take"). Confirm
`noMedicalAdvice` plays and the assistant does not attempt to answer the medical question itself,
then continues the conversation normally afterward (this is a deflection, not a call-ending event).

### G8 — Didn't-catch / misheard speech
Say something intentionally mumbled, or ask a genuinely unclear question. Confirm `didNotCatch`
plays (「申し訳ございません。うまく聞き取れませんでした。もう一度おっしゃっていただけますか？」/
"I'm sorry, I didn't quite catch that. Could you say it again, please?") and the assistant does not
guess at an answer to garbled input. **Known gap, not a regression:** the current prompt only
covers "I didn't understand" — it has no explicit instruction to treat a *grammatically-valid-but-
garbled* transcript (e.g. STT truncating the start of a sentence) as "didn't catch," which VP-6
observed twice on real first turns. Deprioritized as a refinement, not a broken feature — see
`docs/FUTURE-FEATURES.md`'s VP-6 backlog item 2. Test it, but don't treat an inconsistent result
here as a new bug; it's a documented, accepted limitation.

### G9 — Phone number given in chunks (endpointing)
Trigger the callback flow (G2) and when asked for your phone number, read it back in paused
chunks — e.g. "090…" *(pause ~1–2s)* "1234…" *(pause)* "5678," the way people actually recite
digits. Confirm the assistant waits through the pauses instead of cutting in after the first chunk.
**Verify via transcript, not just by feel:** the whole number should land in a single `user`
message, not fragmented across several. Pull `performanceMetrics` and confirm that specific turn's
`endpointingLatency` is noticeably higher than the general ~700ms (the `customEndpointingRules`
override is 2.5s) — if it's ~700ms like every other turn, the phone-number exception silently
isn't firing.

### G10 — Natural end-of-call (goodbye)
End a call with a short, low-content reply (e.g. 「いいえ、大丈夫です」/ "No, that's fine") — this
exact phrasing is what triggered the original goodbye-skip bug. Confirm the goodbye plays **before**
the call actually disconnects, both:
- **Standalone** — ending the call on the assistant that started it (Japanese, or English via
  `--ja.html` / a JA-only test).
- **After a handoff** — end the call on whichever language you were handed off *to* mid-call. This
  is the harder case: `endCallMessage` does not carry over across a handoff automatically and has
  to be threaded through `assistantOverrides` — test this leg specifically, not just the easy one.

Verify via transcript: `costBreakdown.ttsCharacters` for the call should include the goodbye
text's character count, not just the last FAQ answer's — a flat/unchanged character count is the
same signal that gave away the original bug (zero characters spent on the goodbye).

### G11 — General answer latency
Ask a plain FAQ question (G1) and subjectively judge whether the pause before the answer feels
short. Then confirm objectively: pull `performanceMetrics.turnLatencies` for that turn and check
`endpointingLatency` is around 700ms, not 1500ms. A perceived "feels faster" without checking this
number is exactly how the original no-op went unnoticed for a full config-and-sync cycle.

## Known fragile points — watch for regressions here specifically

These three are proven-fragile, not hypothetically risky — each already broke silently once:

1. **`endCallMessage` not carrying across a handoff.** Any future change to squad/handoff rendering
   should re-test G10's "after a handoff" case specifically, not just the standalone case.
2. **`confirmDetails` reliability.** This is a prompt-instruction fix, the same class as the
   original goodbye bug (instruction present, model doesn't always follow it) — not a platform
   guarantee. If G2 shows another skip after this fix, the next step is `rejectionPlan` or
   `bot_say` (both real, already researched — see `docs/VAPI-FACTS.md` VP-6 R7), not another prompt
   reword.
3. **`smartEndpointingPlan` silently degrading to the old default.** Any future change to
   `startSpeakingPlan` must keep `transcriptionEndpointingPlan` set explicitly alongside it, or
   re-verify via G11's `endpointingLatency` check that it hasn't quietly reverted to ~1500ms.

## Deliberately out of scope for this pass

- **Misheard-speech recovery refinement** (G8's known gap) — informally working, not broken;
  see `docs/FUTURE-FEATURES.md` VP-6 backlog item 2.
- **Mid-collection language switch** (caller asks to switch language while giving name/phone) —
  dropped from VP-6, never observed on a real call. Ready-to-apply fix in
  `docs/FUTURE-FEATURES.md` F-9 if it ever comes up.
- **Speaking-style/tone (warmer callbackSaved/callbackFailed wording)** — confirmed no Vapi
  mechanism exists for this; the wording itself needs native-speaker review, tracked in
  `docs/JAPANESE-REVIEW.md`, not a testable code behavior.
