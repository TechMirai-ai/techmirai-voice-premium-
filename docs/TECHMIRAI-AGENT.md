# TechMirai AI's own voice agent (`techmirai-ai`)

A non-demo-customer voice agent for TechMirai AI's own website and its Japanese number **+81-50-3201-5722**. It answers questions about TechMirai AI (info channel), takes consultation requests (lead channel), and is itself a live demo of the product. Agents: **Jenny** (English) and **Hinata** (ヒナタ, Japanese). Same `ja` / `ja-return` / `en` squad structure as Sakura. Everything lives in `clients/techmirai-ai/client.yaml`; the Japanese has **not** had a native-speaker review yet.

Runbook for putting the line live: `docs/TECHMIRAI-NUMBER-SETUP.md` (Jamal only).

## What a call does

1. **Greeting** (same structure as Sakura's, including the recording notice), then the caller asks.
2. **Info channel.** Answers come only from the FAQ (`faq:` in client.yaml = `techmirai-ai-FAQ-v2.md`, converted mechanically, nothing reworded). Short natural answers, not a read-out of a long entry. No invented prices, results, customer names, certifications or retention periods; if it is not in the FAQ the agent says it is not sure and offers the consultation request. It is an AI and says so (FAQ L1).
3. **Consultation flow** (the lead channel):
   1. ask the name;
   2. ask whether staff may contact the caller on the number they are calling from;
   3. yes → tool `request_consultation` with `phone_source: "caller_id"`; the server takes the number from the call itself;
   4. "use another number", or caller ID missing/withheld (非通知, "caller ID not notified") → ask for the number, read it back digit by digit, after a yes call the tool with `phone_source: "spoken"`;
   5. the caller refuses to give any number → name only, **no tool call**, the agent points to info@techmirai-ai.com or the website contact form;
   6. after a successful save: "our staff will contact you on weekdays between 9 a.m. and 6 p.m. Japan time to arrange a meeting", plus "you should receive a text message shortly" only if the tool says one is expected;
   7. tool failure → apologise, point to the e-mail address / contact form, never say staff will contact them.
4. **No transfer.** There is no `transfer` block, so no transfer tool exists. The prompt tells the agent never to offer or promise to connect a caller to a person, whatever FAQ text describes forwarding in general; asked directly, it uses FAQ L2.

## What the server enforces (not the model)

`src/routes/requestConsultation.ts`:

- client and language come from the assistant that called; `call_id` comes from the Vapi call. A request with no call id never reaches the handler (HTTP 400) and nothing is saved.
- `caller_id`: the number is the call's own caller ID. If there is none (withheld, anonymous, absent) the tool answers "no caller ID, nothing saved, ask for a number" and saves nothing.
- `spoken`: the number is normalised with `normalizeCallerPhone` (`src/lib/callerPhone.ts`), the same helper and format as the call log; an invalid number is refused and nothing is saved.
- the name (100 characters) and reason (300) are put on one line, stripped of control and invisible characters, and length-limited **before** they are stored or reach any SMS/LINE text.
- saving is idempotent on `(client_id, call_id)` (`consultationRequestRepository.create`). **Only a newly created row notifies anyone**: a repeated tool call sends no second SMS and no second LINE message.

### Stored phone format (`consultation_requests.contact_phone`)

Same as every other table: a Japanese number as national digits (`09012345678`, landline `0312345678`); any other international number as `+` and digits (`+14155550100`). Never E.164 for Japan, never with separators.

## Notifications (existing pipeline, `src/notifications/`)

Order for a new request: **SMS first, then LINE**, so the staff message can say how the SMS went.

- **SMS to the caller**: `from` = `TechMirai` (config `notifications.sms.senderId`, the same mechanism as Sakura's `Sakura`) through the shared messaging profile, whose Alpha sender name Jamal sets to "TechMirai" in Telnyx; the +1-725-715-8112 number is NOT used as `from` and stays on Sakura's inbound voice line, in the call's language. Thanks, request received, staff will contact you on weekdays between 9 a.m. and 6 p.m. Japan time to arrange a meeting, please do not reply, contact e-mail. No phone number to call, nothing promotional, no link (the e-mail address is filled in from `consultation.contactEmail`).
- **Who may be texted** (all per-client config, so Sakura and Kanto behave exactly as before):
  - `allowedCountryCodes: ["+81"]` and `allowedNumberPrefixes: ["+8170", "+8180", "+8190"]` — Japanese mobiles only. Landlines, 050 numbers, non-Japanese and withheld numbers are saved but get no SMS.
  - one SMS per call (fixed rule), a per-number cooldown `consultationCooldownHours: 24`, a per-client cap `maxPerDay: 20` per rolling 24 h.
- **LINE to staff**: `notifications.line.recipientEnvs: [LINE_TECHMIRAI_STAFF_USER_ID]` (Jamal's own LINE user id). It is a list of env var **names**: a LINE group id is added later by adding another name — no code change (group handling itself is not built). The message (English) has: client, time (Japan time), language, name, number and where it came from (caller ID or spoken), reason, and the SMS status: `sent`, `skipped - <reason>` or `failed - <code>`.
- When an SMS is skipped, blocked or fails, the request is **still saved** and the LINE message says so.
- Delivery rows go to `notification_log` with event `consultation_requested` (migration 0017) and no personal data.

## Config values

| Where in client.yaml | Meaning |
| --- | --- |
| `business.hours.weekly` Mon–Fri `09:00`–`18:00`, `timezone: Asia/Tokyo`, Sat/Sun `closed`, no `closedOnNationalHolidays` | When staff contact callers. No claim about public holidays. The line itself answers at any hour (the prompt says so). |
| `consultation.contactHours` (ja, en) | The spoken/written wording of those hours — one value used by every spoken line and the SMS. |
| `consultation.contactEmail` | info@techmirai-ai.com |
| `consultation.scripts.*` | Every spoken line of the flow, per language. |
| `notifications.sms.*` | sender, prefixes, cooldown, daily cap, texts. Telnyx key env var `TELNYX_API_KEY`, messaging profile id. |
| `notifications.line.*` | token env var, recipient env var names, daily cap, staff message. |
| `archive.*` | `GOOGLE_ARCHIVE_TECHMIRAI_SHEET_ID`, `_DRIVE_FOLDER_ID`, `_TRANSCRIPT_FOLDER_ID`. No `sharedDemoArchive`: until these are set, archive jobs stay `pending` and nothing is written anywhere (fail closed). |

Small relaxations of the shared schema, none of which changes an existing client: `business.hours.closedOnNationalHolidays` is optional; `notifications.sms.templates` and `notifications.line.messageTemplate` (the booking texts) are optional.

## Known limits (accepted, see docs/TECHMIRAI-STOP1-APPROVAL.md §6b)

A spoken number can be any Japanese mobile (one text per number per 24 h, 20 a day); throwaway numbers can use up the daily SMS/LINE caps; the cooldown counts requests, not delivered texts; a crash between save and notify leaves a saved request with no LINE alert. A repeated `request_consultation` in the same call keeps the first details and says so.

## How a call shows up for staff

`call_logs.status`: a call where `request_consultation` succeeded is **`needs_callback`**. A failed or refused tool call, and a **name-only call** (no tool ran), stay **`unresolved`**. The name-only caller's name is in the call summary only.

## Deliberately not built

- **Transfer to a human** (disabled for this client).
- **Dashboard tab** for consultation requests (the rows exist; no screen).
- **LINE group** handling (the recipient list is ready for it).
- **Name-only row**: `consultation_requests.phone_source` has no `none` value and a migration for it was not asked for. A name-only call leaves no row. If wanted later: a tiny migration adding `phone_source = 'none'`.
- Pricing, case studies, certifications: not in the FAQ, so the agent does not say them.

## Facts and assumptions to confirm

- **Sender "TechMirai"**: Jamal renames the shared messaging profile's Alpha sender to "TechMirai" in Telnyx himself. A booking SMS from Sakura reached a Japanese mobile (reported by Jamal, no date, not verified by ECC; `NOTIFICATION-FACTS.md` T7). The yaml uses Sakura's messaging profile id.
- **Website** `https://techmirai-ai.com` and the **address** ("not published") in `business` are placeholders the shared schema needs; the agent does not speak the website.
- **Voices** are Sakura's (Miki for Japanese, Jillian for English) — proven on real calls; change in `languages.settings.<lang>.voice` if wanted.
- **FAQ flags** (not edited): see the report — notably FAQ W2's Japanese has an ASCII full stop in `できます. オンライン`, and several entries (V1, V2, V4, V6, V9, V12) say callbacks are taken and calls forwarded; the prompt rule "no transfer on this line" overrides forwarding wording.
