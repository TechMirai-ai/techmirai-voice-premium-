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

### 3. Answering & callback offers — `noMatch`, `staffContactOffer`, `askPhone`, `confirmDetails`

**`noMatch.ja`** — carried over, not yet reviewed:
> 申し訳ございません。その件については、ただいまお答えできる情報がございません。スタッフから折り返しご連絡できるよう、お客様の情報をお伝えいたします。お名前を伺ってもよろしいでしょうか？

Gloss: "I'm sorry. I don't currently have information to answer that. So a staff member can call
you back, I'll pass along your information. May I ask your name?"

**`staffContactOffer.ja`** — carried over, not yet reviewed:
> かしこまりました。スタッフから折り返しご連絡できるよう、お客様の情報をお伝えいたします。お名前を伺ってもよろしいでしょうか？

Gloss: "Certainly. So a staff member can call you back, I'll pass along your information. May I
ask your name?"

**`askPhone.ja`** — carried over, not yet reviewed:
> ありがとうございます。スタッフからご連絡できるお電話番号を教えていただけますか？

Gloss: "Thank you. Could you tell me a phone number where staff can reach you?"

**`confirmDetails.ja`** — carried over, not yet reviewed:
> 確認いたします。お名前は[[callerName]]様、お電話番号は[[callerPhone]]でよろしいでしょうか？

Gloss: "Let me confirm. Your name is [[callerName]], and your phone number is [[callerPhone]] — is
that correct?"

**Question for a native speaker:** do these four lines sound like the same receptionist speaking
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

### 6. Emergencies — `emergency`, `emergencyUncertain`, `emergencyGoodbye` (two-tier, all changed)

VP-7 replaced the old single-tier emergency line with a two-tier design (source docs A8): a clear
red-flag line said immediately, and a separate conditional line for uncertain/possibly-serious
cases. Both are new wording, and `emergencyGoodbye` is an entirely new line (see
`docs/VAPI-FACTS.md` VP-7 R3 — the model speaks this itself right before `endCall`, so the normal
`goodbye` line also plays immediately after; two goodbye-shaped lines back to back is an accepted
tradeoff, not a bug).

**`emergency.ja`** (CHANGED (VP-7) — clear red flag, said immediately, no conditional wording):
> すぐにお電話を切って、119番に連絡し、救急車を呼んでください。

Gloss: "Please hang up right away, call 119, and call for an ambulance."

**`emergency.ja` — CHANGED again (2026-09-25, emergency-loop fix):** now ends with 「失礼いたします」 ("Goodbye") so the call hangs up as soon as the line finishes, without waiting for the caller to reply:
> すぐにお電話を切って、[[emergencyNumber]]番に連絡し、救急車を呼んでください。失礼いたします。

Gloss: "Please hang up right away, call 119 and ask for an ambulance. Goodbye." **Question for a native speaker:** is ending the call immediately after this instruction acceptable and natural for an emergency caller? (The conditional line `emergencyUncertain` deliberately does NOT end the call.)

**`emergencyUncertain.ja`** (NEW (VP-7) — uncertain/possibly-serious pain):
> 緊急の場合は、このお電話を切って、すぐに119番で救急車を呼んでください。

Gloss: "If this is an emergency, please hang up this call and immediately call 119 for an
ambulance."

**`emergencyGoodbye.ja`** — CHANGED (content update, 2026-09-29). Now shares its exact wording
with `goodbye` below (project-owner-dictated), but stays a separate script key because the
mechanism differs: this one is spoken by the model itself right before it calls `endCall` (the
normal `goodbye` line, via `endCallMessage`, still plays immediately after):
> お大事になさってください。

Gloss: "Please take care (of yourself)."

*(Before this change: 「失礼いたします。」 — "Goodbye" (literally closer to "please excuse me" /
"I'll take my leave").)*

**Note on the hang-up backstop:** the new text no longer contains 「失礼いたします」, so
`languages.settings.ja.endCallPhrases` gained a matching entry
(「お大事になさってください」) so the emergency path still hangs up on the platform side even if
the model doesn't reliably call `endCall` (see `tests/vapi/callEnding.test.ts`).

**Question for a native speaker:** do the two emergency lines read as urgent without sounding
panicked, and is the distinction between them (immediate red flag vs. "if this is an emergency...")
clear enough in Japanese that a caller wouldn't confuse the two? Also: is 「お大事になさってください」
an appropriate short goodbye specifically right after telling someone to call an ambulance, or does
it read as jarringly casual/formal for that moment (this is source doc Open Decision 7's own
concern — see `docs/prompt-v2-source/01-...md`)?

**Status:** open, not yet reviewed. This item is also flagged for a real-call judgment listen
(work order §9), not just a text read — how it actually *sounds* right after the red-flag line
matters as much as the wording.

---

### 7. Ending the call — `goodbye`

**`goodbye.ja`** — CHANGED (content update, 2026-09-29). Project-owner-dictated, much shorter, no
longer names the clinic:
> お大事になさってください。

Gloss: "Please take care (of yourself)."

*(Before this change: 「[[clinicName]]にお電話いただき、ありがとうございました。失礼いたします。」—
"Thank you for calling [[clinicName]]. Goodbye.")*

**Note on the hang-up backstop:** unlike `emergencyGoodbye` (item 6 above), `goodbye` is spoken via
Vapi's own `endCallMessage` mechanism, not by the model deciding to say a farewell — it plays
automatically right before the platform ends the call, so it was never one of the
`endCallPhrases` the model's own speech is matched against. No functional dependency here; the
`endCallPhrases` addition was only needed for `emergencyGoodbye`.

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

### 9. Call-ending phrases and phone-number digit words — NEW (VP-7 follow-up, 2026-09-25)

**`languages.settings.ja.endCallPhrases`** — if the assistant *says* any of these phrases, Vapi
hangs up the call after it finishes speaking (a backstop for when the model speaks a farewell
instead of calling `endCall` — `docs/VAPI-FACTS.md` VP-7 R8). CHANGED (content update,
2026-09-29) — a third phrase was added so the new `emergencyGoodbye`/`goodbye` wording (item 6/7
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

**`languages.settings.ja.phoneReadback`** — how the model speaks a phone number back to the caller.
Digit words, 0 to 9:
> ゼロ、イチ、ニー、サン、ヨン、ゴー、ロク、ナナ、ハチ、キュウ

Gloss: "zero, one, two, three, four, five, six, seven, eight, nine". ニー and ゴー carry a long vowel so
"2" and "5" cannot be misheard on a phone line.
Worked example the model is shown (for 090-1234-5678):
> ゼロキュウゼロ、イチニーサンヨン、ゴーロクナナハチ

Gloss: "zero-nine-zero, one-two-three-four, five-six-seven-eight".
**Question for a native speaker:** is this how a receptionist reads a number back over the phone
(4 as ヨン, 7 as ナナ, 9 as キュウ, groups separated by a pause)?

**`languages.settings.ja.severePainWords`** — NOT spoken to the caller; the trigger list for the
"possibly serious" 119 line (`emergencyUncertain`). The model only says that line when the caller's own
words include one of these; without a concrete list it said it for any mention of pain:
> 激痛 / ひどい痛み / 耐えられない / 我慢できない / 突然 / 動けない

Gloss: "intense/sharp pain" / "terrible pain" / "unbearable" / "can't bear it" / "suddenly" / "can't move".
**Question for a native speaker (safety-relevant):** what else do callers say when pain might be an
emergency — e.g. 「ズキズキ」 (throbbing), 「息ができない」 (can't breathe), 「痺れる」 (numb/tingling),
「意識」 (consciousness)? Too few words means a real emergency gets no 119 line; too many brings back
the over-triggering on ordinary aches.

**`phoneRetry.ja`** (NEW — asks for a phone number again after a wrong digit count or a "no" to the
read-back; wording from the source test suite, cases 18/19):
> 恐れ入ります、少し聞き取れなかったようでして、もう一度お電話番号をお願いできますでしょうか。

Gloss: "Excuse me, it seems I couldn't quite catch that — could you give me the phone number once more,
please?" **Question for a native speaker:** natural and polite enough for a clinic receptionist?

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

**`reservationSaved.ja`** — CHANGED (content update, 2026-09-29) — shortened; no longer promises
to email the details (the reservation flow no longer collects an email address at all):
> ありがとうございます。ご予約番号は[[reservationNumber]]でございます。

Gloss: "Thank you. Your reservation number is [[reservationNumber]]."

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
