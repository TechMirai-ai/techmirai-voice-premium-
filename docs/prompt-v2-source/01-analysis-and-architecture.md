# Sakura Seikotsuin voice receptionist — analysis, architecture, voice rules

Sections A, B and E of your brief. The prompts (C, D) are in 02 and 03; the test suite (F) is in 04.

Confidence labels used below:
- **[Verified]** — I checked this in Vapi's documentation or API schema while writing this (24 Sep 2026). Vapi changes quickly, so re-check before relying on it.
- **[Not verified]** — I believe it, but have not confirmed it. Check the current docs or test it.
- **[Judgment]** — a design opinion, not a fact.

---

## A. Problems in the current prompt (most serious first)

### Will cause wrong or broken calls

1. **No date or time.** The model cannot answer "Are you open today?" or 「明日行きたいんですけど」 (I'd like to come in tomorrow), and the "closed on national holidays" rule is unusable because it doesn't know what day it is. Fix: a Today section (02/03).

2. **It tells callers to call the number they are already on.** The how-to-book answer says "or by calling us at 048-000-0000", the tool-failure line says "call the clinic directly at 048-000-0000", and three answers say "contact our staff". If the AI answers the clinic's line, all of these loop the caller back to the AI. Fix: offer a staff callback instead. (Open decision 1 below.)

3. **Phone numbers can be misread aloud.** The read-back writes the number in numerals. A TTS engine may read "7708" as a quantity — "seven thousand seven hundred eight", or 「ななせんななひゃくはち」 (seven thousand seven hundred eight) in Japanese. **[Not verified]** — I haven't tested how Vapi's Azure voices normalize numbers, but the prompt shouldn't depend on it. There is also no grouping rule and no digit-count check. Fix: digits written as words (EN) or katakana (JA), grouped, with a count check.

4. **The Japanese confirmation gate doesn't know Japanese confirmation is ambiguous.** 「はい」 (yes) is also 相づち (aizuchi — "uh-huh" listening noises), so a caller murmuring はい during the read-back can look like a confirmation. 「大丈夫です」 (it's fine) often means "no thank you" when replying to an offer. Fix: explicit rules for both (03, Callback requests).

5. **Names.** The transcriber turns a spoken name into a kanji guess; the voice reading kanji back may mispronounce it; and asking a caller to describe kanji by voice is slow and error-prone. There is no rule for any of this. Fix: echo the name in katakana (phonetic script, pronounced exactly as written), pass it to the tool in katakana, and never ask for kanji — staff only need the reading to call back.

6. **The two languages behave differently.** The strict confirmation rule added in VP-6 exists only in the Japanese prompt. Both prompts confirm name and number in one question, so a "no" doesn't say which part is wrong.

7. **Language triggers miss what the transcriber actually writes.** A Japanese transcriber will probably write the spoken word "English" as 「イングリッシュ」 (English, in katakana), which isn't in the trigger list. An English transcriber cannot write 「日本語」 (Japanese) at all. Also, after English→Japanese, the Japanese firstMessage — including "For English, please say English" — may replay mid-call. **[Not verified]**; listen for it on your next two-way test call.

8. **The emergency trigger is too broad for a 整骨院 (bone-setting clinic).** "Severe pain" is this clinic's everyday caller — for example ぎっくり腰 (acute lower-back strain). Every such caller is told to call 119, and there is no path back to the normal call if they say it isn't that serious. Unnecessary ambulance calls are a recognized public concern in Japan **[Not verified in detail]**. Fix: two tiers — clear red flags get an immediate 119 instruction; uncertain severe pain gets the conditional line, and the call continues if the caller says it's not an emergency.

9. **English "please wait" line in the Japanese assistant.** Vapi's default `request-response-delayed` tool message is English ("Sorry, a few more seconds."), and it also fires when the caller speaks while a tool is running **[Verified — Vapi API schema]**. Unless you override it on each tool, the Japanese voice can say that English sentence.

10. **"Can I talk to someone?" has no honest answer.** There is no transfer tool, yet the prompt jumps straight to "May I have your name?" without saying it can't transfer or asking whether the caller wants a callback.

11. **Staff get no reason with a callback.** `request_callback` carries only name and number, so staff call back not knowing what it's about.

12. **No rule for "Are you a real person?"** Nothing stops the model from claiming to be human. The greeting also doesn't say it's an AI (Open decision 3).

### Makes it sound robotic

13. **Scripted strings everywhere.** Almost every step is "say: …" with an exact sentence, repeated identically — the same "anything else?" after every answer, the same clarification sentence every time. That is what makes a voice agent sound like an IVR.

14. **Greetings.** The Japanese greeting's capability sentence, 「当院に関するご案内や、スタッフへのお取り次ぎを承ります」 (I can give information about the clinic or pass messages to staff), sounds like an IVR menu. The English greeting says "this is the English receptionist", which exposes the handoff machinery.

15. **Japanese wording [Judgment — needs native review].** 「当院へのお問い合わせの際に」 (when you contact the clinic) is said to someone who is already contacting the clinic. 「医学的なアドバイス」 (medical advice) sounds like a hospital rather than a 整骨院. 「この通話を終了して」 (terminate this call) is mechanical in an emergency. 「お客様の情報をお伝えいたします」 (I will pass on the customer's information) is stiff. 「ほかに何かお手伝いできることはございますか」 (Is there anything else I can help you with?) reads like a translation of the English line; 「ほかにご不明な点はございますか」 (Is there anything else you'd like to know?) is more typical at a clinic desk.

### Wastes tokens or hurts maintenance

16. **Duplication.** Hours appear twice (once as a day-by-day list), the address twice, each FAQ's question text duplicates its tags, and the placeholder rule appears three times — once attached to messages that contain no placeholders.

17. **Analytics lose information.** Topic "unresolved" duplicates outcome "unresolved", so a phone-booking callback is indistinguishable from an unanswerable question. And if the caller hangs up first, `log_call_topic` never fires, so those calls vanish from your stats.

18. **"Wait" phrases — checked, none found.** Neither prompt contains 「ちょっと待って」 (wait a sec) or similar. The only real waiting risk is tool latency, now handled by the tool messages in 02/03 rather than by the prompt.

---

## B. Recommended architecture

**Decision: keep one system prompt per language. Don't add conditional prompt layers or per-state assistants.** Your Squad already makes the one split that clearly pays off (language). Instead:
1. Build each prompt from one template, in a fixed section order.
2. Move deterministic behavior out of the prompt into Vapi configuration and your server (table below). This is the layering that actually improves reliability.

### Why not more layers

- **Tokens.** Each turn sends only the active member's prompt plus the conversation so far. The callback and emergency sections are roughly a quarter of each prompt. Loading them conditionally would need extra Squad members and handoffs.
- **Latency.** Each handoff adds a transfer step. Saving a few hundred prompt tokens per turn isn't worth that. At this prompt size I expect prompt length to matter much less than the endpointing wait (your 0.7 s), the LLM's time to first token, and TTS time to first audio **[Judgment — not measured on your setup]**. Compare Vapi call logs before and after deploying.
- **Reliability.** Callback, emergency and language rules can trigger on any turn, so they need to be present on every turn. Conditional loading risks the rule being absent exactly when it's needed.
- **Maintainability.** One template generator, per-client data. Rules are in English in both prompts, so you can maintain the logic without reading Japanese.
- **FAQ retrieval tool (knowledge base).** Not worth it at 10 entries: it adds a retrieval step and a chance of retrieving the wrong entry. Reconsider when a client's answer book reaches dozens of long entries — a rough threshold, not a measured one.

### Section order

identity → style → leading → answering → callback → medical → emergency → language → ending → clinic information → today

Static text first, per-client data next, per-call data last. If your LLM provider caches repeated prompt prefixes, keeping the per-call date at the very end leaves everything above it cacheable. OpenAI applies prefix caching automatically to longer prompts, as far as I know **[Not verified for your model — I don't know which LLM your assistants use]**.

### Measured size (characters)

I couldn't run a tokenizer in this environment, so these are character counts of the system prompts only (greeting excluded), measured with a script.

| | Old | New | Change |
|---|---|---|---|
| English — whole prompt | 7,408 | 8,432 | +14% |
| Japanese — whole prompt | 6,638 | 9,026 | +36% |
| English — clinic knowledge block | 2,675 | 1,691 | −37% |
| Japanese — clinic knowledge block | 1,824 | 1,055 | −42% |
| English — behavior rules | 4,733 | 6,741 | +42% |
| Japanese — behavior rules | 4,814 | 7,971 | +66% |

**I did not meet your token-reduction goal overall.** The knowledge block is about 40% smaller, and that is the part that grows with each client's FAQ list. The rules grew because the old prompt was missing behavior that real calls need: today's date, digit reading, name reading, the はい (yes / uh-huh) and 大丈夫です (it's fine / no thanks) ambiguity, two-tier emergencies, the no-transfer answer, honest AI disclosure, and transcriber-realistic language triggers. The Japanese prompt grew most because it now carries native example lines, which is the main lever for natural Japanese.

If you need it smaller, cut in this order (least risk first):
1. The example words inside the Japanese "Avoid" line — keep the category names (二重敬語 double honorifics, バイト敬語 incorrect service-industry honorifics), drop the examples.
2. The second general clarification line in each prompt.
3. The surname-only rule.
4. The time and date format lines.
5. The three-failed-attempts rule.

Don't cut: the confirmation gate, digit rules, emergency tiers, the Today section, or the language triggers.

### Move out of the prompt

| What | Where | Status |
|---|---|---|
| Goodbye line | `endCallMessage` — texts in 02/03 | Already done in VP-6 |
| "One moment" during slow tools | `request-response-delayed` message on each tool, in each language; ~2000 ms suggested | Field **[Verified]**; timing is **[Judgment]** |
| Today's date | Vapi default variable with LiquidJS date filter and timezone — already in 02/03 | Syntax **[Verified — documented]**; output format **[Not verified]**, test with one call |
| National holidays | Server builds a short calendar string (today + next 7 days, open/closed) and passes it as a variable, replacing the Today line | Variables via `assistantOverrides.variableValues` **[Verified]** for API-started calls. For inbound phone calls you need your server to supply overrides at call start — mechanism for inbound Squads **[Not verified]**. Holiday source: Japan's Cabinet Office publishes the national holiday list, I believe as a CSV **[Not verified]** |
| Phone-number validation | `request_callback` endpoint rejects Japanese numbers with the wrong digit count and returns an error message the model can act on | Defense in depth; your code |
| Abandoned calls | On the end-of-call report, if no `log_call_topic` arrived, store topic "abandoned" | Your code |
| Aizuchi vs. interruption | `stopSpeakingPlan.acknowledgementPhrases`: はい (yes), ええ (yeah), うん (mm), なるほど (I see), そうですね (right) | Field **[Verified]**. Whether `numWords` counts Japanese words sensibly (Japanese has no spaces) **[Not verified]** — test |
| Name turn wait | Consider a longer endpointing wait on the name turn, like your 2.5 s phone-number exception; Japanese callers often pause between surname and given name | **[Judgment]** — test |
| Re-entry greeting | Second Japanese member `ja-return` with the short firstMessage in 03; English hands off to it; only `ja` starts calls | Works with plain Squads; no new feature needed |
| Silence | Japanese idle message text in 03 | Config field name **[Not verified]** — check Vapi's message-plan docs |
| Speaking rate | Slightly slower voice may help older patients | Whether Vapi exposes a speed setting for Azure voices **[Not verified]** |

---

## E. Voice behavior rules

**Pacing.** The prompt cannot slow down individual sentences: you found no clean phoneme mechanism in Vapi's Azure integration, and I haven't confirmed that SSML rate tags pass through either **[Not verified]**. Clear, unhurried speech comes from short sentences, one item per turn, punctuation (、 and 。 in Japanese, commas in English), and grouping numbers.

**Pauses.** Japanese: 、 (comma) for a short pause, 。 (full stop) for a longer one, and 「の、」 (the particle "no" plus a comma) between number groups, which is how Japanese speakers naturally read phone numbers. English: commas between groups.

**Numbers.**
- Speak digits one by one: English "zero nine zero", never "oh"; Japanese in katakana, e.g. ゼロキュウゼロ (zero-nine-zero).
- Group as the caller did. Japanese mobiles and 050 numbers are 3-4-4; 03 and 06 landlines are 2-4-4; other landlines follow the caller's grouping.
- Check the count before reading back: 11 digits for 070/080/090/050, 10 for other Japanese numbers. If the Ministry starts issuing 060 mobile numbers, add them **[Not verified — I'm unsure of the current status]**.
- Tool arguments always use plain digits (09012345678), never katakana.

**Dates and times.** Japanese 「9月25日、金曜日」 (September 25th, Friday) and 「午後3時」 (3 p.m.); English "Friday, September 25th" and "3 p.m.". Don't read addresses back; nothing is stored.

**Names.** Echo the name once, naturally, which lets the caller correct it. Ask a separate yes/no question only when unsure. Japanese: katakana, with 様 (sama, polite "Mr./Ms."), never ask for kanji. English: ask for spelling only when the name is unusual or unclear, and read the spelling back.

**Confirmation.** Confirm only what gets stored or is easily misheard: the phone number always; the name only when unsure. Never confirm FAQ answers. The phone read-back is its own turn, ends with the question, and waits. Only a clear yes after the question counts.

**Interruptions.** Stop, respond to the newest utterance, don't restart the old explanation. Configure acknowledgement phrases so Japanese aizuchi don't cut the agent off.

**Turn-taking.** End each turn with at most one question and then stop. Ask "anything else?" once, after a question is fully dealt with — not after every sentence and not right after another question. Don't fill silence; let the idle message handle long pauses.

**Japanese-specific.** Callers often pause between number groups expecting a 相づち (aizuchi) like 「はい」 (yes). Your 2.5 s wait on the phone-number turn is correct for this; the agent must not jump in mid-number.

---

## Content changes that need the clinic's approval

The FAQ answers are client content. I changed:
- **how-to-book** — removed "or by calling us at 048-000-0000" (see A2).
- **fees, insurance, parking** — "please contact our staff" became "staff can explain", and the prompt now offers a callback when the caller wants more.
- **Japanese polish**, for example 「行っています」 → 「行っております」 (more humble "we do"), 「お手伝いします」 → 「お手伝いしております」 (more humble "we help"), 「予約なしでも」 → 「ご予約なしでも」 (adds the polite prefix to "without an appointment"), and 「ホームページをご確認ください」 (please check our website) → 「ホームページでご確認いただけます」 (you can check on our website). Compare the old and new answer lists line by line before showing the clinic.

## Open decisions for you

1. **Does the AI answer the clinic's main number (048-000-0000)?** I assumed yes, which is why the failure line now says "please call again later" instead of giving the number. If there is a staffed number that doesn't route to the AI, put it in the failure line.
2. **Which LLM do the assistants use?** It decides whether prompt caching applies.
3. **AI disclosure in the greeting.** I recommend it: callers speak more clearly to a known AI, and discovering it later damages trust. I don't know whether any Japanese regulation requires it — that is not something I can advise on. The honesty rule for "Are you a person?" is in both prompts regardless.
4. **Callback timing.** The old prompt promised staff would call "soon". The new one makes no timing promise, because "soon" is false on a Sunday evening. If the clinic has a real window (for example "within the next business day"), add it to the success line.
5. **Analytics schema.** Consider splitting topic (what the call was about) from outcome (resolved / callback / emergency / abandoned). I kept your current enum so the prompts work with today's endpoint.
6. **Full name or surname.** The prompt asks once for the given name and accepts a surname if the caller declines. Change it if the clinic always needs full names to find patient records.
7. **Emergency goodbye.** After the 119 instruction, the fixed endCallMessage 「お電話ありがとうございました。失礼いたします。」 (Thank you for calling. Goodbye.) still plays. It's acceptable, but slightly off in tone; a shorter 「失礼いたします。」 (Goodbye) works for every call type if you prefer.
8. **Hanging up first.** Japanese phone etiquette has the caller hang up first; endCall hangs up right after the goodbye. Minor, and fixing it would weaken your reliable call-ending, so I'd leave it.
