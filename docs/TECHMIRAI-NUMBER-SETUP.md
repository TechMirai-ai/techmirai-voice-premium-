# TechMirai line — runbook (Jamal only)

Put `techmirai-ai` live on **+81-50-3201-5722**. Nothing here is done by the code or by Claude: every step that touches Google, Telnyx, Vapi, LINE, Neon or Vercel is yours. Do them in this order. See `docs/TECHMIRAI-AGENT.md` for what the agent does.

> Shell reminder: if a variable is already set in your shell, it shadows `.env` (`dotenv` never overrides). Run the project commands from a clean shell, e.g. `env -i HOME=$HOME PATH=$PATH npm run …`, or `unset` the variable first.

## 0. Database migration 0017 (before the deploy)

The new code writes a `consultation_requested` event to `notification_log`; without this migration every consultation SMS/LINE reservation fails and (the guards fail closed) nothing is sent. The consultation request itself is still saved.

```sql
-- db/migrations/0017_notification_log_consultation_event.sql
ALTER TABLE notification_log DROP CONSTRAINT notification_log_event_check;
ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_event_check
  CHECK (event IN ('booked', 'cancelled', 'rescheduled', 'consultation_requested'));
```

It changes only that CHECK: the three old values stay valid, anything else is still rejected, no data is touched. Run it:

1. In Neon, copy the **direct (non-pooled)** connection string (hostname **without** `-pooler`). The runner takes a session-level advisory lock that a pooled endpoint can mishandle.
2. In a clean shell: `DATABASE_URL='<direct string>' npm run db:migrate` (or put it in `.env` for the run). It applies only `0017_…` and prints it.
3. Run it when the system is idle; it holds a brief lock on `notification_log`.
4. Rollback (manual, only if no `consultation_requested` rows exist): in the SQL file's header comment.

Keep the Vercel `DATABASE_URL` on the **pooled** string.

## 1. The TechMirai archive (own Sheet + two Drive folders)

Follow `docs/ARCHIVE-PER-CLIENT-SETUP.md` with client id `techmirai-ai`:

1. Create an empty Google Sheet, e.g. `techmirai-ai — call archive`; note its id.
2. Paste the nine-column header row exactly as in that document.
3. Share **only the Sheet**, as Editor, with the service account (the `client_email` in `GOOGLE_SERVICE_ACCOUNT_JSON_B64`).
4. `npm run google:create-folder -- "techmirai-ai — call audio"` and `npm run google:create-folder -- "techmirai-ai — transcripts"`; note both folder ids. (Folders made by hand in Drive are invisible to the app.)
5. `npm run google:check -- techmirai-ai` (after step 2 below, so the variables exist locally).

Do **not** reuse the demo variables and do **not** add `sharedDemoArchive`.

## 2. Environment variables (locally in `.env` and in Vercel → Production)

| Variable | Value |
| --- | --- |
| `GOOGLE_ARCHIVE_TECHMIRAI_SHEET_ID` | the Sheet id |
| `GOOGLE_ARCHIVE_TECHMIRAI_DRIVE_FOLDER_ID` | the audio folder id |
| `GOOGLE_ARCHIVE_TECHMIRAI_TRANSCRIPT_FOLDER_ID` | the transcript folder id |
| `LINE_TECHMIRAI_STAFF_USER_ID` | your own LINE user id (`U` + 32 hex characters); a group id (`C…`) can be added later as another variable name in `notifications.line.recipientEnvs` |

`TELNYX_API_KEY` and `LINE_CHANNEL_ACCESS_TOKEN` already exist (Sakura uses them). Variables take effect only on the **next deploy**.

Until the archive variables are set, archive jobs for TechMirai calls stay `pending` (`archive destination not configured for techmirai-ai (unset: …)`) and nothing is written to any archive; once set, `npm run archive:retry` (or the scheduled retry) archives them.

## 3. Telnyx: the messaging profile's "Alpha sender" (SMS)

1. In Telnyx, open the messaging profile whose id is in `clients/techmirai-ai/client.yaml` (`notifications.sms.messagingProfileId`, the profile Sakura's SMS uses) and change its **Alpha sender** name from `Sakura` to `TechMirai`. Recipients do not see a phone number; they see that name.
2. Do **not** touch +1-725-715-8112: it stays attached to Sakura's inbound voice line in Vapi. The code never sends it as `from`.
3. Effect on the demos: every client on that profile shows "TechMirai" (accepted). Sakura's requests send `from: "Sakura"` explicitly (the profile name is not in the request); whether Telnyx then shows "Sakura" or the profile name is not known from the repo. If you want Sakura to match the profile for certain, include the optional commit "chore: Sakura SMS senderId to TechMirai" (separate from the TechMirai work; Kanto sends no SMS).
4. Set a **spend limit** on the Telnyx account if you have not (the app's caps bound the count, not the money).

## 4. One real test SMS (you approve and run it)

Preview first (sends nothing):

```
npm run techmirai:test-sms -- <your mobile 070/080/090…>
```

Then one real SMS (costs Telnyx credit):

```
npm run techmirai:test-sms -- <your mobile> --send            # Japanese text
npm run techmirai:test-sms -- <your mobile> --language en --send
```

It sends only the SMS: no LINE, no consultation request, **no database** (the delivery log is in memory for the run, so migration 0017 is not needed and the real daily cap and cooldown are not consulted). It needs `TELNYX_API_KEY` in the environment or `.env`. It prints your number masked and the Telnyx message id, and never any secret. Output ends with `RESULT: SENT …` (exit 0) or `RESULT: NOT SENT. status=… reason=…` (exit 1).

## 5. Vapi objects (after Claude's `vapi:sync` is approved and run)

Claude runs `vapi:sync` for `techmirai-ai` only, after you approve the texts. It creates `techmirai-ai--…` tools, three assistants (`ja`, `en`, `ja-return`), the squad and the call-outcome structured output, and commits `.vapi-state.techmirai-ai.json`. It attaches **no** phone number.

## 6. Connect the number

1. **Telnyx**: make sure +81-50-3201-5722 is yours on the Telnyx account Vapi uses for Sakura (same way Sakura's +1 line was imported; see `docs/VAPI-FACTS.md`, "Telnyx number import").
2. **Vapi**: import / add the number (using the Telnyx credential Vapi already holds for Sakura's line) and attach it to the **squad** `techmirai-ai--squad` (not to a single assistant). Do not change Sakura's or Kanto's numbers.
3. The webhook credential `VAPI_SERVER_CREDENTIAL_ID` is the global one already in use.

## 7. Merge and deploy

Merge `work/techmirai-agent`, deploy (the migration is already applied), confirm `GET /healthz`.

## 8. Real-call checklist

Tick each; note the call id.

- [ ] Japanese call, **caller-ID path**: greeting + recording notice; ask "what is TechMirai AI?"; ask for a meeting → name → "may we contact you on this number?" yes → "our staff will contact you on weekdays between 9 a.m. and 6 p.m. Japan time" (+ text mention if from a mobile).
- [ ] English call (say "English"), caller-ID path.
- [ ] **"Use another number"** path: read-back digit by digit, yes → saved with `phone_source = spoken`.
- [ ] **Refused-number** path: gives a name, refuses any number → no row, the agent points to info@techmirai-ai.com / the contact form.
- [ ] **Withheld caller ID** (in Japan dial `184` before the number you call, which hides your number): the agent asks for a number instead of using caller ID.
- [ ] **"Transfer me"** / "can I talk to a person?": it says it cannot connect you on this line (FAQ L2) and offers to take your name; it never offers to connect you.
- [ ] **"Am I speaking to an AI?"**: yes, Jenny/Hinata, FAQ L1.
- [ ] Ask something not in the FAQ (e.g. a price): it says it is not sure / pricing is not published, and offers the consultation request.
- [ ] **SMS arrives** on a mobile (sender "TechMirai"); no SMS for a landline or foreign caller.
- [ ] **LINE arrives** on your phone, with name, number, source and "SMS to caller: sent".
- [ ] Hang up and wait: **archive row appears** in the TechMirai Sheet (not the demo Sheet), with audio and transcript files in the TechMirai folders.
- [ ] Staff dashboard / call log: the call shows `needs_callback`; check the transcript for any caller-facing wording problem and send it to Claude.
- [ ] Repeat the same call from the same mobile within 24 h: the request is saved, **no second SMS**, LINE says "skipped - this number already got a text".

## Rollback

Detach the number from the squad in Vapi (calls stop reaching the agent). The code is additive; Sakura and Kanto are unaffected.
