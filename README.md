# techmirai-voice-premium

Premium-tier AI voice receptionist for Japanese clinics, built on [Vapi](https://vapi.ai).

This repository is the foundation (work order VP-1): the client configuration format,
the database and its migrations, and a small Express server. **It does not talk to Vapi
yet** — that starts in VP-2.

---

## What lives where

| Path                             | What it is                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `clients/<clientId>/client.yaml` | Everything about one clinic: name, address, opening hours, languages, voices, scripts and FAQ. **All clinic data lives here and nowhere else.** |
| `src/config/`                    | Reads and validates a client config.                                                                                                            |
| `src/knowledge/`                 | The only way the rest of the code may read FAQ content.                                                                                         |
| `src/db/`                        | Connection pool and the migration runner.                                                                                                       |
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
tests are skipped instead of failing, so the rest of the suite still runs.

---

## Everyday commands

| Command                              | What it does                                      |
| ------------------------------------ | ------------------------------------------------- |
| `npm run dev`                        | Start the server and reload on changes            |
| `npm test`                           | Run all tests once                                |
| `npm run test:coverage`              | Run tests and report coverage (must stay at 80%+) |
| `npm run typecheck`                  | Check the TypeScript types                        |
| `npm run lint`                       | Check code style and common mistakes              |
| `npm run format`                     | Reformat the code with Prettier                   |
| `npm run db:migrate`                 | Apply new database migrations                     |
| `npm run config:check -- <clientId>` | Validate one client's config                      |

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
