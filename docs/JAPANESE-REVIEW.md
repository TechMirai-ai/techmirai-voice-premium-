# Japanese wording — flagged for native-speaker review

The project owner cannot read Japanese (see CLAUDE.md's Reporting section). This file collects
every Japanese string a caller can actually hear — the VP-7 prompt rewrite made the Japanese
prompt meaningfully larger and mostly new, so this is a full regeneration, not just the
tone-sensitive items the old version tracked. Every string below is quoted with its English gloss.
Items are grouped to match `promptTemplate.ts`'s own section order, so a reviewer can go through
them in the same order a real call would.

Do not resolve an item here by guessing at a "better" phrasing in code. Resolve it by getting a
native speaker's actual opinion, then update `client.yaml` and check this item off with a note on
what changed and why.

**Status key:** `NEW (VP-7)` — did not exist before this work order. `CHANGED (VP-7)` — existing
line, wording changed. `carried over, not yet reviewed` — unchanged since VP-2/VP-3; nobody has
given it a native-speaker pass yet, it is not "already checked."

---

## Open items

### 1. Greeting and re-entry — `greeting`, `englishGreeting`, `handoffToJapanese` (ja-return's firstMessage)

**`greeting.ja`** (`clients/sakura-seikotsuin/client.yaml`) — CHANGED (content update,
2026-09-29). The project owner dictated this wording directly, reversing the S-2 AI-disclosure
decision recorded in `docs/FUTURE-FEATURES.md` — it no longer says "AI受付" (AI reception):
> お電話ありがとうございます。[[clinicName]]でございます。ご用件をお伺いいたします。英語をご希望の方は「English」とお申し付けください。

Gloss: "Thank you for calling. This is [[clinicName]]. I will ask what you need. If you'd like
English, please say 'English'."

*(Before this change: 「お電話ありがとうございます。[[clinicName]]、AI受付でございます。For English,
please say "English". どのようなご用件でしょうか。」— "Thank you for calling. This is [[clinicName]],
AI reception. For English, please say 'English'. How may I help you?")*

**`greeting.ja` — CHANGED again (content update, 2026-09-29):** the English-option cue is no
longer a Japanese instruction with only the word "English" left untranslated — it is now the full
English sentence, spoken literally as English text in the same ja-JP (Nanami) voice, no voice
switch:
> お電話ありがとうございます。[[clinicName]]でございます。ご用件をお伺いいたします。If you would like assistance in English, please say "English."

Gloss: the Japanese portion is unchanged ("Thank you for calling. This is [[clinicName]]. I will
ask what you need."); the rest is already English, spoken as-is: "If you would like assistance in
English, please say 'English.'"

*(Immediately before this change, same day: 「…英語をご希望の方は「English」とお申し付けください。」—
"…if you'd like English, please say 'English'." — a Japanese sentence with only the single word
"English" left untranslated.)*

**Note — deferred work, not done here:** switching the TTS voice/accent for the English portion of
this line (raised separately as "option 2" — a voice switch or audio splice mid-utterance) is
explicitly deferred. This change only swaps the text; Nanami (ja-JP) still reads the English
sentence in her own accent.

**`englishGreeting.en`** — CHANGED (content update, 2026-09-29). Also dictated directly by the
project owner, also drops the AI-disclosure wording:
> Thank you for calling [[clinicName]]. How may I assist you today?

*(Before this change: "Hello, you've reached [[clinicName]]. This is the clinic's AI
receptionist, speaking in English. How can I help you today?")*

**`handoffToJapanese.ja`** (also `ja-return`'s spoken firstMessage as of VP-7 — see
`docs/VAPI-FACTS.md` VP-7 R1) — CHANGED (content update, 2026-09-29):
> 日本語で承ります。ご用件をお伺いいたします。

Gloss: "I will assist you in Japanese. Please tell me what you need."

*(Before this change: 「日本語の受付にお繋ぎしました。ご用件をお聞かせください。」— "I've connected you
back to Japanese reception. Please tell me what you need.")*

**Note, not a review item:** `englishGreeting.ja` and `greeting.en` both still exist in
`client.yaml` but are never actually spoken to any caller — the English assistant always uses
`englishGreeting.en` for its own firstMessage, and the Japanese call-starting assistant always
uses `greeting.ja` (`render.ts`/`squad.ts`'s `renderArrivalMessage` always picks the *destination*
language's own text). Both unused halves were left as their old text. No review needed.

**Question for a native speaker:** does the greeting sound like a natural, unhurried clinic
receptionist, and does the re-entry line ("日本語で承ります") read naturally as "you're back in
Japanese" rather than sounding like a system message?

**Question for a real-call listen (new, greeting.ja's English cue):** how does the ja-JP (Nanami)
voice actually sound reading a full English sentence mid-utterance, with no voice switch? This is
a text change only — whether the resulting audio is intelligible/acceptable to an English-speaking
caller, or sounds jarring enough to need the deferred "option 2" (voice switch/audio splice), can
only be judged by listening to a real or test call, not by reading the text.

**Status:** open, not yet reviewed (content changed since the last review flag — re-review from
scratch, don't assume the old answer still applies).

---

### 2. Leading the call — `didNotCatch`, `repeatedMisunderstanding`

**`didNotCatch.ja`** — carried over, not yet reviewed:
> 申し訳ございません。うまく聞き取れませんでした。もう一度おっしゃっていただけますか？

Gloss: "I'm sorry, I didn't catch that clearly. Could you say it again?"

**`repeatedMisunderstanding.ja`** (NEW (VP-7) — spoken after three failed attempts in a row to
understand the caller, right before the call ends):
> 申し訳ございません。お電話が遠いようですので、お手数ですが、少し時間をおいておかけ直しいただけますでしょうか。失礼いたします。

Gloss: "I'm sorry, the line seems to be faint. Sorry for the trouble, but could you please wait a
little while and call again? Goodbye."
**CHANGED (2026-09-25):** now ends with 「失礼いたします」 ("Goodbye"), which is also one of the
`endCallPhrases` — so speaking this line hangs the call up on the platform side even when the model
forgets to call `endCall`. The source test suite's version (case 29) ends at 「…いただけますでしょうか。」
without it.

**Question for a native speaker:** is blaming the phone line ("お電話が遠いようです") rather than
the caller the right politeness move here, and does ending the call this way (after three failed
attempts) read as an acceptable way to close rather than abrupt?

**Status:** open, not yet reviewed.

---

### 3. Answering & callback offers — `noMatch`, `staffContactOffer`, `askName`, `confirmName`, `askContactNumber`

**`noMatch.ja`** — carried over, not yet reviewed:
> 申し訳ございません。その件については、ただいまお答えできる情報がございません。スタッフから折り返しご連絡できるよう、お客様の情報をお伝えいたします。お名前を伺ってもよろしいでしょうか？

Gloss: "I'm sorry. I don't currently have information to answer that. So a staff member can call
you back, I'll pass along your information. May I ask your name?"

**`staffContactOffer.ja`** — carried over, not yet reviewed:
> かしこまりました。スタッフから折り返しご連絡できるよう、お客様の情報をお伝えいたします。お名前を伺ってもよろしいでしょうか？

Gloss: "Certainly. So a staff member can call you back, I'll pass along your information. May I
ask your name?"

**`askName.ja`** — NEW (2026-10-11; used by the reservation flow — the callback flow's name request is
the end of `noMatch`/`staffContactOffer` above):
> お名前を伺ってもよろしいでしょうか？

Gloss: "May I ask your name?"

**`confirmName.ja`** — NEW (2026-10-11; replaces `confirmDetails`/`confirmPhone`, which read a phone
number back digit by digit — spoken phone numbers were removed, see below):
> 確認いたします。お名前は[[callerName]]様でよろしいでしょうか？

Gloss: "Let me confirm. Your name is [[callerName]] — is that correct?"

**`askContactNumber.ja`** — NEW (2026-10-11; asked after the name is confirmed, in both the callback and
reservation flows):
> 今お電話いただいているこちらの番号に、ご連絡させていただいてもよろしいでしょうか？

Gloss: "May we contact you at the phone number you are calling from right now?"

**Why no phone number is asked for any more:** there is no real caller number on a browser web call
yet, so the assistants no longer ask for one; a clearly fake placeholder is stored instead
(`src/lib/demoCallerPhone.ts`, TODO SV-5: real caller-ID). `askPhone`, `confirmDetails`,
`confirmPhone`, `phoneRetry`, `reservationReturningAsk` and `phoneReadback` were deleted.

**Question for a native speaker:** do these lines sound like the same receptionist speaking
consistently across a callback flow, and is 「お名前を伺ってもよろしいでしょうか」 the right level
of politeness for asking a caller's name over the phone?

**Status:** open, not yet reviewed.

---

### 4. Callback outcome — `callbackSaved`, `callbackFailed` (warmth/formality check)

Raised during VP-6 while checking whether Vapi's Azure voice integration could make these lines
*sound* warmer via a speaking-style setting (confirmed it can't — see `docs/VAPI-FACTS.md` VP-6
R6, no such setting exists for Azure in Vapi). Since tone can't be adjusted at the voice layer, the
wording itself is the only lever. **Both lines changed content again in the 2026-09-29 content
update** (shorter, project-owner-dictated wording) — the wording below is new, not the VP-7 text
flagged in the previous version of this file.

**`callbackSaved.ja`** (CHANGED (content update, 2026-09-29) — shortened):
> ありがとうございます。スタッフより、翌営業日までにご連絡いたします。

Gloss: "Thank you. Our staff will contact you by the next business day."

*(Before this change: 「ありがとうございます。スタッフにお伝えいたしますので、翌営業日までにご連絡いたします。」
— "Thank you. I'll pass this along to staff, so we will contact you by the next business day.")*

**`callbackFailed.ja`** (CHANGED (content update, 2026-09-29) — shortened, drops
「システムの不具合により」 as its own clause):
> 申し訳ございません。情報を保存できませんでした。恐れ入りますが、時間をおいて、もう一度お電話いただけますでしょうか。

Gloss: "We're sorry. We weren't able to save your information. Sorry for the trouble, but could
you please call again after a little while?"

**Question for a native speaker:** as written, do these read as appropriately warm/apologetic for
a phone receptionist? Also: does 「翌営業日までに」 read as a confident, concrete promise, or too
stiff for a spoken line?

**Status:** open, not yet reviewed (content changed since the last review flag — re-review from
scratch, don't assume the old answer still applies).

---

### 5. Medical questions — `noMedicalAdvice`

**`noMedicalAdvice.ja`** — carried over, not yet reviewed:
> 申し訳ございません。症状についての医学的なアドバイスはいたしかねます。ご来院の際や当院へのお問い合わせの際に、スタッフが詳しくお話を伺います。

Gloss: "I'm sorry, I'm unable to give medical advice about symptoms. When you visit or contact the
clinic, staff will discuss it with you in detail."

**Question for a native speaker:** does 「医学的なアドバイス」 ("medical advice") sound
appropriately clinic-receptionist-level, or too stiff/hospital-like for a 整骨院 (judo-therapy
clinic), per the source documents' own flag on this point (`docs/prompt-v2-source/01-...md`,
item 15)?

**Status:** open, not yet reviewed.

---

### 6. Emergencies — REMOVED (2026-10-11)

The emergency/119 handling was removed entirely: callers in Japan already know to call 119
directly for a real emergency, not a clinic's AI receptionist. The `emergency`,
`emergencyUncertain` and `emergencyGoodbye` scripts, `safety.emergencyNumber` and
`severePainWords` no longer exist, so there is nothing here to review. (Item number kept so the
other items keep their numbers.)

---

### 7. Ending the call — `goodbye`

**`goodbye.ja`** — CHANGED (content update, 2026-09-29). Project-owner-dictated, much shorter, no
longer names the clinic:
> お大事になさってください。

Gloss: "Please take care (of yourself)."

*(Before this change: 「[[clinicName]]にお電話いただき、ありがとうございました。失礼いたします。」—
"Thank you for calling [[clinicName]]. Goodbye.")*

**Note on the hang-up backstop:** `goodbye` is spoken via Vapi's own `endCallMessage` mechanism,
not by the model deciding to say a farewell — it plays automatically right before the platform
ends the call, so it was never one of the `endCallPhrases` the model's own speech is matched
against.

**Question for a native speaker:** is 「お大事になさってください」 a natural, appropriately warm way
for a clinic receptionist to end an ordinary call, or does dropping the clinic name and "thank you
for calling" feel too abrupt?

**Status:** open, not yet reviewed (content changed since the last review flag — re-review from
scratch, don't assume the old answer still applies).

---

### 8. Clinic information (FAQ) — all 10 entries

Four answers changed in VP-7 (decision 1 — never point the caller back at the number they're
already on; softened "contact our staff" phrasing to "staff can explain"); the other six are
unchanged since VP-2/VP-3 and have never had a native-speaker pass either.

1. **hours** — carried over, not yet reviewed.
   Q: 受付時間を教えてください。 ("Please tell me the reception hours.")
   A: 当院の受付時間は、月曜日から土曜日の午前9時から午後7時までです。日曜日と祝日はお休みです。
   ("Our reception hours are Monday to Saturday, 9 a.m. to 7 p.m. We are closed Sundays and
   national holidays.")

2. **appointment-needed** — carried over, not yet reviewed.
   Q: 予約は必要ですか？ ("Is a reservation necessary?")
   A: 初めてご来院の方は、事前のご予約をおすすめしています。ただし、予約状況によっては、予約なしでもご来院いただけます。
   ("For first-time visitors we recommend booking in advance. However, depending on availability,
   you can also visit without an appointment.")

3. **how-to-book** — CHANGED (VP-7): no longer mentions booking by calling the clinic's own
   number; offers a staff callback for phone booking instead.
   Q: 予約はどのようにできますか？ ("How can I make a reservation?")
   A: 当院ホームページのオンライン予約からご予約いただけます。お電話でのご予約をご希望の場合は、担当の者から折り返しご連絡いたします。
   ("You can book through the online reservation on our clinic's website. If you'd like to book by
   phone, the staff member in charge will call you back.")

4. **fees** — CHANGED (VP-7): softened from "please contact our staff" to "staff can explain."
   Q: 施術料金はいくらですか？ ("How much are the treatment fees?")
   A: 施術料金は、施術内容やお身体の状態によって異なります。料金は当院ホームページでご確認いただけるほか、詳しくはスタッフがご説明いたします。
   ("Treatment fees vary with the treatment and your physical condition. You can check pricing on
   our website, and staff can explain further details.")

5. **back-pain** — carried over, not yet reviewed.
   Q: 腰痛の施術はできますか？ ("Can you treat lower back pain?")
   A: はい。腰痛や、首・肩の痛みなど、お身体の痛みや動かしにくさに関するお悩みに対して施術を行っています。
   ("Yes. We treat concerns such as lower back, neck, and shoulder pain, and difficulty moving.")

6. **sports-injuries** — carried over, not yet reviewed.
   Q: スポーツによるケガにも対応していますか？ ("Do you also handle sports injuries?")
   A: はい。スポーツによるケガの施術やリハビリのサポートを行い、安全にスポーツへ復帰できるようお手伝いします。
   ("Yes. We treat sports injuries and support rehabilitation, helping you safely return to
   sport.")

7. **insurance** — CHANGED (VP-7): softened from "please contact our staff" to "staff can
   explain."
   Q: 健康保険は使えますか？ ("Can I use health insurance?")
   A: 健康保険が使えるかどうかは、ケガの種類や状況によって異なります。詳しくはスタッフがご説明いたします。
   ("Whether health insurance can be used depends on the type of injury and the situation. Staff
   can explain further details.")

8. **location** — carried over, not yet reviewed.
   Q: 整骨院はどこにありますか？ ("Where is the clinic located?")
   A: 当院は[[clinicAddress]]にございます。地図やアクセス方法は、当院のホームページをご確認ください。
   ("Our clinic is at [[clinicAddress]]. Please check our website for a map and directions.")

9. **parking** — CHANGED (VP-7): softened from "please contact our staff" to "staff can explain."
   Q: 駐車場はありますか？ ("Is there parking?")
   A: はい、当院の近くに駐車場がございます。詳しい場所はスタッフがご案内いたします。
   ("Yes, there is parking near our clinic. Staff can guide you to the exact location.")

10. **first-visit** — carried over, not yet reviewed.
    Q: 初めて来院するときは、何を持っていけばいいですか？ ("What should I bring for my first
    visit?")
    A: 必要に応じて、マイナ保険証または資格確認書をお持ちください。また、今回のお悩みに関係する過去の治療やケガの情報があれば、あわせてお持ちいただくとスムーズです。
    ("If applicable, please bring your My Number health insurance card or eligibility confirmation
    document. Also, if you have information about past treatment or injuries related to your
    current concern, bringing that too will help things go smoothly.")

**Question for a native speaker:** are all 10 answers natural spoken Japanese for a clinic
receptionist (not written/webpage-style phrasing), and specifically for the four changed answers
(3, 4, 7, 9) — does "スタッフがご説明いたします" / "担当の者から折り返しご連絡いたします" read as
a genuine offer to help rather than a brush-off?

**Status:** open, not yet reviewed.

---

### 9. Call-ending phrases and caller-done examples — NEW (VP-7 follow-up, 2026-09-25)

**`languages.settings.ja.endCallPhrases`** — if the assistant *says* any of these phrases, Vapi
hangs up the call after it finishes speaking (a backstop for when the model speaks a farewell
instead of calling `endCall` — `docs/VAPI-FACTS.md` VP-7 R8). CHANGED (content update,
2026-09-29) — a third phrase was added so the new `goodbye` wording (item 7
above) still triggers this backstop:
> 失礼いたします
> 失礼します
> お大事になさってください

Gloss: "Goodbye" (lit. "I am being rude [by leaving / hanging up]") — the polite and the plainer
form — plus "Please take care (of yourself)", added to match the new goodbye wording.
**Question for a native speaker:** are these the words a Japanese receptionist actually uses to close
a call, and are there other closing phrases the model is likely to say (e.g. 「ありがとうございました」
"thank you" — deliberately NOT included, because it is also said mid-call and would hang up on the
caller)? The list must contain only phrases that mean "the call is over".

**`languages.settings.ja.callerDoneExamples`** — NOT spoken to the caller; shown to the model as
examples of a caller who has finished, so it ends the call silently instead of chatting on:
> ありがとうございました / 以上です / いえ、大丈夫です、ありがとうございます / わかりました、ありがとうございました / はい、結構です

Gloss: "Thank you very much" / "That's all" / "No, I'm fine, thank you" / "Understood, thank you very
much" / "Yes, that's enough". **Question for a native speaker:** are these the things a caller
really says at the end of a clinic call? Missing ones the model should also treat as "finished"?

**Status:** open, not yet reviewed.

---

### 10. Reservation flow outcomes — `reservationSaved`, `reservationFailed` — NEW to this file (content update, 2026-09-29)

These two scripts existed before (VP-8's demo reservation flow) but were never added to this
review file — this is their first entry here, not a re-review.

**`reservationSaved.ja`** — CHANGED AGAIN (content update, 2026-10-15) — no longer speaks the
reservation number. The agent first states the confirmed date and time (generated by the model in
the caller's language, not a fixed script line), then says this line:
> 詳細はこちらのお電話番号にお送りいたします。

Gloss: "We will send the details to this phone number." (English line: "Thank you. We'll send the
details to your number.")

*(Previous wording, 2026-09-29: 「ありがとうございます。ご予約番号は[[reservationNumber]]でございます。」
— "Thank you. Your reservation number is [[reservationNumber]].")*

*(Before this change: 「ありがとうございます。ご予約番号は[[reservationNumber]]でございます。ご来院を
心よりお待ちしております。」— "Thank you. Your reservation number is [[reservationNumber]]. We
look forward to seeing you.")*

**`reservationFailed.ja`** — CHANGED (content update, 2026-09-29) — shortened, drops
「システムの不具合により」 as its own clause:
> 申し訳ございません。ご予約を完了できませんでした。恐れ入りますが、もう一度お試しいただくか、別のお時間をお選びください。

Gloss: "I'm sorry. We weren't able to complete your reservation. Please try again or choose a
different time."

**Question for a native speaker:** does ending `reservationSaved` right after the reservation
number feel abrupt without a closing pleasantry, and does `reservationFailed`'s more direct
phrasing (「お選びください」 instead of the more hedged 「お選びいただけますでしょうか」) still read
as polite enough for a clinic receptionist?

**Status:** open, not yet reviewed.

---

## Also worth a quick glance (not a spoken line)

**`languages.settings.en.switchKeywords`** gained イングリッシュ (VP-7, source docs A7 — how a
Japanese transcriber is likely to actually write the spoken word "English"). This is a
trigger-phrase the model matches against, never spoken by the AI itself, so it doesn't need the
same warmth/formality review as the items above — just a sanity check that イングリッシュ is in
fact how "English" would typically transliterate in this context (it is the standard katakana
rendering), so this is low priority.

---

## VP-15 — returning-caller greeting (`scripts.returningGreeting.ja`)

Spoken instead of the normal greeting when the caller's phone number has called before.

> 再度のお電話ありがとうございます。[[clinicName]]のAI受付、ハルカでございます。この通話は録音されます。本日はどのようなご用件でしょうか？

English meaning: "Thank you for calling again. This is Haruka, the AI receptionist of [clinic name]. This call is recorded. What can I help you with today?"

Notes for the reviewer: "welcome back" has no natural Japanese equivalent for a clinic phone line;
おかえりなさい ("welcome home") would sound like a café, so 再度のお電話ありがとうございます ("thank you
for calling again") is used. The recording notice is kept but shortened (no "to improve our service")
and it deliberately does NOT ask whether they want to book. **Status:** open, not yet reviewed.

---

## VP-16 — graduated caller-silence lines (`scripts.silenceCheck1` / `silenceCheck2` / `silenceEnding`, ja)

Spoken in order when the caller stays silent: a model-written repeat of the last question (no fixed
text), then check 1, check 2, then the ending announcement, then the call is hung up.

1. > もしもし、お聞きになれますでしょうか？

   English meaning: "Hello, can you hear me?"
2. > お電話はつながっておりますでしょうか？

   English meaning: "Is the call still connected?" (the owner's English: "Are you still on the line?")
3. > お返事がないようですので、お電話を終了させていただきます。お電話ありがとうございました。どうぞお大事になさってください。

   English meaning: "As I haven't heard a response, I'll end this call now. Thank you for calling. Please take care."

Notes for the reviewer: wording is the project owner's. Line 3 is spoken by the server together with
the hang-up (VAPI-FACTS.md VP-16 R3 — pending a real-call check), so it should be the only closing line.
**Status:** open, not yet reviewed.

---

## VP-17 — conversational-quality prompt rules (Japanese example wording inside the system prompt)

These are example phrases written into the prompt's rules (the model may say them or similar words),
not scripted lines in `client.yaml`. Same prompt for `ja` and `ja-return`.

1. > 承知いたしました

   English meaning: "Certainly / understood." Offered as a short acknowledgement the model can vary.
2. > さようでございますか

   English meaning: "Is that so? / I see." (very formal). Offered as a second acknowledgement option.
   Please check it is not too stiff for a clinic phone line.
3. > 申し訳ございません → 失礼いたしました

   English meaning: "I am very sorry" → "Please excuse me / my apologies." The prompt tells the model to
   vary the apology wording when it apologises more than once in a call (the scripted lines in
   `client.yaml` that begin 「申し訳ございません」 are unchanged).

Notes for the reviewer: please confirm these read as natural, polite receptionist speech and suggest
better alternatives if not. **Status:** open, not yet reviewed.

---

## Phrase variation — wait lines and the opening question (both clients, `ja` and `ja-return`)

New Japanese wording so the assistant does not say the same sentence every call. Same wording in
`sakura-seikotsuin` and `kanto-city-gas-demo`. **NEW, open, not yet reviewed.**

**A. Wait line spoken by the platform before a tool runs** (`languages.settings.ja.pleaseWaitVariants`;
the existing 「少々お待ちくださいませ。」 stays as the first option and Vapi picks one at random each time)

1. > 少々お待ちいただけますでしょうか。

   English meaning: "Could you please wait a moment?" (a request, slightly softer than the original).
2. > 恐れ入ります、少々お待ちくださいませ。

   English meaning: "Sorry to trouble you — one moment, please."

**B. The opening question** (`languages.settings.ja.openingQuestions`; the first is the existing wording.
On the `/talk` page one is picked at random per call and placed after the recording notice. For Sakura the
booking question 「ご予約をご希望でしょうか？」 still follows it.)

1. > 本日はどのようなご用件でしょうか？ (existing)

   English meaning: "What can I help you with today?"
2. > 本日はどういったご用件でしょうか？

   English meaning: "What kind of matter is it today?" (a little softer).
3. > どのようなご用件でいらっしゃいますか？

   English meaning: "What is your business with us?" (more formal). Please check it does not sound
   stiff when 「ご予約をご希望でしょうか？」 follows it, and that it reads fine without 「本日は」.

**C. Example wording inside the system prompt** (the model may say these or similar; it is told to vary them
and to use the third only when it is really looking something up)

1. > 少々お待ちくださいませ。 / 少々お待ちいただけますでしょうか。

   English meaning: "One moment, please." / "Could you wait a moment?"
2. > ただいま確認いたしますので、少々お待ちくださいませ。

   English meaning: "I will check right now, so please wait a moment." Never a casual 「ちょっと待って」 ("hang on a sec").

Notes for the reviewer: please say whether each is natural, polite receptionist speech and suggest
better alternatives. **Status:** open, not yet reviewed.

---

## VP-19 — Kanto City Gas demo client (`clients/kanto-city-gas-demo/client.yaml`)

Every line a caller can hear from the new gas-utility client, Japanese first and then what it means
in English. The English wording the English assistant speaks is flagged for review in the same
pass (work order decision 8: a second business, same bar — the project owner reading English does
not replace a review). Source: the project owner's demo document (`gas_utility_bpo_demo_profile.md`);
its Japanese was kept where it fit and adapted where it promised something that is not built (see
"Where I changed the source wording" below). All of it is **NEW (VP-19)** and **open, not yet
reviewed**.

**Please look at these first**

1. **The gas-smell script** (below) is the source document's own *placeholder* wording. The document
   itself says the real utility must supply the approved emergency script and phone numbers before
   any live use. As built, the caller hears only this line, then is asked for a name and a callback is
   logged; the assistant gives no safety instructions of its own (deliberately — it does not know the
   correct procedure). Nothing is paged or dispatched.
2. **`失礼いたします` as the closing** (goodbye, silence ending, "line unclear" line). Sakura's
   `お大事になさってください` ("please take care of yourself", a get-well phrase) was dropped as wrong
   for a gas company. Is `失礼いたします` alone a natural, warm enough ending here?
3. **`手配いたします`** ("I will arrange it") is used in many FAQ answers for "I can arrange for staff
   to contact you". Natural for a utility's phone line, or would `お取り次ぎいたします` /
   `ご連絡するよう担当に伝えます` read better?
4. **Terms for the service**: `開栓` / `閉栓` (gas opening / closing) with `使用開始` / `使用停止`
   (start / stop of use) as the plain explanation. Does a caller say `開栓` or `使用開始`?
5. **`当社`** ("our company") and **`担当スタッフ`** ("the staff in charge") — right register for a
   gas company's receptionist?
6. **`ご不便をおかけして申し訳ございません`** ("I apologise for the inconvenience") — used in the
   complaint answer and as the example phrase in this client's prompt for an upset caller.
7. **The recording notice** in the greetings is the same wording Sakura's greeting already uses
   (`サービス向上のため、この通話は録音されます`, "This call is recorded to improve our service").
8. **The assistant's name `サクラ` (Sakura)** comes from the source document. It collides with the
   name of the other demo client, `sakura-seikotsuin` — see the VP-19 report.

**Where I changed the source wording** (so a reviewer can see what is not the document's own text)

- Every FAQ answer that said the assistant could connect the caller to staff (`おつなぎ`) now offers a
  callback instead — transfer is not built and the assistant must not claim it.
- The hours answer no longer says "in the demo settings", and says nothing about emergencies.
- FAQ `attendance` no longer states a rule ("depends on the contract") — it says staff can confirm.
- FAQ `gas-smell` uses the same wording as the gas-smell script below, so there is one emergency
  script, not two slightly different ones (the document has two).
- `reservationSaved` does not say details will be sent to the caller's number (no SMS is built).
- `callbackSaved` promises no time ("by the next business day" was dropped).

The three Sakura-only lines the schema requires but this client never uses (`noMedicalAdvice`,
`reservationAskType`, `reservationPatientNotFound`) are not listed.

### Scripts (spoken lines)

**`scripts.greeting`** — the Japanese assistant's opening line. `[[clinicName]]` is spoken as 関東シティガス.
> お電話ありがとうございます。[[clinicName]]のお問い合わせ窓口でございます。AI受付のサクラがご案内いたします。サービス向上のため、この通話は録音されます。本日はどのようなご用件でしょうか？

English meaning: "Thank you for calling Kanto City Gas's inquiry desk. Sakura, the AI receptionist, will assist you. This call is recorded to improve our service. How may I help you today?"

**`scripts.returningGreeting`** — opening line for a number that has called before.
> 再度のお電話ありがとうございます。[[clinicName]]のお問い合わせ窓口、AI受付のサクラでございます。この通話は録音されます。本日はどのようなご用件でしょうか？

English meaning: "Thank you for calling again. This is Kanto City Gas's inquiry desk, Sakura, the AI receptionist. This call is recorded. How may I help you today?"

**`scripts.handoffToJapanese`** — said when a caller is handed back to Japanese.
> 日本語で承ります。ご用件をお伺いいたします。

English meaning: "I will assist you in Japanese. Please tell me what you need."

**`scripts.englishGreeting`** — the English assistant's opening line. Its Japanese field is never spoken; the **English line is what the caller hears** and is flagged for review:
> "Thank you for calling Kanto City Gas customer support. I'm Sakura, the AI receptionist. This call is recorded to improve our service. How may I help you today?"

**`scripts.anythingElse`**
> ほかに何かお手伝いできることはございますか？

English meaning: "Is there anything else I can help you with?"

**`scripts.noMatch`**
> 申し訳ございません。その件については、ただいまお答えできる情報がございません。スタッフから折り返しご連絡できるよう、お客様の情報をお伝えいたします。お名前を伺ってもよろしいでしょうか？

English meaning: "I'm sorry, I don't have that information right now. I'll pass your details to our staff so they can get back to you. May I have your name, please?"

**`scripts.staffContactOffer`**
> かしこまりました。スタッフから折り返しご連絡できるよう、お客様の情報をお伝えいたします。お名前を伺ってもよろしいでしょうか？

English meaning: "Of course. I'll pass your details to our staff so they can call you back. May I have your name, please?"

**`scripts.askName`** / **`scripts.confirmName`** / **`scripts.askContactNumber`**
> お名前を伺ってもよろしいでしょうか？
>
> 確認いたします。お名前は[[callerName]]様でよろしいでしょうか？
>
> 今お電話いただいているこちらの番号に、ご連絡させていただいてもよろしいでしょうか？

English meaning: "May I have your name, please?" / "Just to confirm, your name is [[callerName]] — is that right?" / "May we contact you at the number you are calling from now?"

**`scripts.callbackSaved`** — NEW wording, no promised time.
> ありがとうございます。担当スタッフよりご連絡いたします。

English meaning: "Thank you. Our staff will be in touch."

**`scripts.callbackFailed`**
> 申し訳ございません。情報を保存できませんでした。恐れ入りますが、時間をおいて、もう一度お電話いただけますでしょうか。

English meaning: "I'm sorry. We weren't able to save your information. Could you please call us again a little later?"

**`scripts.pleaseWait`**
> 少々お待ちくださいませ。

English meaning: "One moment, please."

**`scripts.didNotCatch`** / **`scripts.repeatedMisunderstanding`**
> 申し訳ございません。うまく聞き取れませんでした。もう一度おっしゃっていただけますか？
>
> 申し訳ございません。お電話が遠いようですので、お手数ですが、少し時間をおいておかけ直しいただけますでしょうか。失礼いたします。

English meaning: "I'm sorry, I didn't quite catch that. Could you say it again, please?" / "I'm sorry, the line seems far away. Could you please call again a little later? Goodbye."

**`scripts.goodbye`** — spoken when the call ends.
> お電話いただき、誠にありがとうございました。失礼いたします。

English meaning: "Thank you very much for your call. Goodbye."

**`scripts.silenceCheck1`**, **`silenceCheck2`**, **`silenceEnding`** — the existing VP-16 silence mechanism; the first two are identical to Sakura's, only the ending drops `どうぞお大事になさってください`.
> もしもし、お聞きになれますでしょうか？
>
> お電話はつながっておりますでしょうか？
>
> お返事がないようですので、お電話を終了させていただきます。お電話ありがとうございました。失礼いたします。

English meaning: "Hello, can you hear me?" / "Is the call still connected?" / "As I haven't heard a response, I will end this call now. Thank you for calling. Goodbye."

**Booking lines**
> ガスの使用開始（開栓）と使用停止（閉栓）の、どちらのご希望でしょうか？
>
> ご希望の日時はございますか？
>
> 対象のご住所を、建物名とお部屋番号も含めてお願いいたします。
>
> ご予約を承りました。
>
> 申し訳ございません。ご予約を完了できませんでした。別のお時間をお調べするか、担当スタッフからご連絡できるよう手配いたしますが、いかがでしょうか。

English meaning, in order: "Would you like to start gas service (開栓) or stop it (閉栓)?" / "What date and time would you prefer?" / "What is the address for the service, including the building name and room number?" / "Your appointment is booked." / "I'm sorry. We weren't able to complete your booking. I can look for another time, or arrange for our staff to contact you — would that be all right?"

**Postal-code address lines (VP-20, `reservationFlow.postalCodeLookup`)** — new, not yet reviewed by a native speaker. The assistant now asks for the postal code, looks up the area, and only asks for the building and room. The older address question above is kept as the fallback.
> 対象のご住所の郵便番号を、7桁の数字でお願いいたします。
>
> 郵便番号[[postalCode]]は、[[area]]でよろしいでしょうか。
>
> 建物名とお部屋番号をお願いいたします。ない場合は、その旨をお伝えください。
>
> 申し訳ございません、郵便番号から自動で確認することができませんでした。

English meaning, in order: "What is the 7-digit postal code of the address for the service?" / "Postal code [[postalCode]] is [[area]] — is that right?" (the assistant fills in the code, e.g. 150-0002, and the area, e.g. 東京都渋谷区渋谷 = "Shibuya, Shibuya Ward, Tokyo") / "What are the building name and the room number? If there isn't one, just let me know." / "I'm sorry, I couldn't look that up automatically." (said right before the older address question is asked instead).

Points for the reviewer: (1) is `郵便番号…は、…でよろしいでしょうか` natural when the area is a long name like 京都府京都市中京区上大阪町 ("Kamiōsakachō, Nakagyō Ward, Kyoto City, Kyoto Prefecture")? (2) is `ない場合は、その旨をお伝えください` ("if there is none, please let us know") the right register for a caller living in a house with no building name?

### The gas-smell script (`emergency.script`) — source document's placeholder wording

> ガスのにおいがするとのことですね。安全に関わる可能性があるため、ガス会社が定めた緊急時のご案内に切り替えます。

English meaning: "I understand you smell gas. This may be a safety issue, so I will switch to the gas company's approved emergency instructions."

The callback it records carries the reason `SAFETY: caller reported possible gas smell/leak` (English).

### FAQ answers (18, condensed from the document's 26)

Each answer is grounding text the assistant paraphrases, not read verbatim, except `gas-smell`.

**`start-service`** — ガスの使用開始（開栓）を申し込みたいのですが、どうすればいいですか？ ("How do I start gas service?")
> ガスの使用開始をご希望ですね。このお電話でそのままご予約を承ります。ご希望の日時とご住所をお伺いします。本日中をご希望の場合も、まず空き状況を確認いたしますので、確認が取れるまではお約束できません。

English meaning: "You'd like to start gas service. I can book the appointment right now on this call. I'll ask for your preferred date and time and the address. If you need it today, I'll check what is open first, and I can't promise it until I have."

**`stop-service`** — 引っ越すので、ガスを止めたい（閉栓したい）のですが。 ("I'm moving out; I want to stop my gas.")
> ガスの使用停止をご希望ですね。こちらもこのお電話でご予約を承ります。ご希望の日時とご住所をお伺いします。最後のご請求の時期や費用については、こちらではご案内できませんが、ご希望でしたら担当スタッフからご連絡できるよう手配いたします。

English meaning: "You'd like to stop gas service. I can book that on this call too. I'll ask for your preferred date and time and the address. I can't tell you the timing or cost of the final bill here, but if you'd like I can arrange for staff to contact you."

**`attendance`** — 開栓のときは立ち会いが必要ですか？ ("Do I need to be there when the gas is opened?")
> 立ち会いが必要かどうかは状況によって異なる場合があり、こちらでは確認できません。担当スタッフが確認いたしますので、ご希望でしたら担当スタッフからご連絡できるよう手配いたします。

English meaning: "Whether someone needs to be present can depend on the situation, and I can't confirm it here. Our staff will confirm it; if you'd like, I can arrange for them to contact you."

**`availability`** — 開栓や閉栓の予約はいつ空いていますか？ ("When are appointments available?")
> 空き状況を確認いたします。ご希望の日にちや時間帯はございますか？

English meaning: "I'll check what is open. Do you have a day or a time of day in mind?"

**`change-cancel`** — 開栓・閉栓の予約日時を変更、またはキャンセルしたいのですが。 ("I want to change or cancel my appointment.")
> 申し訳ございません。こちらでは、すでにあるご予約の変更やキャンセルのお手続き、ご予約内容の確認はできません。担当スタッフからご連絡できるよう手配いたします。現時点では、ご予約の変更やキャンセルは行われておりません。

English meaning: "I'm sorry, on this line I can't change or cancel an existing appointment or look up its details. I'll arrange for staff to contact you. At this point your appointment has not been changed or cancelled."

**`no-gas`** — ガスが出ないのですが、どうしたらいいですか？ ("My gas isn't coming out.")
> ガスが出ないのですね。まず安全確認のため、ガスのにおいがする、またはガス漏れの可能性がある状況でしょうか？「はい」または「わからない」の場合は、安全に関わる報告として扱います。においなどがない場合は、こちらでは対処方法をご案内できませんが、担当スタッフからご連絡できるよう手配いたします。訪問のお約束もできません。

English meaning: "Your gas isn't coming out. First, for safety: do you smell gas, or could there be a leak? If yes or you're not sure, I'll treat it as a safety report. If there's no smell, I can't walk you through troubleshooting here, but I'll arrange for staff to contact you. I also can't promise a visit."

**`gas-smell`** — ガスのにおいがするのですが。 ("I smell gas.") — answer is the gas-smell script above, word for word.

**`hours`** — 受付時間を教えてください。 ("What are your opening hours?")
> お問い合わせ窓口の受付時間は、月曜日から金曜日が午前9時から午後6時まで、土曜日が午前9時から午後5時までです。日曜日と祝日はお休みです。

English meaning: "The inquiry desk is open Monday to Friday 9:00 AM to 6:00 PM and Saturday 9:00 AM to 5:00 PM. We are closed on Sundays and national holidays."

**`billing-inquiry`** — ガス料金や料金単価、お客様番号について確認したいです。 ("I want to ask about my bill, the rates or my customer number.")
> お客様個別のご請求内容や料金単価、お客様番号については、こちらでは確認できません。料金単価はご契約内容や料金プランによって異なります。担当スタッフからご連絡できるよう手配いたします。

English meaning: "I can't check individual bills, rates or customer numbers here. Rates depend on the contract and plan. I'll arrange for staff to contact you."

**`payment-slip`** — 払込票をなくしてしまいました。 ("I lost my payment slip.")
> 申し訳ございません。払込票の再発行は、こちらではお手続きできません。担当スタッフからご連絡できるよう手配いたします。

English meaning: "I'm sorry, I can't reissue a payment slip on this line. I'll arrange for staff to contact you."

**`payment-extension`** — 支払い期限を延長できますか？ ("Can I extend my payment deadline?")
> お支払い期限の延長や料金の変更は、ご契約内容によって異なり、こちらではお約束できません。担当スタッフからご連絡できるよう手配いたします。

English meaning: "Extending a deadline or changing fees depends on your contract, and I can't promise it here. I'll arrange for staff to contact you."

**`payment-status`** — 支払いが確認できているか知りたいです。支払い用のリンクを送ってもらえますか？ ("Has my payment been received? Can you send a payment link?")
> 申し訳ございません。お支払い状況の確認や、リンクやSMSのお送りは、こちらではできません。個別のお支払い情報は、担当スタッフによる本人確認が必要です。担当スタッフからご連絡できるよう手配いたします。

English meaning: "I'm sorry, I can't check payment status or send links or text messages here. Individual payment details need identity verification by our staff. I'll arrange for staff to contact you."

**`suspicious-sms`** — ガス料金の支払いを求める不審なSMSが届きました。 ("I received a suspicious text asking me to pay my gas bill.")
> ご心配をおかけしております。メッセージ内のリンクは、正式なものと確認できるまで開かないでください。担当スタッフからご連絡できるよう手配いたしますので、そちらでご確認いただけます。

English meaning: "I'm sorry for the worry. Please don't open the link in that message until you can confirm it is genuine. I'll arrange for staff to contact you so you can check."

**`human-operator`** — オペレーターと話したいです。あとで折り返してもらえますか？ ("I want to talk to an operator / can you call me back later?")
> かしこまりました。お電話をおつなぎすることはできませんが、担当スタッフへの折り返しのご依頼を承ります。折り返しのお時間は、こちらではお約束できません。

English meaning: "Of course. I can't transfer your call, but I can take a callback request for our staff. I can't promise a time for the call."

**`other-services`** — 電気や水道の手続き、または別のガス会社の契約について問い合わせたいです。 ("Can you help with electricity, water or another gas company?")
> この窓口でご案内できるのは、当社のガスに関するお手続きです。電気や水道、他社のご契約については、こちらでは承っておりません。

English meaning: "This line handles our company's gas service. We don't handle electricity, water or another company's contracts here."

**`complaint`** — 苦情を伝えたいです。 ("I want to make a complaint.")
> ご不便をおかけして申し訳ございません。担当スタッフへお伝えできるよう、ご用件を簡潔にお伺いしてもよろしいでしょうか？

English meaning: "I apologise for the inconvenience. So I can pass it to our staff, may I ask briefly what it is about?"

**`change-details`** — 登録している名前や電話番号を変更したいです。 ("I want to change my registered name or phone number.")
> 申し訳ございません。登録情報の変更には本人確認が必要なため、こちらではお手続きできません。担当スタッフからご連絡できるよう手配いたします。

English meaning: "I'm sorry, changing registered details needs identity verification, so I can't do it here. I'll arrange for staff to contact you."

**`unknown-question`** — ここに載っていない質問があります。 ("I have a question that isn't listed.")
> 確認いたします。正確なご案内が難しい場合は、推測でお答えせず、担当スタッフへの折り返しのご依頼を承ります。

English meaning: "I'll look into it. If I can't give an accurate answer, I won't guess; I can take a callback request for our staff."

### English wording to review (spoken by the English assistant)

Same status. The English lines are in `client.yaml` under each script's and FAQ entry's `en` field; the ones callers hear most, and where the wording is a judgement call, are: the greeting (above), `Thank you. Our staff will be in touch.` (no promised time), `Your appointment is booked.` (no "details will be sent" claim), the gas-smell script (above) and the `change-cancel`, `payment-status` and `human-operator` FAQ answers, which tell the caller plainly what the assistant cannot do.
