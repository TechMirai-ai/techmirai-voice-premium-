# techmirai-voice-premium

Premium-tier AI voice receptionist for Japanese clinics, built on [Vapi](https://vapi.ai).

This repository started as the foundation (work order VP-1): the client configuration format,
the database and its migrations, and a small Express server. **From VP-2 onwards it talks to a
real Vapi account** — the Japanese assistant for the demo client, a sync engine to build and push
it, and a manual test page.

---

## What lives where

| Path                             | What it is                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `clients/<clientId>/client.yaml` | Everything about one clinic: name, address, opening hours, languages, voices, scripts and FAQ. **All clinic data lives here and nowhere else.** |
| `src/config/`                    | Reads and validates a client config.                                                                                                            |
| `src/knowledge/`                 | The only way the rest of the code may read FAQ content.                                                                                         |
| `src/db/`                        | Connection pool and the migration runner.                                                                                                       |
| `src/vapi/`                      | Prompt builder, payload renderer, sync engine/CLI, and manual test page for Vapi (VP-2).                                                        |
| `.vapi-state.<clientId>.json`    | Committed name→UUID map for one client's Vapi resources — git is the rollback mechanism.                                                        |
| `db/migrations/`                 | Plain `.sql` files, applied in filename order.                                                                                                  |
| `docs/`                          | `FUTURE-FEATURES.md` (what we deliberately postponed) and `VAPI-FACTS.md` (Vapi facts verified against the docs).                               |

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
3. **Dry-run the sync first** — it prints a diff and makes zero API calls:
   ```bash
   npm run vapi:sync -- sakura-seikotsuin --language ja
   ```
4. **Apply it for real** once the diff looks right:
   ```bash
   npm run vapi:sync -- sakura-seikotsuin --language ja --apply
   ```
   This refuses to run if `.vapi-state.sakura-seikotsuin.json` has uncommitted changes (commit it
   after every real sync, so git stays the rollback mechanism).
5. **Generate the test page**, then **open it on the running app** to place a real call by voice
   (with the server running via `npm run dev`, and only outside `NODE_ENV=production`):

   ```bash
   npm run vapi:test-page -- sakura-seikotsuin --language ja   # writes public/vapi-test-call/
   ```

   Then open **`http://127.0.0.1:3000/vapi-test-call/sakura-seikotsuin--ja.html`** and click the
   microphone widget to start a call. **Use `127.0.0.1`, not `localhost`** — the call failed to join
   when the page was opened via `localhost` (see the note below). Since the callback endpoint
   doesn't exist until VP-4, asking something outside the FAQ is expected to end in the assistant
   speaking a graceful failure message, not silence or an error.

   **Re-run `npm run vapi:test-page` after every `vapi:sync --apply`** — the page has the
   assistant id written into it, and the id can change. The generated files hold the (browser-safe)
   public key and the assistant id, so `public/vapi-test-call/` is git-ignored.

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

---

## Everyday commands

| Command                                                       | What it does                                      |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `npm run dev`                                                 | Start the server and reload on changes            |
| `npm test`                                                    | Run all tests once                                |
| `npm run test:coverage`                                       | Run tests and report coverage (must stay at 80%+) |
| `npm run typecheck`                                           | Check the TypeScript types                        |
| `npm run lint`                                                | Check code style and common mistakes              |
| `npm run format`                                              | Reformat the code with Prettier                   |
| `npm run db:migrate`                                          | Apply new database migrations                     |
| `npm run config:check -- <clientId>`                          | Validate one client's config                      |
| `npm run vapi:sync -- <clientId> --language <code> [--apply]` | Dry-run (default) or apply the Vapi sync          |
| `npm run vapi:test-page -- <clientId> --language <code>`      | Regenerate the static test-call page              |
| `npm run vapi:test-page:serve`                                | Serve that page on 127.0.0.1:3001 (plain Node)    |

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
