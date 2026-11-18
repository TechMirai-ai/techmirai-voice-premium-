# techmirai-ai real-call checklist (VP-27)

Run this after the owner syncs. Audio behaviour cannot be proved by the text Evals, so these are real calls.
Japanese lines are followed by their English meaning.

Prepare: call the techmirai-ai number from a phone that shows its caller ID, then once from a phone that
withholds it (dial 184 first, or hide the number). After each call, open it in the Vapi dashboard (or
`GET /call/{id}`, `artifact.messages` and `artifact.presignedLogUrl`).

| # | Item | What to do | Pass looks like |
|---|------|------------|-----------------|
| 1 | M3 acknowledgement | Ask a question with a long answer (料金は? "what does it cost?" or 機能を教えて "tell me the features"). While it is talking, say a quick はい ("yes") or うん ("uh-huh"), no more. | The assistant carries on to the end of its answer. In the log, no cut at that moment. |
| 2 | M3 real interruption | Mid-answer, say a full sentence: ちょっと待ってください ("please wait a moment") or a new question. | The assistant stops within about a second and answers you. If it does NOT stop, `numWords: 1` is too strict for Japanese: tell Jamal, then delete the `stopSpeakingPlan` block to roll back. |
| 3 | M2 mid-sentence はい | Ask for a meeting. When the assistant reads your NAME back ("マルク様でよろしいでしょうか？"), say はい while it is still speaking the question, then stay silent. | It waits for you and asks again or waits. It must NOT go on to the contact-number question or save anything. |
| 4 | M4 name read-back | Give the name マルク. | The next reply is only the read-back (name + "is that right?"). Say いいえ、マークです ("no, it's Mark"): it corrects and reads back again. |
| 5 | M2 separate turns | Say はい to the read-back, then はい to "may staff contact you on this number?" | Two separate questions, then the save. Check the call log: `request_consultation` appears only after the second yes. |
| 6 | M5 number dictation | Phone with caller ID: answer いいえ、別の番号で ("no, another number"). Say a number slowly in groups, pausing about 2 seconds between groups: 080 ... 1234 ... 5678. | It waits through the pauses (does not speak after the first group) and reads all 11 digits back one by one. Log: `Endpointing timeout 2500ms (rule: assistant ...)` appears while you dictate. |
| 7 | M5 withheld number | Call with the number hidden. Say はい to the contact question. | It asks for a number (the tool reports no caller ID), you dictate it, it reads back, you say はい, it saves. |
| 8 | M5 tricky transcript | Dictate with kanji-style reading: 零八零、一二三四、五六七八 (zero eight zero, one two three four, five six seven eight). | Accepted as one 11-digit number; it never says it could not hear when all digits were given. |
| 9 | Clean-up | Ask 来週の水曜日に予約できますか？ ("can I book next Wednesday?") | It does not check availability or name a time; it offers the consultation request. |
| 10 | English | Say "English, please", then do items 4 and 5 in English. | Same behaviour (the English leg has no `stopSpeakingPlan` change). |

If item 6 fails (it still cuts in), send the call id: the log line `Endpointing timeout ... (rule: ...)` shows
whether the custom rule matched (`rule: assistant`) or the default heuristic ran (`rule: heuristic`).
The fallback `onNumberSeconds` is 1.5 s.
