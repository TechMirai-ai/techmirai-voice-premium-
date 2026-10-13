# VP-12 — Google setup guide (Option B: Sheets via service account, Drive via one-time OAuth)

Goal: a private Google Sheet (full transcripts) and a private Drive folder (call audio) that **only you** can open, written to by our server.

- **Sheets** is written by a **service account** (you share the Sheet with its email).
- **Drive** is written with a **long-lived OAuth refresh token** from your own Gmail. A service account cannot upload into a personal Gmail's Drive (no storage quota), which is why Drive is different.

**Never paste a key, token or secret into the chat, a commit or a ticket.** What you send back to me at the end is only: the service-account **email**, the **Sheet ID** and the **Drive folder ID** (none are secrets).

Time: about 30 minutes.

---

## ⚠️ The two traps

1. **Publish the OAuth consent screen to "In production" BEFORE you run the consent step (Step 6).** A refresh token issued while the app is in **"Testing"** stops working after **7 days** — uploads would start failing a week after launch. Tokens issued before publishing do not become long-lived; you must consent again afterwards.
2. **The Drive folder must be created by the app, not by hand.** We request only the narrow `drive.file` permission (the app sees only what it created, so a leaked token cannot read the rest of your Drive). `npm run google:consent` creates the folder for you.

---

## Step 1 — Create a Google Cloud project
1. https://console.cloud.google.com/ signed in as **your developer Google account**.
2. Project picker → **New project** → name `techmirai-voice-archive` → Create, then select it.

## Step 2 — Enable the two APIs
**APIs & Services → Library** → enable **Google Sheets API** and **Google Drive API**.

## Step 3 — Service account (for the Sheet only)
1. **IAM & Admin → Service Accounts → Create service account** → name `call-archive-writer`. Skip the optional access steps → Done.
2. Open it and copy its **email** (`call-archive-writer@<project-id>.iam.gserviceaccount.com`). **Send me this.**
3. **Keys → Add key → Create new key → JSON.** Move the downloaded file to `~/secrets/` (outside the project).
4. Make it one line: `base64 -w0 ~/secrets/<file>.json` — that output is `GOOGLE_SERVICE_ACCOUNT_JSON_B64`.

(If key creation is blocked by an org policy, tell me.)

## Step 4 — OAuth consent screen, then the OAuth client
1. **APIs & Services → OAuth consent screen** (shown as *Google Auth Platform* in newer consoles).
   - User type **External**; app name e.g. `TechMirai call archive`; your email as support and developer contact.
   - **Scopes / Data access:** add `https://www.googleapis.com/auth/drive.file` (non-sensitive — no Google verification review should be needed; tell me if the console says otherwise).
2. **Publish app → "In production".** Confirm the status now reads *In production*, not *Testing*. (At consent time Google will show an "unverified app" warning — this is your own app: **Advanced → Go to … (unsafe)**.)
3. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app** → create.
4. Copy the **client ID** and **client secret** into your local `.env`:
   ```
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   ```

## Step 5 — The private Sheet
1. https://sheets.google.com → blank spreadsheet `Call transcripts (private)`.
2. **Share** → add the service-account email as **Editor** (untick "Notify"); leave general access **Restricted**.
3. Copy the **Sheet ID** from `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`. **Send me this.**

## Step 6 — One-time consent (creates the folder and the refresh token)
In a terminal in the project folder:
```
npm run google:consent
```
It prints a URL. Open it in a browser signed in as your developer account, approve, and return to the terminal. It then:
- creates the private Drive folder **"Call audio (private)"** and prints its **folder ID** (send me this);
- writes the secrets to `~/secrets/techmirai-google-oauth.env` (mode 0600, outside the repo) — it does **not** print the refresh token.

## Step 6b — The transcript folder (VP-13)
Transcripts are no longer written into the Sheet; each call's full transcript is a `.txt` file in its own Drive folder, next to the audio folder, and the Sheet row links to it. Audio and transcript for one call share a name, `<date>-<time>-<topic>` (in the clinic's local time from `client.yaml`, `Asia/Tokyo` for Sakura — e.g. `2026-10-14-0042-reservation.wav` / `.txt` for a call at 00:42 JST; the Sheet's "Started at" column stays UTC); a second call in the same minute with the same topic becomes `…-2`, then `…-3`.

**Create the folder with the command below, not by hand in Drive.** The archive holds only the narrow `drive.file` permission (Step 6), so it can see and upload into folders *it created itself*. A folder made in the Drive web page — even one shared with the service account — is invisible to it and every upload would fail with "not found". (The service account is only for the Sheet; Drive uploads use the OAuth token.)
```
npm run google:create-folder -- <folder name>
```
It prints the new **folder ID**; set it as `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` (Step 7). You can rename or move the folder in Drive afterwards — the ID, and the app's access, don't change. The audio folder can be renamed the same way.

## Step 7 — Put the values where the other secrets live
In your local `.env` **and** in Vercel (Project → Settings → Environment Variables → Production):

| Variable | Where it comes from |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | Step 3 |
| `GOOGLE_ARCHIVE_SHEET_ID` | Step 5 |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Step 4 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | from `~/secrets/techmirai-google-oauth.env` |
| `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` | from the same file — the **audio** folder (the name is kept so nothing already deployed breaks) |
| `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` | VP-13: the **transcript** folder — see "Step 6b" |
| `GOOGLE_OAUTH_TOKEN_ISSUED_AT` | from the same file |
| `ARCHIVE_RETRY_SECRET` | any random 32+ character string you make up |

All of them or none: the app refuses to start with a half-configured archive, and says which variable is missing. Open the files in an editor to copy values — don't `source` them in a shell.

## Step 8 — Check it
```
npm run google:check
```
It writes a test row and two tiny test files, then removes them. It specifically proves:
1. a first upload with a fresh token works;
2. after the access token is forced to expire, a **second** token is minted from the stored refresh token and a second upload works;
3. a brand-new process holding only the stored secrets can still read the file (what a fresh Vercel instance looks like);
4. the token's age — see below.

**Expected `WARN` on day 1:** "The refresh token is 0.0 days old… re-run on or after <date>". The check cannot read whether Google treated the app as *Testing*; the proof is the same command still passing **8+ days later**. Put that date in your calendar.

| If you see… | It means |
| --- | --- |
| `invalid_grant` / "rejected" | The token was revoked or expired — most likely issued while still in *Testing*. Confirm Step 4.2, then re-run `google:consent`. |
| "folder not found … drive.file" | The folder wasn't created by this app. Re-run `google:consent`. |
| HTTP 403 on Sheets | The Sheet isn't shared with the service-account email as Editor. |
| "Did not return a refresh token" | Remove the app at https://myaccount.google.com/permissions and run `google:consent` again. |

## Step 9 — Retries (so a slow or failed upload never loses a call)

After each call the server saves the staff row first, then writes the call's row to your Sheet, then uploads the transcript file and writes its link into that row, then uploads the audio and writes its link too. If Google is slow or down, whatever finished stays finished and the rest is retried automatically (up to 5 attempts, then it gives up and keeps the error) — a retry never adds a second row, never uploads a file twice, and reuses the same file name.

- **Vercel Cron** calls `/api/internal/archive-retry` once a day (`vercel.json`; the Hobby plan allows daily). It authenticates with `Authorization: Bearer <CRON_SECRET>`, so in Vercel set **`CRON_SECRET` to the same value as `ARCHIVE_RETRY_SECRET`**.
- **By hand:** `npm run archive:retry` runs one pass from your machine and prints counts only.
- **Check it works after deploy:** `curl -s -H "Authorization: Bearer <your ARCHIVE_RETRY_SECRET>" https://<your-domain>/api/internal/archive-retry` should answer `{"status":"ok","claimed":0,…}`. The Vapi webhook secret must NOT work there (it is a different secret on purpose).
- The database needs the new tables and columns first: `npm run db:migrate` (migrations 0009, 0010 and, for VP-13, 0011).

## The Sheet's columns

Rows are appended to the first tab. Put this header in row 1 yourself (the code never writes it):

| A | B | C | D | E | F | G | H | I |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Started at (UTC) | Client | Call ID | Language | Status | Ended reason | Audio (Drive link) | Transcript (Drive link) | Duration (m:ss) |

Columns A–G are unchanged from VP-12. **Rows written before VP-13 are left as they are** (the first test call has its transcript text in columns H onward and no duration); only new calls follow the layout above. So when you update the header row, expect that one old row to look different.

Duration is computed from the call's start and end times (`h:mm:ss` for calls over an hour; blank if Vapi did not report both). The staff dashboard's All Calls and Reservations lists show the same value as "Duration: 3:07".

## What to send me
1. The service-account **email**. 2. The **Sheet ID**. 3. The **Drive folder IDs** (audio and transcript). 4. The output of `npm run google:check` (it contains no secrets).
