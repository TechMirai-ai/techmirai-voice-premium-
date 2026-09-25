# VP-7 test results — `04-test-suite.md` run through the local text-tester

**Status (2026-09-25): complete.** Every suite id (cases 1–31, E1–E6) was run — Japanese (`ja`) first, then cases 2–26 again in English (`en`) — on the final prompt, **3 samples per scenario at production temperature (0.5)**. **Final: 23 PASS · 9 PARTIAL · 5 FAIL** (the morning baseline was 16 PASS · 10 FAIL · 1 PARTIAL · 1 INCOMPLETE · 9 NOT RUN).

Every Japanese string below is followed by its English meaning in parentheses. Nothing here has been proven on a real Vapi call — see §6.

## 1. What you asked for, and what happened

| Fix requested | Baseline (old prompt, 1 sample) | Final (3 samples, t=0.5) |
|---|---|---|
| **Calls ending reliably** | `log_call_topic` + `endCall` in 1 of 4 endings; the model usually spoke a goodbye and made no tool calls (call left open, possible double goodbye) | **Every normal ending — 27 of 27 (`ja` 15/15, `en` 12/12) — was the silent `log_call_topic` → `endCall` pair, nothing spoken.** The 12 endings where the model speaks a goodbye *by design* (emergency ×9, three-strikes ×3) all hung up through the platform `endCallPhrases` backstop (12/12). Classification is still model-dependent — see F-10 |
| **Phone digit read-back** | All three checks failed in the single sample: `090…5678` read as `ゼロキューニイ…ゴナナハチ` (a 0→2 and a dropped 6); a 10-digit number was read back instead of re-asked | `ja` cases 17 / 18 / 20: **3/3, 3/3, 3/3**; `en`: **3/3, 3/3, 3/3**. Not perfectly stable in Japanese: over four runs of this same digit wording `ja` 17 and 20 together were right 19 of 24 times (≈ 80 %) — see §5 |
| **23b emergency skip** | The "possibly serious" 119 line was skipped; the medical-advice refusal was used instead | **`ja` 3/3, `en` 3/3**, then normal flow resumes and the call ends silently. Control: the untouched committed prompt scored **0/6** (3 `ja` + 3 `en`) on the same scenario |
| **Two greeting mismatches** | `ja` said "reception" with no AI and promised `お取り次ぎ` (putting you through); `en` said "English receptionist" | Both now equal the suite's wording exactly (case 1, E1) |

**Two things I broke while fixing, then fixed** (both found by testing; the original prompt did neither):
1. My first emergency-precedence wording made English say the 119 line for *any* pain ("My back hurts", "I twisted my ankle": 6 of 6 wrong; the original prompt: 0 of 6). Fixed with a per-language trigger-word list in `client.yaml` (`severePainWords`) and by removing quoted example injuries from the prompt (quoting them *primed* the behaviour). Now back pain is 0 of 6 wrong in both languages; English ankle is 2/3.
2. Reusing the "didn't catch it" line for a wrong-length number fed the three-strikes hang-up (a valid number was rejected, then the call ended). Fixed with its own `phoneRetry` script.

**Not fixed — failures in areas you did not ask me to touch:** cases 14, 15, E6, the wrong `outcome` after a callback, Sunday/"tomorrow" hours, and emergency calls not being logged. All in §4–§5 with evidence.

## 2. What changed in the repo (uncommitted)

| File | Change |
|---|---|
| `src/vapi/callEnding.ts` (new) | `endCallPhrasesFor()` + `silenceHangupHook()` (`customer.speech.timeout`, 40 s, one-shot, action = built-in `endCall`) |
| `src/vapi/render.ts`, `squad.ts`, `types.ts` | `endCallPhrases` and `hooks` set on every assistant **and** on each handoff leg's `assistantOverrides` (VP-6 R3: legs don't reliably inherit) |
| `src/vapi/promptTemplate.ts` | digit read-back rules + worked example + wrong-length rule; emergency precedence (check first, trigger words, resume normally, answer the original question); medical-advice line scoped to advice requests; ending = tool calls only, never announce them, with per-language "caller is finished" examples; an explicit "no" is a clear decline; hours for today/tomorrow must be answered for that exact weekday |
| `src/config/schema.ts` | optional per language: `endCallPhrases`, `callerDoneExamples`, `severePainWords`, `phoneReadback {digitWords, example}`; new script `phoneRetry` |
| `clients/sakura-seikotsuin/client.yaml` | the data for all of the above; both greetings; `repeatedMisunderstanding` now ends with the closing phrase |
| `tests/vapi/*`, `tests/config/checkCli.test.ts` | pinned wording updated and new tests added (`callEnding.test.ts`, prompt guards). **448 tests pass; typecheck, lint and prettier clean** |
| `docs/` | `VAPI-FACTS.md` **VP-7 R8** (the platform-guarantee research, sources, what is unverified); `FUTURE-FEATURES.md` **F-10** (end-of-call classification — recorded, not built, as you asked) and S-2 marked adopted; `JAPANESE-REVIEW.md` §9 plus the changed greeting / three-strikes line |

Not done: nothing synced to Vapi (`npm run vapi:sync`), no real test call, no commit.

## 3. How this was run — read before trusting a number

Runner: `docs/vp7-test-runs/run-suite.ts.txt` (rename to `.ts`; `TEMPERATURE=<n>`, `FAKE_NOW=<iso>`, `--sample k`, `@ja` / `@en`). It reuses `loadRenderedMember`, `buildToolDefs`, `initialMessages` and `makeOpenAiCaller` from the committed `src/vapi/textTester.ts`. Transcripts (system prompt, every message, every tool call with raw JSON arguments and result) are in `docs/vp7-test-runs/`:

| Directory | What it is |
|---|---|
| `run2-t0.5/` | **The final results below:** final prompt, temperature 0.5, 3 samples × 32 scenarios |
| `run2-t0.5-fakenow/` | Same prompt with the clock pinned to a Sunday / Saturday (case 2 and E2 closed-day branches) |
| `run1-baseline/` | The morning baseline (old prompt, 1 sample) |
| `run2-head-baseline/` | **Control:** the untouched committed prompt, 3 samples of back pain / ankle / 23b |
| `tempstudy-t{1.0,0.5,0.2}/` | Temperature study on the prompt revision *before* the Sunday-hours sentence (repeated system prompt stripped to save space) |

Gaps in the committed tester that the runner works around — **each is worth fixing in `textTester.ts`**:
1. **Temperature.** The tester sends none, so OpenAI's default **1.0** applies; Vapi's default (and this repo, which sets none) is **0.5**. Results earlier today ran too hot. *Lowering it is not a lever:* 168/213 checks pass at 1.0, 176/213 at 0.5, 173/213 at 0.2 — noise. I did not change production temperature.
2. **`{{"now" | date: …}}` is not rendered** (Vapi's Liquid); the runner substitutes the real Asia/Tokyo time (or a pinned one).
3. **Tool results:** the tester answers `"Success."` to everything; the runner returns production's strings.
4. **Phrase hang-up is emulated** (the assistant saying an `endCallPhrase` ends the call); the real behaviour is unproven.

Other limits: related cases share one conversation (a wrong early turn affects later ones — case 10 showed it); 21b and one 21c variant start from a hand-built history (21c was also run as a real flow); grading is objective regex checks over the transcripts, with the failing ones read by me — three samples give a rate, not a guarantee; barge-in timing, TTS pronunciation, the real Squad handoff, `firstMessage` "plays once" and 30b's server-side abandoned record cannot be tested in text.

## 4. Results, case by case

`ja` and `en` are pass counts out of 3 (final, t=0.5). PASS = all samples pass; PARTIAL = some pass; FAIL = most fail or a hard expectation of the suite is unmet.

| Case | Verdict | ja | en | Evidence / reason |
|---|---|---|---|---|
| 1 Greeting | **PASS** | config | — | `firstMessage` = 「お電話ありがとうございます。さくら整骨院、AI受付でございます。For English, please say "English". どのようなご用件でしょうか。」 (Thank you for calling. This is Sakura Seikotsuin, AI reception. For English, please say "English". How may I help you?) — identical to the suite. Checked from config, no API call |
| 2 Hours | PARTIAL | 3/3 | 3/3 | Friday: correct. **Sunday variant:** `en` 3/3 ("We're closed today, as it's Sunday."); `ja` **1/3** — twice said 「当院は本日、午後7時まで営業しております」 (We're open until 7 p.m. today) on a Sunday |
| 3 Appointment required? | PASS | 3/3 | 3/3 | FAQ answer, two short sentences |
| 4 Booking | PARTIAL | 2/3 | 3/3 | one `ja` sample asked about the reason after the caller said they want to book by phone (forbidden). See also **4-log** below |
| 5 Fees | PASS | 3/3 | 3/3 | no amount ever stated |
| 6 Back pain | PASS | 3/3 | 3/3 | service answer, no 119 line (the original prompt never said it; my first rewrite did — fixed) |
| 7 Sports injury | PARTIAL | 3/3 | 2/3 | one `en` sample: "If this is an emergency, please hang up and call 119…" for a twisted ankle |
| 8 Insurance | PASS | 3/3 | 3/3 | no yes/no on coverage |
| 9 Location | PASS | 3/3 | 3/3 | address + website map; no invented walking time |
| 10 Parking (by meaning) | PARTIAL | 2/3 | 3/3 | `ja` chain sample: right after the agent asked for a name, 「車で行っても大丈夫ですか？」 (Is it OK to come by car?) got the can't-answer + name request. Standalone run: correct |
| 11 First visit | PASS | 3/3 | 3/3 | mentions マイナ保険証 (My Number health insurance card) / 資格確認書 (eligibility certificate) |
| 12 Unknown question | PASS | 3/3 | 3/3 | a plain "no" is accepted as a decline; call then ends silently |
| 13 Caller asks for staff | PASS | 3/3 | 3/3 | never claims to transfer |
| 14 Name collection | **FAIL** | 1/3 | 3/3 | `ja` family name only (「ヤマダです」 It's Yamada): 「ヤマダ様ですね。お電話番号を教えていただけますか？」 (Mr./Ms. Yamada. Your phone number?) — never asks for the given name. *Not in scope; not fixed* |
| 15 Unclear name | **FAIL** | 0/3 | 3/3 | `ja`: 「や…だ…です」 (Ya… da… it is) → 「ヤダ様ですね」 (Mr./Ms. Yada) — guessed and read back, 3 of 3. *Not in scope; not fixed* |
| 16 Name reading | PARTIAL | 3/3 | 3/3 | reads 「ショウジ様ですね」 (Mr./Ms. Shoji) in katakana, never asks how it is written; `callerName` in the tool call is **not exercised** (this run stops before the save) |
| 17 Phone read-back | PASS | 3/3 | 3/3 | 「…お電話番号はゼロキュウゼロ、イチニーサンヨン、ゴーロクナナハチでよろしいでしょうか？」 (…phone number is zero-nine-zero, one-two-three-four, five-six-seven-eight, is that right?) parsed back to `09012345678`. **Stability caveat in §5** |
| 18 Wrong digit count | PASS | 3/3 | 3/3 | 「090の1234の567です」 → 「恐れ入ります、少し聞き取れなかったようでして、もう一度お電話番号をお願いできますでしょうか。」 (Excuse me, I seem not to have caught that — could you give the phone number again?) — no read-back, no tool call |
| 19 "No" to read-back | PASS | 3/3 | 3/3 | asks again, no tool call |
| 20 Partial correction | PASS | 3/3 | 3/3 | corrected group only, full read-back, no tool call. *In earlier runs of this wording `ja` was 1/3–3/3, e.g. 「…ゴーロクナナゴー、キュウ」 (…five-six-seven-five, nine) — an inserted digit* |
| 21 Confirm → save | PARTIAL | 3/3 | 2/3 | `ja`: `request_callback {"callerName":"ヤマダタロウ","callerPhone":"09012345678","reason":"電話での予約希望"}` (reason: wants to book by phone). `en`: `{"callerName":"ヤマダ タロウ","callerPhone":"09012345678",…}` — an English caller's name saved in **katakana**; the template's Japanese example primes it |
| 21b Aizuchi | PASS | 3/3 | — | seeded: truncated read-back + 「はい」 (uh-huh) → **no tool call**, number re-read, waits |
| 21c Tool failure | PASS | 3/3 (real flow) | 3/3 | `request_callback {"callerName":"ヤマダ タロウ","callerPhone":"09012345678","reason":"スタッフに代わってもらいたい"}` → error → 「申し訳ございません。システムの不具合により、お客様の情報を保存できませんでした。お手数ですが、少し時間をおいて改めてお電話いただけますでしょうか。失礼いたします。」 (I'm sorry, a system fault stopped your details being saved. Please call again a little later. Goodbye.); no 048-000-0000. The *seeded* variant is only 1/3 — the model promises to pass the details along without calling the tool; it is 3/3 in a real flow, so I treat the seed as the artifact, but it is a warning sign |
| 22 Medical advice | PASS | 3/3 | 3/3 | refusal line, no patch/ice/heat advice |
| 23 Emergency | **FAIL** | see right | see right | **23a**: 119 line said at once and the call ends via 失礼いたします / "Goodbye." — 3/3 both languages — but **no `log_call_topic(emergency)` in any sample (0/3 `ja`, 0/3 `en`)**. **23b: 3/3 in both languages:** 「緊急の場合は、このお電話を切って、すぐに119番で救急車を呼んでください。…」 (If it's an emergency, hang up and call 119 right away…) → 「いや、救急車ほどではないです」 (No, not that bad) → hours/booking → `log_call_topic {"topic":"back-pain","outcome":"resolved"}` + `endCall {}` |
| 24 Caller interrupts | PARTIAL | 2/3 | 3/3 | one `ja` sample re-explained online booking instead of just acknowledging. Barge-in itself untestable |
| 25 Topic change | PASS | 3/3 | 3/3 | follows the new topic |
| 26 Multiple questions | PASS | 3/3 | 3/3 | both answered |
| 27 JA→EN handoff | PASS | 3/3 | — | `handoff_to_en {"destination":"en"}`, nothing spoken. 27b 「子どもが英語の授業中にケガをして…」 (My child got hurt during English class…) → no handoff (though the reply led with the 119 line) |
| 28 EN→JA handoff | PASS | — | 3/3 | `handoff_to_ja {"destination":"ja"}`, nothing spoken; `squad.ts:131` routes it to `ja-return` (first message 「日本語の受付にお繋ぎしました。ご用件をお聞かせください。」 Connected you to Japanese reception. What do you need?) |
| 29 Unclear speech | PARTIAL | 0/3 | — | 3rd failure: 「申し訳ございません。お電話が遠いようですので、お手数ですが、少し時間をおいておかけ直しいただけますでしょうか。失礼いたします。」 (…please call again a little later. Goodbye.) → hangs up via the phrase 3/3 (no log). **But the 2nd failure repeats the 1st verbatim, 3/3** (suite: different wording) — only one `didNotCatch` script exists. Counted 0/3 because the check requires both |
| 30 Caller ends call | PASS | 3/3 | 3/3 | `log_call_topic {"topic":"hours","outcome":"resolved"}` + `endCall {}`, nothing spoken. 30b: no `request_callback` when the call stops mid-collection ✔ (server-side "abandoned" record untestable) |
| 31 "Are you a person?" | PASS | 3/3 | — | says it is the AI, no leading はい (yes) |
| E1 EN greeting | **PASS** | — | config | "Hello, you've reached Sakura Say-koh-tsoo-in. This is the clinic's AI receptionist, speaking in English. How can I help you today?" — identical to the suite |
| E2 Hours with a date | PARTIAL | — | 3/3 | ordinary date correct. **Saturday → "open tomorrow?" (Sunday): 0/3** — "Yes, we are open tomorrow, which is Sunday, but we are actually closed on Sundays." (contradicts itself) |
| E3 Callback read-back | PASS | — | 3/3 | "…zero eight zero, seven seven zero eight, three zero zero four. Is that correct?" → `request_callback {"callerName":"Taro Yamada","callerPhone":"08077083004","reason":"sore back"}`. (Earlier temperature runs 0–2/3: sometimes falsely rejects a valid number as too short) |
| E4 Emergency (en) | **FAIL** | — | 3/3 · 0/3 | "Please hang up and call one-one-nine for an ambulance right away." → "Goodbye." → call ends via the phrase 3/3; **no `log_call_topic(emergency)` 0/3** |
| E5 Medical advice | PASS | — | 3/3 | no ice advice |
| E6 Staff request | **FAIL** | — | 0/3 | "Of course. I can pass your details to our staff so they can call you back. **May I have your name, please?**" 3/3 — asks for the name before the caller agrees (suite: no name until they agree) |

**Also failing, outside the numbered cases — 4-log:** after a callback is taken the model logs `{"topic":"appointment-needed","outcome":"resolved"}` (**0/3 `ja`, 0/3 `en`**); the prompt says `unresolved`.

**Every-call checks (suite header):** normal endings silent and paired ✔ (27/27); the Japanese assistant never spoke English in the transcripts I read; no `[[ ]]` leakage and no invented facts in the failing transcripts I read (spot-checked, not exhaustively machine-checked); no name asked after a normally answered question except the case 10 chain. **Fails:** exactly one `log_call_topic` per call — emergency and phrase-ended calls have none.

## 5. Remaining problems, in the order I would fix them

1. **Emergency calls are never logged (0/6 across `ja`/`en`, at every prompt wording I tried) and the `outcome` is wrong after a callback (0/6).** The model calls tools only when it is not speaking — it will not call `log_call_topic` in the same turn as the 119 line, and the platform phrase now ends the call right after the goodbye. This is exactly what **F-10** (structured-output classification via `end-of-call-report`) exists for; I recorded it as you asked and did not build it. It is now the top item.
2. **Digit read-back is much better but not fully reliable in Japanese (≈ 80 %).** It never corrupts the saved number (the tool argument was `09012345678` every time) — the risk is a caller "confirming" a misread. A structural fix: have a tool or the server return the canonical spoken string and let the model read it verbatim.
3. **Hours on the wrong day.** Sunday: `ja` says "open until 7" 2 of 3; "open tomorrow?" (Sunday) contradicts itself 3 of 3. The model cannot do weekday arithmetic reliably; Vapi's Liquid may be able to render "tomorrow" (unverified — needs a real call).
4. **Names:** guessed on unclear speech (15, `ja`), family-name-only accepted (14, `ja`), English names saved in katakana (21, `en`).
5. **E6** asks for the name before consent; **case 29** repeats the same sentence (add a second `didNotCatch` variant).
6. **Model variance** at the edges: 4, 7, 10, 24 each fail in about 1 of 3 samples.

## 6. Unverified — needs real calls (the text tester cannot exercise these)

> **KNOWN GAP — expect it on the first emergency test call:** an emergency call will almost certainly end with **no `call_topics` row** (`log_call_topic(emergency)` was called 0 of 6 times in text tests; the platform hang-up phrase ends the call right after the goodbye). That is not a sync or deployment fault — it is the gap **F-10** in `FUTURE-FEATURES.md` exists to close. Decision taken 2026-09-25: note it, verify the voice behaviour first, build F-10 only if the real calls show it matters.

**Minimum-credit call plan (3 short calls):**
1. **Normal call, Japanese:** ask today's hours, then say 「ありがとうございました」 (Thank you very much) → expect the silent `log_call_topic` + `endCall`, the system goodbye played **once**, `endedReason` = `assistant-ended-call`, one `call_topics` row.
2. **Emergency call, Japanese:** say 「父が転んで頭を打って、意識がはっきりしないんです」 (My father fell and hit his head and isn't fully conscious), then 「わかりました」 (Understood) → expect the 119 line, then 「失礼いたします」 (Goodbye) and a hang-up (`endedReason` = `assistant-said-end-call-phrase`), the goodbye **not** doubled by `endCallMessage`, and — expected gap — probably no `call_topics` row.
3. **Handoff call:** say "English, please", ask an hours question, then say "thank you" → expect the English greeting (no "English receptionist"), and that the English leg also ends by tool or phrase (this is where the `assistantOverrides` threading is proven or not).

The silence hook (40 s) needs a fourth call where you say nothing; skip it if credit is tight.

`endCallPhrases` actually hanging up; whether `endCallMessage` *also* plays when a phrase ends the call (double goodbye); whether the phrases and hook carry across the handoff (I threaded them through `assistantOverrides`, as for `endCallMessage`, and shape-checked the payload against the live OpenAPI, but that is not a call); the 40-second silence hook; and `失礼いたします` never appearing mid-sentence in normal speech (it would hang up on a caller). To verify: `npm run vapi:sync`, then one normal call, one emergency call and one silent call — check `endedReason`, that the goodbye plays once, and whether `call_topics` has a row for the emergency call.

## 7. Request accounting

2,699 OpenAI requests today in total (the baseline, the iteration runs, four full 96-transcript runs, the controls), all `gpt-4o-mini`, no failed requests, far under the real 10,000/day limit — see `docs/vp7-test-runs/ledger.json`. New untracked files: `docs/VP7-TEST-RESULTS.md`, `docs/vp7-test-runs/`, `src/vapi/callEnding.ts`, `tests/vapi/callEnding.test.ts`. The transcripts hold only the suite's synthetic caller data (「ヤマダ タロウ」 Yamada Taro, 090-1234-5678).

## 8. Addendum (2026-09-25, after the first real calls): the emergency "loop" — root cause and status

**Report:** on a real call the caller said it was an emergency, the agent said "hang up and call 119", the caller said "ok thank you", and the agent repeated the 119 line over and over.

**What I found (all from the call's own log, `docs/vp7-test-runs/prod-call-01a0d7e1/`):**
1. **Not reproducible with a normal conversation** — 30 of 30 text-tester runs (clear emergencies, both languages) ended after the first acknowledgment, and 24 of 24 runs of the exact caller wording did too.
2. **The cause is a platform fault, not F-10 and not the model struggling to speak and call tools in one turn.** In that call Vapi never put the assistant's own replies into the message history it sent to OpenAI, and it glued each new caller utterance onto the previous user message. The model saw one growing message ("…Do you treat shoulder pain? OK. Thank you. OK. OK. Thank you.") and no reply of its own, so it answered it identically every time. **Replaying the exact logged request: 20/20 repeat the line.**
3. **Rare, and it coincides with a config setting of ours:** 1 of 17 logged calls. It is also the only call with 21 `Endpointing timeout 700ms (rule: heuristic)` events — that 700 ms is our own `onNoPunctuationSeconds = 0.7` (VP-6 R7); a long unpunctuated English sentence fired it repeatedly. Causation is **unproven**.
4. The tier matters: the caller said "I have an emergency" plus a question, and the model chose the *conditional* line ("If this is an emergency…"), which waits for an answer — so the ending path never ran.

**What I changed (prompt + `client.yaml`, replay- and lossy-history-tested; not yet proven on a real call):**
- A **declared** emergency ("I have an emergency") is the clear-emergency tier even if a question is attached.
- The clear-emergency line **now ends with the hang-up phrase** (`…救急車を呼んでください。失礼いたします。` / "…right away. Goodbye."), so Vapi hangs up as soon as it finishes — no later turn, no history needed. *Behaviour change:* previously the assistant waited for the caller's "understood" before ending.
- The conditional line stays open-ended ("say exactly that line — no goodbye").
- A first **"rule zero"**: if a message contains an acknowledgment together with an emergency description, say only the goodbye and end — never repeat the line.
- New runner mode `LOSSY=1` reproduces the platform fault (drops the assistant's replies, merges the caller's messages).

**Measured:** replay of the three logged production requests — turn 2 loops **4/20** (was **20/20**), turn 3 **1/20**. Simulated lossy history, 9 emergency scenarios × 5 samples: clear emergencies **0/30** loops; English vague **0/10**; Japanese vague repeats **once** then ends (5/5). Normal-history regression (3 samples): 23a and E4 still end, 23b still 3/3 in both languages, back pain 3/3, English ankle unchanged (2/3), no loops anywhere.

**Still open:**
- **Prompt steering is only partly reliable for this** (the residual 4/20) — adding more examples made it *worse* (18/20), so I stopped tuning wording. The real fix is upstream.
- **Endpointing (recommended, not applied):** raise `onNoPunctuationSeconds` (VP-6 R7's original default was 1.5 s). It trades ~0.8 s of answer latency on every turn for not chopping stressed, run-on speech — a product decision, and it needs one real call (a long, hesitant, unpunctuated English sentence) to prove.
- The emergency call is still **not logged** (F-10) — unchanged.
- The mitigation is **not live until `npm run vapi:sync` is run.**
