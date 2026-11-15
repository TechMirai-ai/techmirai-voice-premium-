# Per-client Google archive — setup for a new client

Every client archives into **its own** Google Sheet and **its own two** Drive folders (audio, transcripts). Nothing is written to a location shared with another client — with one deliberate exception: the **demo clients** (`sakura-seikotsuin` and `kanto-city-gas-demo`) share the existing demo archive (see "Demo clients share one archive" below). **A real client, and TechMirai's own agent, must NOT share: follow the steps below and do NOT set the sharing flag.** The Google *credentials* (service account, OAuth token, retry secret) stay global and are set up once — see `docs/VP12-GOOGLE-SETUP.md`. This page is only about the destination of one more client.

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

### Demo clients share one archive (explicit opt-in)

| Client | Sheet id | Audio folder id | Transcript folder id | `sharedDemoArchive` |
| --- | --- | --- | --- | --- |
| `sakura-seikotsuin` | `GOOGLE_ARCHIVE_SHEET_ID` | `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` | `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` | `true` |
| `kanto-city-gas-demo` | `GOOGLE_ARCHIVE_SHEET_ID` | `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` | `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` | `true` |

`GOOGLE_ARCHIVE_SHEET_ID`, `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID` and `GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID` are the **demo archive**. They keep their original names so nothing already deployed changes, and no code reads them directly: they are looked up through each client's `archive` block.

Sharing is allowed only by an explicit, visible flag in the archive block: `sharedDemoArchive: true`. The rule:
- Two clients may use the same variable name or the same Sheet/folder id **only if both carry `sharedDemoArchive: true`**.
- A flagged client sharing with an unflagged one, or two unflagged clients sharing, is an error (`npm run google:check -- --all` fails; a config test fails).
- Shared rows and files stay attributable: the Sheet's `Client` column holds each row's client id, and every file name starts with the client id.

**A real client, and TechMirai's own agent, must NOT set `sharedDemoArchive`** and must not reuse the three demo variables. They get their own Sheet, their own two folders and their own variables, as below.

### Naming for a new (real) client

Use `GOOGLE_ARCHIVE_<CLIENT>_SHEET_ID`, `GOOGLE_ARCHIVE_<CLIENT>_AUDIO_FOLDER_ID`, `GOOGLE_ARCHIVE_<CLIENT>_TRANSCRIPT_FOLDER_ID` (a short upper-case client name, e.g. `ACME`). Never `GOOGLE_ARCHIVE_SHEET_ID` & co., which are the demo archive.

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
Use the three names from the naming section above, and **do not add `sharedDemoArchive`** (that flag is only for the two demo clients). Then:

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
For each client it verifies: the Sheet is reachable with the expected header row; a test upload (deleted again) works in **both** the audio folder and the transcript folder; the refresh token renews. A client whose variables are unset is reported as a failure with the "archive destination not configured" message, and no Google call is made for it. `--all` additionally fails if two clients use the same variable name or resolve to the same Sheet or folder id, unless **all** of them carry `sharedDemoArchive: true`: then it only prints an info line (`[INFO] shared by demo clients: kanto-city-gas-demo, sakura-seikotsuin (variable names, sheetId, …)`) and checks the shared Sheet and folders once.

## File names
New Drive files are named `<clientId>-<date>-<time>-<topic>` (clinic local time), e.g. `kanto-city-gas-demo-2026-11-14-1030-reservation.txt`. A same-minute, same-topic collision adds `-2`, `-3`… as before, and the per-client uniqueness index is unchanged. Files already in Drive are **not** renamed, and a job that already reserved a name keeps it.

## Out of scope here
Retention and deletion, moving existing files out of Sakura's folders, and the staff dashboard.
