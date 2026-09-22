# techmirai-voice-premium

Premium-tier AI voice receptionist for Japanese clinics, built on [Vapi](https://vapi.ai).

This repository started as the foundation (work order VP-1): the client configuration format,
the database and its migrations, and a small Express server. **From VP-2 onwards it talks to a
real Vapi account** — the Japanese assistant for the demo client, a sync engine to build and push
it, and a manual test page.

---

## What lives where

| Path                                                  | What it is                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `clients/<clientId>/client.yaml`                      | Everything about one clinic: name, address, opening hours, languages, voices, scripts and FAQ. **All clinic data lives here and nowhere else.** |
| `src/config/`                                         | Reads and validates a client config.                                                                                                            |
| `src/knowledge/`                                      | The only way the rest of the code may read FAQ content.                                                                                         |
| `src/db/`                                             | Connection pool and the migration runner.                                                                                                       |
| `src/vapi/`                                           | Prompt builder, payload renderer, Squad/handoff, sync engine/CLI, and manual test page for Vapi (VP-2, VP-3).                                   |
| `src/routes/`, `src/middleware/`, `src/repositories/` | The two Vapi webhooks (`callback-request`, `call-topic`), their auth and rate limiting, and the database access behind them (VP-4).             |
| `.vapi-state.<clientId>.json`                         | Committed name→UUID map for one client's Vapi resources — git is the rollback mechanism.                                                        |
| `db/migrations/`                                      | Plain `.sql` files, applied in filename order.                                                                                                  |
| `docs/`                                               | `FUTURE-FEATURES.md` (what we deliberately postponed) and `VAPI-FACTS.md` (Vapi facts verified against the docs).                               |

Adding a clinic means adding a folder under `clients/`. It never means changing code.

---

## Running it locally

### 1. Prerequisites

- **Node.js 22 or newer** — check with `node -v`
- **Docker** with the Compose plugin — check with `docker compose version`

### 2. Start the databases

Two Postgres containers: one for development, one for tests.

```bash
docker compose up -d
```

Check they are running with `docker compose ps`. Stop them later with `docker compose down`
(add `-v` to delete the stored data as well).

### 3. Create your `.env`

```bash
cp .env.example .env
```

The defaults in `.env.example` already match the Compose file, so it works as-is for local
development. `.env` is git-ignored — never commit it, and never put a real secret anywhere else.

### 4. Install the dependencies

```bash
npm install
```

### 5. Create the database tables

```bash
npm run db:migrate
```

Safe to run any time: it applies only the migrations that have not been applied yet.

### 6. Check the demo client config

```bash
npm run config:check -- sakura-seikotsuin
```

This prints `OK` plus a summary, or every problem it found with the exact place in the file,
for example `faq[3].answer.en: missing text for supported language "en"`.

### 7. Start the server

```bash
npm run dev
```

Then, in another terminal:

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

`/healthz` also checks the database, and answers `503` if the database is unreachable.

### 8. Run the tests

```bash
npm test
```

The database tests need `TEST_DATABASE_URL` (it is in `.env.example`). If it is not set, those
tests are skipped instead of failing, so the rest of the suite still runs. `npm test` never talks
to the real Vapi API — all Vapi interaction in tests goes through a mocked client.

### 9. Set up Vapi (from VP-2)

1. **Get your Vapi keys.** Sign in to the [Vapi dashboard](https://dashboard.vapi.ai) and open
   Settings → API Keys. Copy the **Private Key** into `VAPI_API_KEY` and the **Public Key** into
   `VAPI_PUBLIC_KEY` in your `.env`. The private key is server-side only — never expose it to a
   browser or commit it. The public key is safe to expose (it powers the test page below).
2. **Start a tunnel** so Vapi can reach your local server, and put its HTTPS URL in
   `PUBLIC_BASE_URL`:
   ```bash
   ngrok http 3000
   # or: cloudflared tunnel --url http://localhost:3000
   ```
   `PUBLIC_BASE_URL` doesn't need to be reachable for `npm test` or a dry-run sync — only for a
   real manual test call, where the callback tool's webhook will actually hit it.
3. **Dry-run the sync first** — it prints a diff and makes zero API calls. Since VP-3 there are
   three things to sync, in this order: each language, then the **Squad** (which needs every
   assistant's real id, so it refuses until all languages are synced):
   ```bash
   npm run vapi:sync -- sakura-seikotsuin --language ja
   npm run vapi:sync -- sakura-seikotsuin --language en
   npm run vapi:sync -- sakura-seikotsuin --squad
   ```
4. **Apply it for real** once the diffs look right — same three commands with `--apply`:
   ```bash
   npm run vapi:sync -- sakura-seikotsuin --language ja --apply
   npm run vapi:sync -- sakura-seikotsuin --language en --apply
   npm run vapi:sync -- sakura-seikotsuin --squad --apply
   ```
   Each refuses to run if `.vapi-state.sakura-seikotsuin.json` has uncommitted changes (commit it
   after every real sync, so git stays the rollback mechanism).
5. **Generate the test page**, then **open it on the running app** to place a real call by voice
   (with the server running via `npm run dev`, and only outside `NODE_ENV=production`). The page
   now targets the **Squad**, so it exercises the language handoff:

   ```bash
   npm run vapi:test-page -- sakura-seikotsuin                 # the Squad (default) → ...--squad.html
   npm run vapi:test-page -- sakura-seikotsuin --language ja   # one assistant alone (isolation/debugging)
   ```

   Then open **`http://127.0.0.1:3000/vapi-test-call/sakura-seikotsuin--squad.html`** and click the
   microphone widget to start a call. **Use `127.0.0.1`, not `localhost`** — the call failed to join
   when the page was opened via `localhost` (see the note below). Asking something outside the
   FAQ now takes a real callback (VP-4) — it needs the webhook credential from step 10, and the
   server, database and tunnel all running.

   **Two-way handoff test script** (about 2 minutes, ~$0.15 in real cost):
   1. It opens in Japanese, ending "For English, please say English".
   2. Ask a Japanese FAQ question (e.g. 受付時間を教えてください — "please tell me your opening hours").
   3. Say **"English"** → a brief pause, then the English greeting. No "one moment" filler.
   4. Ask an English FAQ question (e.g. "Do I need an appointment?") and check the answer.
   5. Say **"Japanese"** (or 日本語) → the Japanese assistant says 日本語の受付にお繋ぎしました。ご用件をお聞かせください。
      ("Connected to Japanese reception. Please tell me what you need.") — _not_ its original opening greeting.
   6. Hang up. Vapi records this as **one** call with the Squad's id.

   **Re-run `npm run vapi:test-page` after every `vapi:sync --apply` of the squad** — the page has
   the squad id written into it. The generated files hold the (browser-safe) public key and the
   squad/assistant id, so `public/vapi-test-call/` is git-ignored.

   **Why `127.0.0.1`, and why this route sends no CSP.** During VP-2, web calls from this page
   failed to join Vapi's call room (`daily-call-join-error`, ~6.6s) in several configurations. What
   was established: a `Content-Security-Policy` header on the route broke the join (which directive
   was never identified, so the route deliberately sends **no CSP** — it is an internal QA page;
   every other route keeps the full default CSP), and after that the page joined at
   `http://127.0.0.1:3000` but had failed at `http://localhost:3000`. The server returns identical
   responses for both hostnames, so that difference is browser-side; whether it is a hostname
   effect or stale browser cache for the `localhost` origin was not separated. Full write-up and
   everything ruled out: [`docs/VAPI-FACTS.md`](docs/VAPI-FACTS.md), section "KNOWN ISSUE".

   **Secondary fallback: the standalone test-page server.** `npm run vapi:test-page:serve` serves
   the same generated files on `http://127.0.0.1:3001/vapi-test-call/…` from a small plain
   `node:http` server (`src/vapi/serveTestPage.ts`) — no Express, no helmet, no security headers,
   localhost-only, nothing but the generated page files. It was built while the cause was unknown
   and is confirmed to join; keep it for when the main app is not running. A further fallback is
   the test-call feature in Vapi's own dashboard. The page and the server are internal QA tools and
   are never mounted in production.

### 10. Create the webhook credential (from VP-4) — once per environment, **before** `vapi:sync --apply`

Both voice webhooks (`POST /api/voice/callback-request` and `POST /api/voice/call-topic`) reject
every request that does not carry a secret — in development too. Vapi sends that secret from a
**Custom Credential**. **Vapi has no API for creating credentials** (checked against its OpenAPI
spec, 2026-09-21 — see [`docs/VAPI-FACTS.md`](docs/VAPI-FACTS.md) VP-4 R4), so this is a manual,
one-time step in the dashboard:

1. Generate a secret and put it in your `.env` as `VAPI_WEBHOOK_SECRET` (min. 16 characters):
   ```bash
   openssl rand -hex 32
   ```
2. In the [Vapi dashboard](https://dashboard.vapi.ai) open **Integrations → Server Configuration**
   and choose **Add Custom Credential**, then **Bearer Token**.
3. Fill it in:
   - **Credential Name:** anything recognisable, e.g. `techmirai-voice-premium (dev)`.
   - **Token:** the same value as `VAPI_WEBHOOK_SECRET`. Not the `VAPI_API_KEY`.
   - **Header Name:** leave the default, `Authorization`.
   - **Include Bearer Prefix:** leave **on**.
4. Save, then copy the credential's **id** (a UUID) into `.env` as `VAPI_SERVER_CREDENTIAL_ID`.
5. Now run `npm run vapi:sync -- … --apply` (step 9). Sync puts the credential id on both tools as
   `server.credentialId`; each webhook call then arrives with `Authorization: Bearer <secret>`.

If you change the secret, change it in **both** places (`.env` and the dashboard credential) and
restart the server. A mismatch shows up as HTTP 401 in the server log (`webhook rejected: bad or
missing credentials`) and the assistant speaking its "couldn't save" line.

Behind a tunnel (ngrok) or load balancer, set `TRUST_PROXY_HOPS=1` so rate limiting sees the real
caller IP rather than the proxy's.

**How the pieces fit together.** Each assistant has two tools:

| Tool               | Endpoint                           | Table               | Holds personal data?          | Waits for us?                          |
| ------------------ | ---------------------------------- | ------------------- | ----------------------------- | -------------------------------------- |
| `request_callback` | `POST /api/voice/callback-request` | `callback_requests` | Yes (name, phone) — by design | Yes — the assistant speaks the outcome |
| `log_call_topic`   | `POST /api/voice/call-topic`       | `call_topics`       | **Never** (no such column)    | No (`async`) — fired after the goodbye |

- A caller's name and phone are asked for **only** when the question matches no FAQ entry or the
  caller asks for staff. A plain FAQ answer never collects them.
- Neither tool takes a call id, client or language from the model. The server reads them from
  Vapi's webhook (`call.id`, and the assistant → `.vapi-state.<clientId>.json` lookup).
- `call_topics.topic` is a FAQ id or `other` / `unresolved` / `emergency`; one row per call.
- A new notification channel (email, LINE — `docs/FUTURE-FEATURES.md` F-2) is a new class
  implementing `CallbackNotifier` in `src/lib/callbackNotifier.ts`; today only `LoggingNotifier`
  exists. A failing notifier never fails the save.
- Rate limit: 60 requests/minute per IP on both routes, applied before authentication.

Apply the new tables with `npm run db:migrate`.

### 11. Log in to the staff dashboard (from VP-5)

The callback-requests dashboard lives at `/staff/login`, served by the same app and port as
everything else (`http://localhost:3000/staff/login` locally). There is no public signup — every
account is created by hand with the CLI:

```bash
npm run staff:create -- <email> <clientId>
# example:
npm run staff:create -- owner@example.com sakura-seikotsuin
```

This prints a random **temporary password once** — copy it now, it is never shown again and never
stored anywhere except its bcrypt hash. Then:

1. Open `/staff/login` and sign in with that email and temporary password.
2. You are forced straight to `/staff/change-password` — every other page redirects there until
   you set a real password. This is not skippable.
3. Choose a new password (12+ characters) and confirm it. You're now on the dashboard.
4. The dashboard lists callback requests for your account's client, newest first, with a
   **Mark as handled** button on each pending one. There is no un-marking and no editing — it's a
   read/act-on-callbacks screen, not a content editor.

Sessions are stored server-side in Postgres (the `session` table, via `connect-pg-simple`) rather
than as a JWT, and expire after 8 hours of inactivity. Log in attempts are rate-limited far more
strictly than the voice webhooks (a handful of attempts per IP per 15 minutes) since this is a
password-guessing surface.

`reason` — a caller's own words about why they called — may hold health information under Japan's
APPI; see `docs/FUTURE-FEATURES.md` ("VP-5 decisions") for the retention/access decisions around
it, and `src/lib/htmlEscape.ts` for why it's always escaped before reaching a page.

---

## Everyday commands

| Command                                                       | What it does                                       |
| ------------------------------------------------------------- | -------------------------------------------------- |
| `npm run dev`                                                 | Start the server and reload on changes             |
| `npm test`                                                    | Run all tests once                                 |
| `npm run test:coverage`                                       | Run tests and report coverage (must stay at 80%+)  |
| `npm run typecheck`                                           | Check the TypeScript types                         |
| `npm run lint`                                                | Check code style and common mistakes               |
| `npm run format`                                              | Reformat the code with Prettier                    |
| `npm run db:migrate`                                          | Apply new database migrations                      |
| `npm run config:check -- <clientId>`                          | Validate one client's config                       |
| `npm run vapi:sync -- <clientId> --language <code> [--apply]` | Dry-run (default) or apply one language's sync     |
| `npm run vapi:sync -- <clientId> --squad [--apply]`           | Dry-run (default) or apply the Squad sync          |
| `npm run vapi:test-page -- <clientId> [--language <code>]`    | Regenerate the test-call page (Squad by default)   |
| `npm run vapi:test-page:serve`                                | Serve that page on 127.0.0.1:3001 (plain Node)     |
| `npm run staff:create -- <email> <clientId>`                  | Create a staff login with a one-time temp password |

Run `npm test`, `npm run typecheck` and `npm run lint` before opening a pull request.

---

## House rules

These are enforced by review, and several of them by the tests:

- Clinic data belongs in `clients/<clientId>/client.yaml`, never in code.
- Languages are data. Adding a language is a config change, not a code change.
- Secrets live in `.env` only.
- Caller names and phone numbers are never written to a log in plain text — everything goes
  through `src/lib/redact.ts`.

`CLAUDE.md` has the full list, and `docs/FUTURE-FEATURES.md` lists the things we decided _not_
to build yet.
