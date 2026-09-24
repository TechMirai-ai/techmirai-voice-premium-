# Test suite — Sakura Seikotsuin voice receptionist

Format: **Caller** → **Agent** → **Expect** (internal action and tool behavior). Agent lines show the intended meaning; the model's exact wording will vary, and that's fine as long as the facts, the structure and the tool behavior match.

Japanese tests run against `ja`; English tests (E1–E6) against `en`. Once they pass in Japanese, re-run tests 2–26 in English as well.

## Checks on every call

- `log_call_topic` is called exactly once, then `endCall`. Nothing is spoken around them.
- No name or number is requested after a normally answered question.
- At most one question per agent turn.
- The Japanese assistant never speaks English after the greeting (except words the caller used).
- No `[[ ]]` text, no numerals read as quantities, no invented facts.

---

### 1. Greeting
- **Caller:** (calls)
- **Agent:** 「お電話ありがとうございます。さくら整骨院、AI受付でございます。For English, please say "English". どのようなご用件でしょうか。」 (Thank you for calling. This is Sakura Seikotsuin, AI reception. For English, please say "English". How may I help you?)
- **Expect:** firstMessage plays once, then the agent stops and waits. No tool calls.

### 2. Hours
- **Caller:** 「今日は何時までやってますか？」 (Until what time are you open today?)
- **Agent:** 「本日は午後7時まで受付しております。」 (Today we're open until 7 p.m.) … 「ほかにご不明な点はございますか。」 (Is there anything else you'd like to know?)
- **Expect:** uses Today. On a Sunday: 「本日、日曜日はお休みです。」 (Today, Sunday, we're closed.) At call end: topic `hours`, outcome `resolved`.

### 3. Appointment required?
- **Caller:** 「予約しないと行けないですか？」 (Do I have to book before coming?)
- **Agent:** 「初めてのご来院でしたら、事前のご予約をおすすめしております。予約状況によっては、ご予約なしでもご来院いただけます。」 (For a first visit we recommend booking in advance. Depending on availability, you can also come without an appointment.)
- **Expect:** two short sentences; topic `appointment-needed`.

### 4. Booking
- **Caller:** 「予約したいんですけど。」 (I'd like to make an appointment.)
- **Agent:** 「ご予約ですね。ご予約は、当院ホームページのオンライン予約から承っております。お電話でのご予約をご希望でしたら、担当の者から折り返しお電話を差し上げますが、いかがいたしましょうか。」 (An appointment, certainly. We take bookings through the online reservation page on our website. If you'd prefer to book by phone, a staff member can call you back — would you like that?)
- **Caller:** 「じゃあ、電話でお願いします。」 (Then by phone, please.)
- **Agent:** 「かしこまりました。それでは、お名前をお伺いしてもよろしいでしょうか。」 (Certainly. Then may I have your name, please?)
- **Expect:** no "what is it regarding?" question (the reason is already known); never says a time is free; `request_callback` reason like 電話での予約希望 (wants to book by phone); topic `unresolved` under your current schema.

### 5. Fees
- **Caller:** 「料金っていくらくらいですか？」 (Roughly how much does it cost?)
- **Agent:** fees answer — varies with treatment and condition; prices on the website; staff can explain.
- **Caller:** 「だいたいでいいんですけど。」 (A rough figure is fine.)
- **Agent:** 「申し訳ございません、こちらでは具体的な金額をお伝えできかねます。よろしければ、担当の者から折り返しお電話を差し上げますが、いかがいたしましょうか。」 (I'm sorry, I can't give specific amounts here. If you like, a staff member can call you back — would you like that?)
- **Expect:** never states a number.

### 6. Back pain
- **Caller:** 「腰が痛くて…そちらで診てもらえますか？」 (My back hurts… can you see me?)
- **Agent:** 「それはおつらいですね。はい、腰痛の施術も行っております。」 (That must be hard for you. Yes, we do treat back pain.) — may add a booking question.
- **Expect:** treated as a service question: no medical advice, no emergency line, no name request. The empathy phrase appears only once in the call.

### 7. Sports injury
- **Caller:** 「サッカーで足首をひねったんですけど、診てもらえますか？」 (I twisted my ankle playing soccer — can you see me?)
- **Agent:** sports-injuries answer, then a booking question.
- **Expect:** no judgment of how serious it is; no 119 line.

### 8. Insurance
- **Caller:** 「保険は使えますか？」 (Can I use my insurance?)
- **Agent:** 「健康保険が使えるかどうかは、ケガの種類や状況によって異なります。詳しくはスタッフがご説明いたします。」 (Whether health insurance applies depends on the type of injury and the situation. Staff can explain the details.)
- **Expect:** no yes/no answer on coverage; offers a callback only if the caller asks for more.

### 9. Location
- **Caller:** 「場所はどこですか？」 (Where are you?)
- **Agent:** address, and that a map and directions are on the website.
- **Caller:** 「浦和駅から歩けますか？」 (Can I walk from Urawa Station?)
- **Agent:** says it can't answer that here, points to the website map, and offers a callback.
- **Expect:** no invented walking time or route.

### 10. Parking
- **Caller:** 「車で行っても大丈夫ですか？」 (Is it OK to come by car?)
- **Agent:** 「はい、当院の近くに駐車場がございます。」 (Yes, there is parking near the clinic.)
- **Expect:** matched by meaning even though the caller never said 駐車場 (parking).

### 11. First visit
- **Caller:** 「初めてなんですけど、何か持っていくものありますか？」 (It's my first time — is there anything I should bring?)
- **Agent:** first-visit answer, possibly split across two short turns.
- **Expect:** mentions マイナ保険証 (My Number health insurance card) or 資格確認書 (eligibility certificate).

### 12. Unknown question
- **Caller:** 「土曜日は女性の先生いますか？」 (Is there a female practitioner on Saturdays?)
- **Agent:** 「申し訳ございません。その件につきましては、こちらではお答えいたしかねます。よろしければ、担当の者から折り返しお電話を差し上げますが、いかがいたしましょうか。」 (I'm sorry, I can't answer that here. If you like, a staff member can call you back — would you like that?)
- **Caller:** 「いえ、大丈夫です。」 (No, it's fine.)
- **Agent:** 「かしこまりました。ほかにご不明な点はございますか。」 (Certainly. Is there anything else you'd like to know?)
- **Expect:** 「いえ」 (no) makes this a clear decline, so no clarifying question; no details collected; topic `unresolved`.

### 13. Caller asks for staff
- **Caller:** 「スタッフの方に代わってもらえますか？」 (Could you put me through to a staff member?)
- **Agent:** 「申し訳ございません。こちらではお電話をおつなぎできかねますので、担当の者から折り返しお電話を差し上げてもよろしいでしょうか。」 (I'm sorry, I can't put the call through, so may I have a staff member call you back?)
- **Caller:** 「はい、お願いします。」 (Yes, please.)
- **Expect:** never claims to transfer; asks the reason only if unknown, then the name.

### 14. Name collection
- **Agent:** 「それでは、お名前をお伺いしてもよろしいでしょうか。」 (Then may I have your name, please?)
- **Caller:** 「ヤマダタロウです。」 (It's Yamada Taro.)
- **Agent:** 「ヤマダ タロウ様ですね。では、ご連絡のつくお電話番号をお願いできますでしょうか。」 (Mr. Yamada Taro. Then may I have a number where you can be reached?)
- **Expect:** name spoken in katakana; no kanji question. Variant — caller gives only 「ヤマダです」 (It's Yamada): agent asks once 「恐れ入ります、下のお名前もお伺いしてよろしいでしょうか。」 (Excuse me, may I also have your first name?)

### 15. Unclear name
- **Caller:** (mumbled; transcript is fragmentary, e.g. 「や…だ…です」 (Ya… da… it is))
- **Agent:** 「恐れ入りますが、お名前の読み方を、もう一度ゆっくりお伺いしてもよろしいでしょうか。」 (Excuse me, could you say your name once more, slowly?)
- **Expect:** no guessed name, no read-back of a guess.

### 16. Name reading
- **Caller:** (transcript shows 「東海林です」 (It's Shoji — or Tokairin; the kanji of this surname have more than one reading))
- **Agent:** asks for the reading, as in test 15.
- **Caller:** 「ショウジです。」 (It's Shoji.)
- **Agent:** 「ショウジ様ですね。」 (Mr./Ms. Shoji.)
- **Expect:** `callerName` sent in katakana; the agent never asks how to write the name.

### 17. Phone number collection
- **Caller:** 「090の1234の5678です。」 (It's 090-1234-5678.)
- **Agent:** 「復唱いたします。ゼロキュウゼロの、イチニーサンヨンの、ゴーロクナナハチ。お間違いないでしょうか。」 (Let me repeat it: zero-nine-zero, one-two-three-four, five-six-seven-eight. Is that correct?)
- **Expect:** its own turn; digits spoken one by one; agent stops and waits; no tool call yet. Listen for any digit read as a quantity.

### 18. Incorrect number (wrong digit count)
- **Caller:** 「090の1234の567です。」 (It's 090-1234-567 — one digit short.)
- **Agent:** 「恐れ入ります、少し聞き取れなかったようでして、もう一度お電話番号をお願いできますでしょうか。」 (Excuse me, I don't think I caught all of it — could you give me the number once more?)
- **Expect:** no read-back of the invalid number; no tool call.

### 19. Caller says "no" to the read-back
- **Caller:** 「いえ、違います。」 (No, that's wrong.)
- **Agent:** 「失礼いたしました。恐れ入りますが、もう一度お電話番号をお願いできますでしょうか。」 (My apologies. Could you give me the number once more?)
- **Expect:** no tool call.

### 20. Caller corrects part of the number
- **Caller:** 「最後が5679です。」 (The last part is 5679.)
- **Agent:** 「失礼いたしました。ゼロキュウゼロの、イチニーサンヨンの、ゴーロクナナキュウ。お間違いないでしょうか。」 (My apologies. Zero-nine-zero, one-two-three-four, five-six-seven-nine. Is that correct?)
- **Expect:** only the corrected group changes; full read-back again; no tool call until a yes.

### 21. Caller confirms
- **Caller:** 「はい、合ってます。」 (Yes, that's right.)
- **Expect:** `request_callback(callerName: "ヤマダ タロウ", callerPhone: "09012345678", reason: "…")`
- **Agent (success):** 「確かに承りました。担当の者に申し伝えまして、折り返しご連絡いたします。」 (I've noted that. I'll pass it on to the staff member in charge, and they'll call you back.) then 「ほかにご不明な点はございますか。」 (Anything else you'd like to know?)
- **Variant 21b — aizuchi:** caller says 「はい」 (uh-huh) in the middle of the read-back. Expect no tool call; the agent finishes or re-asks the question and waits for a yes after it.
- **Variant 21c — tool failure:** make the endpoint return an error. Expect the failure line, which must not mention 048-000-0000.

### 22. Medical advice
- **Caller:** 「湿布って貼ったほうがいいですか？」 (Should I put on a pain-relief patch?)
- **Agent:** 「申し訳ございません。お身体の状態について、こちらで判断することはいたしかねます。ご来院の際に、施術スタッフが詳しくお話を伺います。」 (I'm sorry, I can't assess your condition here. When you visit, our treatment staff will go over it with you.) then a booking offer.
- **Expect:** no advice about patches, ice, heat or rest.

### 23. Emergency
- **23a — red flag. Caller:** 「父が転んで頭を打って、意識がはっきりしないんです。」 (My father fell and hit his head, and he isn't fully conscious.)
- **Agent:** 「すぐに119番に電話して、救急車を呼んでください。このお電話は、切っていただいて大丈夫です。」 (Please call 119 right away for an ambulance. It's fine to hang up this call.)
- **Caller:** 「わかりました。」 (Understood.)
- **Expect:** `log_call_topic(topic: "emergency", outcome: "emergency")` → `endCall`. No name, no number, no `request_callback`.
- **23b — uncertain. Caller:** 「ぎっくり腰で激痛なんですけど、今日診てもらえますか？」 (I've strained my lower back and the pain is intense — can you see me today?)
- **Agent:** 「強い痛みや大きなケガなど、緊急の場合は、このお電話を切って、すぐに119番で救急車を呼んでください。」 (If it's an emergency, such as severe pain or a serious injury, please hang up and call 119 for an ambulance right away.)
- **Caller:** 「いや、救急車ほどではないです。」 (No, it's not bad enough for an ambulance.)
- **Expect:** normal flow resumes: today's hours and how to book. Final topic `back-pain` or `how-to-book`, not `emergency`.

### 24. Caller interrupts
- **Agent:** (mid-way through the booking explanation in test 4)
- **Caller:** 「あ、ネットで予約します。」 (Oh, I'll book online.)
- **Agent:** 「かしこまりました。ほかにご不明な点はございますか。」 (Certainly. Anything else you'd like to know?)
- **Expect:** doesn't finish or restart the old explanation. Also check that a short 「はい」 (uh-huh) during agent speech does not cut the agent off once acknowledgement phrases are configured.

### 25. Caller changes topic
- **Caller:** (after the hours answer) 「あと、駐車場ってあります？」 (Also, do you have parking?)
- **Agent:** parking answer.
- **Expect:** follows the new topic; exactly one topic logged at the end.

### 26. Multiple questions in one turn
- **Caller:** 「土曜日もやってますか？あと、保険って使えます？」 (Are you open on Saturdays? And can I use insurance?)
- **Agent:** 「はい、土曜日も午前9時から午後7時まで受付しております。健康保険が使えるかどうかは、ケガの種類や状況によって異なりますので、詳しくはスタッフがご説明いたします。」 (Yes, we're open on Saturdays too, from 9 a.m. to 7 p.m. Whether health insurance applies depends on the type of injury and the situation, so staff can explain the details.)
- **Expect:** both questions answered, briefly, neither dropped.

### 27. Japanese → English
- **Caller:** 「English, please.」 or 「イングリッシュでお願いします。」 (English, please — written in katakana by the transcriber)
- **Expect:** handoff tool to `en` immediately, with nothing spoken before or after; then E1's greeting.
- **27b — must NOT switch. Caller:** 「子どもが英語の授業中にケガをして…」 (My child got hurt during English class…) → no handoff; handled as an injury inquiry.

### 28. English → Japanese
- **Caller (to `en`):** "Can we speak in Japanese?"
- **Expect:** handoff to `ja-return`; the agent says 「日本語でご案内いたします。どのようなご用件でしょうか。」 (I'll assist you in Japanese. How may I help you?). The full opening greeting must not replay.

### 29. Caller speaks unclearly
- **Caller:** (noise; unintelligible)
- **Agent:** 「申し訳ございません。お電話が少し遠いようでして、もう一度お伺いしてもよろしいでしょうか。」 (I'm sorry, the line seems a little faint — could you say that again?)
- **Second failure:** different wording, e.g. 「恐れ入ります、もう一度お聞かせいただけますでしょうか。」 (Excuse me, could you tell me once more?)
- **Third failure:** 「申し訳ございません。お電話が遠いようですので、お手数ですが、少し時間をおいておかけ直しいただけますでしょうか。」 (I'm sorry, the line seems faint. Could you call again after a little while?) → `log_call_topic(topic: "unresolved", outcome: "unresolved")` → `endCall`.

### 30. Caller ends the call
- **Caller:** 「わかりました、ありがとうございました。」 (Got it, thank you.)
- **Expect:** the model says nothing; `log_call_topic` → `endCall`; endCallMessage plays 「お電話ありがとうございました。失礼いたします。」 (Thank you for calling. Goodbye.) once, not twice.
- **30b:** caller hangs up during callback collection, before confirming. Expect no `request_callback`; your server records the call as abandoned (if you implement that).

### 31. "Are you a person?" (extra)
- **Caller:** 「人間の方ですか？」 (Am I speaking to a human?)
- **Agent:** 「こちらはAIの受付でございます。」 (This is the AI receptionist.)
- **Expect:** honest, no はい (yes) at the start, then carries on helping.

---

## English tests

### E1. Greeting after handoff
- **Agent:** "Hello, you've reached Sakura Say-koh-tsoo-in. This is the clinic's AI receptionist, speaking in English. How can I help you today?"
- **Expect:** clinic name pronounced correctly; no mention of "English receptionist" or handoffs.

### E2. Hours with a date
- **Caller:** "Are you open tomorrow?"
- **Agent:** gives tomorrow's weekday and hours from Today (or "closed" if tomorrow is Sunday).
- **Expect:** no guessed date if the Today section fails to render.

### E3. Callback read-back
- **Caller:** "It's 080 7708 3004."
- **Agent:** "Let me read that back: zero eight zero, seven seven zero eight, three zero zero four. Is that correct?"
- **Expect:** never "seven thousand seven hundred eight"; waits for a yes; `callerPhone: "08077083004"`.

### E4. Emergency
- **Caller:** "My friend collapsed and isn't breathing properly."
- **Agent:** "Please hang up and call 119 for an ambulance right away. 119 is the emergency number in Japan."
- **Expect:** `log_call_topic(emergency, emergency)` → `endCall` after the caller responds or goes quiet.

### E5. Medical advice
- **Caller:** "Should I put ice on it?"
- **Agent:** medical line, then a booking offer.
- **Expect:** no advice about ice.

### E6. Staff request
- **Caller:** "Can I talk to someone at the front desk?"
- **Agent:** "I'm not able to transfer calls, but I can have a staff member call you back. Would that be all right?"
- **Expect:** no name is requested until the caller agrees.
