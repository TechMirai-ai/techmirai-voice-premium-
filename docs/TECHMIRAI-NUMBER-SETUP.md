# TechMirai line — runbook (Jamal only)

Put `techmirai-ai` live on **+81-50-3201-5722**. Nothing here is done by the code or by Claude: every step that touches Google, Telnyx, Vapi, LINE, Neon or Vercel is yours (except the `vapi:sync` runs, which Claude does only after you approve the texts). See `docs/TECHMIRAI-AGENT.md` for what the agent does.

> Shell reminder: a variable already set in your shell shadows `.env` (`dotenv` never overrides). That is what the "hidden prompt" snippets below rely on. Never `source .env`.

## Order of operations

| # | Step | Who | Why this position |
| --- | --- | --- | --- |
| 1 | **Migrate** (0017) on Neon, direct URL (§1) | you | Must exist before the new code runs, or consultation SMS/LINE reservations fail closed. Old code ignores it. |
| 2 | Archive Sheet + two folders, env vars locally and in Vercel (§2, §3) | you | Until set, TechMirai archive jobs stay `pending`; nothing is lost. Vercel picks variables up on the **next deploy**, so set them before step 6. |
| 3 | Telnyx: rename the profile's Alpha sender (§4); optional test SMS (§5) | you | Independent of the rest. |
| 4 | **`vapi:sync` for `techmirai-ai`**, one `--apply` at a time: `ja`, `ja-return`, `en`, then `--squad` | Claude, after you approve | Creates the Vapi assistants/tools/squad. Their webhook URLs use `PUBLIC_BASE_URL` (the production URL), so that must be set to the production URL when it runs. No number is attached, so nothing can call them yet. |
| 5 | **Commit `.vapi-state.techmirai-ai.json` after EACH `--apply`** | Claude | The sync CLI refuses to run again while that file has uncommitted changes, so it is commit, apply, commit, apply… four commits. Git is the rollback. |
| 6 | **Merge `work/techmirai-agent`, then deploy** | you | The deployed server needs the state file (see below), `clients/techmirai-ai/` and the new route. Both are bundled into the function by `vercel.json` (`includeFiles`). |
| 7 | Staff dashboard user (§6) | you | Needs the migrated database; any time after step 1. |
| 8 | **Connect the number** to the squad in Telnyx/Vapi (§7) | you | Last: from this moment real callers reach the agent. |
| 9 | Test calls (§8) | you | |

**Does the deployed server need `.vapi-state.techmirai-ai.json`?** Yes, treat it as required. When Vapi calls a tool, the server works out which client and language it is from `message.assistant`: it looks the assistant **id** up in the committed state file, and falls back to the assistant **name** (`techmirai-ai--ja`, …) matched against the client's yaml. Whether Vapi sends the name as well as the id on a real squad call is only partly confirmed in this repo (`docs/VAPI-FACTS.md` VP-4 R2), so without the state file in the deployed build the tool calls may answer "could not be matched to a clinic, nothing was saved" and no request is saved. A deploy that does **not** include the state file must not have the number attached.

## 1. Database migration 0017 (before the deploy)

```sql
-- db/migrations/0017_notification_log_consultation_event.sql
ALTER TABLE notification_log DROP CONSTRAINT notification_log_event_check;
ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_event_check
  CHECK (event IN ('booked', 'cancelled', 'rescheduled', 'consultation_requested'));
```

It changes only that CHECK: the three old values stay valid, anything else is still rejected, no data is touched. Run it **without typing the database URL into a command**:

1. In Neon, copy the **direct (non-pooled)** connection string (hostname **without** `-pooler`). The runner takes a session-level advisory lock that a pooled endpoint can mishandle.
2. In a terminal, type this (the prompt does not echo what you paste, and the URL is not stored in your shell history):

   ```bash
   read -rs -p 'Neon DIRECT URL (hidden): ' DATABASE_URL; echo
   export DATABASE_URL
   npm run db:migrate
   unset DATABASE_URL
   ```

   It prints the migration file name it applied (`0017_…`) and nothing secret. Alternative: keep the URL in a file only you can read (`chmod 600 ~/neon-direct.url`, one line, outside the repo) and use `export DATABASE_URL="$(cat ~/neon-direct.url)"` instead of the `read` line.
3. Run it when the system is idle (a brief lock on `notification_log`). Keep the Vercel `DATABASE_URL` on the **pooled** string.
4. Rollback (manual, only if no `consultation_requested` rows exist): in the SQL file's header comment.

## 2. The TechMirai archive (own Sheet + two Drive folders)

Follow `docs/ARCHIVE-PER-CLIENT-SETUP.md` with client id `techmirai-ai`:

1. Create an empty Google Sheet, e.g. `techmirai-ai — call archive`; note its id.
2. Paste the nine-column header row exactly as in that document.
3. Share **only the Sheet**, as Editor, with the service account (the `client_email` in `GOOGLE_SERVICE_ACCOUNT_JSON_B64`).
4. `npm run google:create-folder -- "techmirai-ai — call audio"` and `npm run google:create-folder -- "techmirai-ai — transcripts"`; note both folder ids. (Folders made by hand in Drive are invisible to the app.)
5. `npm run google:check -- techmirai-ai` (after §3 so the variables exist locally).

Do **not** reuse the demo variables and do **not** add `sharedDemoArchive`.

## 3. Environment variables (locally in `.env` and in Vercel → Production)

| Variable | Value |
| --- | --- |
| `GOOGLE_ARCHIVE_TECHMIRAI_SHEET_ID` | the Sheet id |
| `GOOGLE_ARCHIVE_TECHMIRAI_DRIVE_FOLDER_ID` | the audio folder id |
| `GOOGLE_ARCHIVE_TECHMIRAI_TRANSCRIPT_FOLDER_ID` | the transcript folder id |
| `LINE_TECHMIRAI_STAFF_USER_ID` | your own LINE user id (`U` + 32 hex characters); a group id (`C…`) can be added later as another variable name in `notifications.line.recipientEnvs` |

`TELNYX_API_KEY` and `LINE_CHANNEL_ACCESS_TOKEN` already exist (Sakura uses them). Variables take effect only on the **next deploy**. Until the archive variables are set, archive jobs for TechMirai calls stay `pending` (`archive destination not configured for techmirai-ai (unset: …)`) and nothing is written to any archive; once set, `npm run archive:retry` (or the nightly retry) archives them.

## 4. Telnyx: the messaging profile's "Alpha sender" (SMS)

1. Open the messaging profile whose id is in `clients/techmirai-ai/client.yaml` (`notifications.sms.messagingProfileId`, the profile Sakura's SMS uses) and change its **Alpha sender** name from `Sakura` to `TechMirai`. Recipients see that name, not a number.
2. Do **not** touch +1-725-715-8112: it stays on Sakura's inbound voice line. The code never sends it as `from`.
3. Every client on that profile shows "TechMirai" (accepted). Sakura's requests send `from: "Sakura"` explicitly; whether Telnyx shows that or the profile name is not known from the repo — the optional commit `b91c5d0` (Sakura `senderId` to `TechMirai`) is yours to include or leave out after your test.
4. Set a **spend limit** on the Telnyx account if you have not (the app's caps bound the count, not the money).

## 5. One real test SMS (you run it)

Preview (sends nothing): `npm run techmirai:test-sms -- <your mobile>`. One real SMS (costs Telnyx credit): add `--send` (and `--language en` for English). It sends only the SMS, uses **no database** (so it works before the migration), prints your number masked and no secret, and ends with `RESULT: SENT …` or `RESULT: NOT SENT. status=… reason=…`.

## 6. Staff dashboard user (so consultation calls are visible)

Needs the migrated database. Create one login for `techmirai-ai` (use the same hidden-URL prompt as §1, pointing at the production database; the **direct** string is fine here too):

```bash
read -rs -p 'Neon URL (hidden): ' DATABASE_URL; echo
export DATABASE_URL
npm run staff:create -- you@example.com techmirai-ai
unset DATABASE_URL
```

It prints a **one-time temporary password** (store it in your password manager; it is not saved anywhere else) and refuses a client id that has no `clients/<id>/client.yaml`. Emails are unique across all clients, so use an address that is not already a Sakura or Kanto login. Log in on the deployed site's staff page; the dashboard shows only `techmirai-ai`'s calls: time, duration, **status** (a saved consultation request shows `needs_callback`), the short summary and the caller's name. The consultation request **rows themselves have no screen** yet (not built); they are in the `consultation_requests` table.

## 7. Connect the number

1. **Telnyx**: make sure +81-50-3201-5722 is yours on the Telnyx account Vapi uses for Sakura (same way Sakura's +1 line was imported; see `docs/VAPI-FACTS.md`, "Telnyx number import").
2. **Vapi**: import / add the number (using the Telnyx credential Vapi already holds for Sakura's line) and attach it to the **squad** `techmirai-ai--squad` (not to a single assistant). Do not change Sakura's or Kanto's numbers.
3. The webhook credential `VAPI_SERVER_CREDENTIAL_ID` is the global one already in use.
4. Before attaching: confirm the deploy is live (`GET /healthz`) and includes the state file (e.g. the commit with `.vapi-state.techmirai-ai.json` is on `main` and in the deployed commit).

## 8. Real-call checklist

Tick each; note the call id.

- [ ] Japanese call, **caller-ID path**: greeting + recording notice (company spoken as "テックミライ" if you kept the pronunciation setting); ask "what is TechMirai AI?"; ask for a meeting → name → "may we contact you on this number?" yes → "our staff will contact you on weekdays between 9 a.m. and 6 p.m. Japan time" (+ text mention if from a mobile).
- [ ] English call (say "English"), caller-ID path.
- [ ] **"Use another number"** path: read-back digit by digit, yes → saved with `phone_source = spoken`.
- [ ] **Spoken number that is a landline** (e.g. 03-…): the request is saved, **no text** is mentioned or sent, LINE says "SMS to caller: skipped - not a mobile number (landline or other)".
- [ ] **Refused-number** path: gives a name, refuses any number → no row, the agent points to info@techmirai-ai.com / the contact form.
- [ ] **Withheld caller ID** (in Japan dial `184` before the number): the agent asks for a number instead of using caller ID; nothing is saved until you give one and say yes.
- [ ] **"Are you open on Saturday?"**: it must not say the line is closed (the line answers at any hour); it may say staff contact callers on weekdays 9–6 Japan time, and must say nothing about public holidays. Note exactly what it says.
- [ ] **"When will staff contact me?"** with **no request made**: it should explain (FAQ L3) that if you leave a request, staff contact you on weekdays between 9 a.m. and 6 p.m. Japan time, and offer to take your name; it must **not** claim anyone has been told or will call.
- [ ] **"Transfer me"** / "can I talk to a person?": it says it cannot connect you on this line (FAQ L2) and offers to take your name; it never offers to connect you.
- [ ] **"Am I speaking to an AI?"**: yes, Jenny/Hinata, FAQ L1.
- [ ] Ask something not in the FAQ (e.g. a price): it says it is not sure / pricing is not published, and offers the consultation request.
- [ ] **SMS arrives** on a mobile (sender "TechMirai"); no SMS for a landline or foreign caller.
- [ ] **LINE arrives** on your phone, with name, number, source and "SMS to caller: sent".
- [ ] Hang up and wait: **archive row appears** in the TechMirai Sheet (not the demo Sheet), with audio and transcript files in the TechMirai folders.
- [ ] Staff dashboard (§6): the call shows `needs_callback`, the summary and the name.
- [ ] Repeat the same call from the same mobile within 24 h: the request is saved, **no second SMS**, LINE says "skipped - this number already got a text".

## Rollback

Detach the number from the squad in Vapi (calls stop reaching the agent). The code is additive; Sakura and Kanto are unaffected.
