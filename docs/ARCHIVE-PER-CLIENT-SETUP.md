# Per-client Google archive — setup for a new client

Every client archives into **its own** Google Sheet and **its own two** Drive folders (audio, transcripts). Nothing is written to a location shared with another client. The Google *credentials* (service account, OAuth token, retry secret) stay global and are set up once — see `docs/VP12-GOOGLE-SETUP.md`. This page is only about the destination of one more client.

## How it works (read once)

- `clients/<clientId>/client.yaml` has a **required** `archive` block holding env var **names** (never the ids):

  ```yaml
  archive:
    sheetIdEnv: GOOGLE_ARCHIVE_<CLIENT>_SHEET_ID
    audioFolderIdEnv: GOOGLE_ARCHIVE_<CLIENT>_AUDIO_FOLDER_ID
    transcriptFolderIdEnv: GOOGLE_ARCHIVE_<CLIENT>_TRANSCRIPT_FOLDER_ID
  ```

  The names are written out explicitly in the yaml — never derived from the client id. They must start with `GOOGLE_ARCHIVE_`, the three must differ, and no two clients may share a name (a test enforces this).
- The archive worker keeps one global queue, but for each job it looks up the job's `client_id`, reads that client's `archive` block, and reads the three variables it names.
- **Fail closed.** If the client is unknown, has no `archive` block, or any of its three variables is unset or blank, the worker makes **no Google call at all**. It records `archive destination not configured for <clientId> (unset: <VARIABLE NAMES>)` on the job. The job and the call record are kept, and the job stays `pending` (never terminally failed), so once you set the variables the next retry run archives it. It never falls back to another client's destination.

### Naming — important

| Client | Sheet id | Audio folder id | Transcript folder id |
| --- | --- | --- | --- |
| `sakura-seikotsuin` | `GOOGLE_ARCHIVE_SHEET_ID` | `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` | `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` |
| `kanto-city-gas-demo` | `GOOGLE_ARCHIVE_KANTO_SHEET_ID` | `GOOGLE_ARCHIVE_KANTO_AUDIO_FOLDER_ID` | `GOOGLE_ARCHIVE_KANTO_TRANSCRIPT_FOLDER_ID` |

**`GOOGLE_ARCHIVE_SHEET_ID`, `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` and `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` now mean *Sakura's* Sheet and folders — they are not "the" archive.** They kept their old names only so Sakura needs no new settings. No code reads them directly any more; they are looked up through Sakura's `archive` block like any other client's. Do not reuse them for another client.

For a new client, use `GOOGLE_ARCHIVE_<CLIENT>_SHEET_ID`, `GOOGLE_ARCHIVE_<CLIENT>_AUDIO_FOLDER_ID`, `GOOGLE_ARCHIVE_<CLIENT>_TRANSCRIPT_FOLDER_ID` (a short upper-case client name, e.g. `KANTO`).

## Steps

### 1. Create the Sheet
In Google Sheets (signed in as the developer account), create a new, empty spreadsheet named e.g. `<clientId> — call archive`. Copy its **spreadsheet id** (the long part of the URL between `/d/` and `/edit`).

### 2. Add the exact header row
Put these nine headers in row 1 of the **first tab**, columns A to I, spelled exactly (the code never writes the header; `google:check` fails if it differs):

| A | B | C | D | E | F | G | H | I |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Started at (UTC) | Client | Call ID | Language | Status | Ended reason | Audio (Drive link) | Transcript (Drive link) | Duration (m:ss) |

(Column B, "Client", stays: every row carries the client id.)

### 3. Share the Sheet with the same Google identity used today
Share it, as **Editor**, with the service account's email (the `client_email` inside `GOOGLE_SERVICE_ACCOUNT_JSON_B64`, ends in `@…iam.gserviceaccount.com`) — the same one Sakura's Sheet is shared with. Untick "Notify people".

### 4. Create the two Drive folders — with the command, not by hand
The archive holds only the narrow `drive.file` permission, so it can only see folders **it created itself**. A folder made in the Drive web page is invisible to it, even if shared (every upload would fail with "not found"). Create both with the same OAuth identity used today (credentials from `.env`):

```
npm run google:create-folder -- "<clientId> — call audio"
npm run google:create-folder -- "<clientId> — transcripts"
```

Each prints a **folder id**. Nothing needs sharing: the folders belong to the same Google account (OAuth identity) as Sakura's, and that identity is what uploads. The service account does not touch Drive. You may rename or move the folders afterwards; their ids and the app's access do not change. Do not re-run `google:consent` for this — that re-issues the global refresh token.

### 5. Add the `archive` block to `clients/<clientId>/client.yaml`
Use the three names from the naming section above. Then:

```
npm run config:check
```

### 6. Set the three variables
- **Locally:** add to `.env`:
  ```
  GOOGLE_ARCHIVE_<CLIENT>_SHEET_ID=<spreadsheet id from step 1>
  GOOGLE_ARCHIVE_<CLIENT>_AUDIO_FOLDER_ID=<audio folder id from step 4>
  GOOGLE_ARCHIVE_<CLIENT>_TRANSCRIPT_FOLDER_ID=<transcript folder id from step 4>
  ```
- **On Vercel:** Project → Settings → Environment Variables → add the same three (Production, and Preview if you use it). Variables only take effect on the **next deploy**, so redeploy afterwards.

### 7. Run the check (you run it, against real Google)
```
npm run google:check -- <clientId>      # one client
npm run google:check -- --all           # every client in clients/
```
For each client it verifies: the Sheet is reachable with the expected header row; a test upload (deleted again) works in **both** the audio folder and the transcript folder; the refresh token renews. A client whose variables are unset is reported as a failure with the "archive destination not configured" message, and no Google call is made for it. `--all` additionally fails if two clients resolve to the same Sheet or folder id.

## File names
New Drive files are named `<clientId>-<date>-<time>-<topic>` (clinic local time), e.g. `kanto-city-gas-demo-2026-11-14-1030-reservation.txt`. A same-minute, same-topic collision adds `-2`, `-3`… as before, and the per-client uniqueness index is unchanged. Files already in Drive are **not** renamed, and a job that already reserved a name keeps it.

## Out of scope here
Retention and deletion, moving existing files out of Sakura's folders, and the staff dashboard.
