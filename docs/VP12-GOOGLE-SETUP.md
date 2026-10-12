# VP-12 — Google setup guide (done by you, in your own Google account)

Goal: a private Google Sheet (full transcripts) and a private Google Drive folder (call audio) that **only you** can open, written to by our server through a service account.

**Never paste a key file, private key or secret into the chat, a commit, or a ticket.** What you send back to me at the end is only: the service-account **email**, the **Sheet ID** and the **Drive folder ID** (none of these are secrets).

Time: about 20 minutes.

---

## ⚠️ Read first: the Drive-upload problem

A service account has **no storage space of its own**. Google rejects uploads from it into a normal "My Drive" folder of a personal Gmail account with `Service Accounts do not have storage quota`. (Sheets is fine — the Sheet is yours, the service account only edits it.) Reports also say service accounts created after April 2025 have zero quota. This comes from vendor docs and forum posts, not an official Google page, so we will **test it** (Step 8) before I build more on it.

Pick one for the audio folder:

| Option | What you need | Notes |
| --- | --- | --- |
| **A. Shared Drive** (keeps the "service account only" design) | A Google **Workspace** account (paid, ~US$7/user/month). Personal Gmail cannot create Shared Drives. | Cleanest. Service account is a member of the Shared Drive. |
| **B. One-time OAuth for Drive only** | Your normal Gmail. | You click "Allow" once; I store a refresh token. Sheets still uses the service account. Small deviation from decision 6 — tell me if you want it. |

If you have no Workspace account, do **B**. Steps 1–7 are the same for both.

---

## Step 1 — Create a Google Cloud project
1. Go to https://console.cloud.google.com/ signed in as **your developer Google account**.
2. Top bar → project picker → **New project**. Name: `techmirai-voice-archive`. Create, then select it.

## Step 2 — Enable the two APIs
1. Menu → **APIs & Services → Library**.
2. Search **Google Sheets API** → **Enable**.
3. Search **Google Drive API** → **Enable**.

## Step 3 — Create the service account
1. **IAM & Admin → Service Accounts → Create service account**.
2. Name: `call-archive-writer`. Skip the optional "grant access" and "grant users access" steps. **Done**.
3. Click it and copy its **email** — it looks like `call-archive-writer@techmirai-voice-archive.iam.gserviceaccount.com`. **This is the address you share things with, and the one to send me.**

## Step 4 — Create its key (this is the secret)
1. Open the service account → **Keys → Add key → Create new key → JSON → Create**. A `.json` file downloads.
2. Move it somewhere **outside** the project folder (for example `~/secrets/`). Never commit it.
3. Make it one line for Vercel (Linux): `base64 -w0 ~/secrets/<file>.json` — the output is the value of `GOOGLE_SERVICE_ACCOUNT_JSON_B64` below. Don't paste it anywhere except the env settings.

If your Google Cloud org blocks key creation ("Service account key creation is disabled"), tell me — there is a keyless alternative, but it needs more setup.

## Step 5 — Create the private Sheet
1. https://sheets.google.com → **Blank spreadsheet**. Name: `Call transcripts (private)`.
2. **Share** → add the service-account email as **Editor**. Untick "Notify people". Leave "General access" as **Restricted**.
3. Copy the **Sheet ID** from the URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

## Step 6 — Create the private audio folder
- **Option A:** in your Workspace, create a Shared Drive `Call audio (private)`; add the service-account email as **Content manager**; create nothing else shared. Copy the folder ID from the URL `https://drive.google.com/drive/folders/<FOLDER_ID>`.
- **Option B:** in Drive create a folder `Call audio (private)` (stays Restricted, shared with nobody). Copy `<FOLDER_ID>` the same way. You do not share it with the service account.

## Step 7 — Set the values
Put these in your local `.env` **and** in Vercel (Project → Settings → Environment Variables → Production; add Preview only if you want it):

| Variable | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | the base64 line from Step 4 |
| `GOOGLE_ARCHIVE_SHEET_ID` | Sheet ID (Step 5) |
| `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` | Folder ID (Step 6) |
| `ARCHIVE_RETRY_SECRET` | any random 32+ character string (protects the retry endpoint) |

Option B adds, after I give you a small consent script: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`.

Do not use `source .env` in a shell to check them; just open the file.

## Step 8 — Smoke test (I will provide it)
The first Google code I write is `npm run google:check`: it appends one test row to the Sheet and uploads one tiny file to the folder, then deletes the test file. If the Drive step fails with a storage-quota error, we switch to Option A or B before anything else is built.

## What to send me
1. The service-account **email**.
2. The **Sheet ID** and **folder ID**.
3. Which Drive option you chose (A or B).
