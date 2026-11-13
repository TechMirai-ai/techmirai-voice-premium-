# DB audit: schema and client separation

Read-only audit, 2026-11-13, branch `main` (commit `8c499cc`).
Method: static reading of `db/migrations/0001`–`0015`, `src/repositories/*`, `src/routes/*`, `src/google/*`, `src/cli/*`, `scripts/*.sql` and the two `clients/*/client.yaml` files.
No database, Vapi or Telnyx call was made. Nothing was run. **No fixes are proposed.**
Anything I could not confirm from code is marked **UNVERIFIED**.

Japanese terms used: 非通知 (caller ID not notified); 整骨院 (judo-therapy / bone-setting clinic); 関東シティガス (Kanto City Gas); 個人情報保護法 (Personal Information Protection Act, APPI).

---

## 0. Summary

- The schema is tenant-aware by convention only. `client_id` is a free-text column. There is no `clients` table, no foreign key to one, no row-level security, and no composite foreign keys.
- Every repository query that touches a client-owned table filters by `client_id`, with these deliberate exceptions: the archive job runner (`claimRunnable`, `countByState`) and the staff-login lookups by email and by id.
- The real separation weaknesses are outside the queries:
  1. The Google archive (one Sheet, two Drive folders) is shared by all clients.
  2. `reservation_services.id` is a global primary key.
  3. One shared webhook secret authenticates every client, and the client is derived from the assistant name in the request body.
  4. There is no retention or deletion mechanism for any personal data.
- There is no TechMirai-admin role. One staff account belongs to exactly one client.

---

## 1. Tables

Legend: PK = primary key, FK = foreign key, UQ = unique, **C** = client-owned (has `client_id`), **G** = global.
Every `client_id` column is `text NOT NULL` with no FK, no CHECK and no enum.

| Table (migration) | Columns | PK | FK | Indexes / UNIQUE | Scope |
|---|---|---|---|---|---|
| `callback_requests` (0002) | id uuid, client_id, call_id, language, caller_name, caller_phone, reason null, status ('pending'/'handled'), created_at, handled_at null | id | none | idx (client_id, status, created_at DESC). CHECK status↔handled_at consistent. **No UQ on (client_id, call_id)** | C |
| `call_topics` (0003) | id, client_id, call_id, topic (slug CHECK), outcome (3-value CHECK), language, created_at | id | none | UQ (client_id, call_id); idx (client_id, created_at DESC) | C |
| `staff_users` (0004) | id, client_id, email, password_hash, role (default 'admin'), must_change_password, created_at | id | none | **UQ lower(email) (global)**; idx (client_id) | C |
| `session` (0005) | sid, sess json, expire | sid | none | idx (expire) | **G** (no `client_id`) |
| `reservation_services` (0006) | id (text slug), client_id, name_ja, name_en, duration_minutes >0, sort_order, created_at | **id (global)** | none | idx (client_id, sort_order) | C |
| `reservation_demo_patients` (0006) | id, client_id, name, phone, created_at | id | none | UQ (client_id, phone) | C |
| `reservation_booked_slots` (0006) | id, client_id, slot_date text, slot_time text, created_at | id | none | UQ (client_id, slot_date, slot_time) | C |
| `appointments` (0006, 0007, 0008, 0015) | id, client_id, call_id, language, reservation_number, service_id null, service_name null, patient_name null, patient_phone, is_returning_patient, appointment_date text, appointment_time text, created_at, status ('active'/'cancelled'), updated_at. `patient_email` was added then dropped in 0007 | id | service_id → reservation_services(id) (**not client-scoped**) | UQ (client_id, reservation_number); UQ partial (client_id, date, time) WHERE active; idx (client_id, date, time); idx partial (client_id, patient_phone, date, time) WHERE active | C |
| `call_logs` (0009, 0012) | id, client_id, call_id, language, caller_name null, matched_patient_name null, topic null, status (4-value CHECK), summary null, ended_reason null, started_at, ended_at, created_at, caller_phone null | id | none | UQ (client_id, call_id); idx (client_id, created_at DESC); idx (client_id, status, created_at DESC); idx partial (client_id, caller_phone, created_at DESC) WHERE phone not null | C |
| `call_archive_jobs` (0009, 0010, 0011) | id, client_id, call_id, state ('pending'/'done'/'failed'), attempts, drive_url, last_error, created_at, updated_at, sheet_range, text_file_url, file_base_name | id | none | UQ (client_id, call_id); idx (state, created_at); UQ partial (client_id, file_base_name) WHERE not null | C |
| `notification_log` (0013, 0014, 0015) | id, client_id, appointment_id null, channel ('sms'/'line'), status (4-value), recipient_ref null, detail null, provider_message_id null, created_at, event ('booked'/'cancelled'/'rescheduled'), call_id null | id | appointment_id → appointments(id) ON DELETE CASCADE | idx (appointment_id); idx (client_id, channel, status, created_at DESC) | C |
| `appointment_changes` (0015) | id, client_id, appointment_id, call_id, action, old_date, old_time, new_date null, new_time null, created_at | id | appointment_id → appointments(id) | idx (appointment_id, created_at); UQ (client_id, call_id) | C |

`0001_init.sql` only creates the `pgcrypto` extension.
Migration tracking: `src/db/migrate.ts` (not examined in depth). `tests/db/*` pin some columns, for example that `call_topics` and `call_logs` gain no transcript or audio column.

### Tables without `client_id`: should they have one?

| Table | Should it have `client_id`? | Reason |
|---|---|---|
| `session` | No, as it stands | Holds only `staffUserId`, and the client is re-read from `staff_users` on every request (`src/middleware/staffSession.ts`). It is a third-party table (connect-pg-simple). It does contain a staff identifier, and it is the only table that does not name a client. |

All other tables already have it. The gaps are in constraints, not in missing columns (see §4).

---

## 2. Query scoping

Every statement in `src/` that touches a client-owned table, grouped by area. "Scoped" means the WHERE clause or the INSERT values include `client_id`.

### 2a. Dashboard routes (`src/routes/staffDashboard.ts`)

The client always comes from `staffUserFromLocals(res).clientId`, loaded from `staff_users` by session id. It is never a request parameter.

| Route | Repository call | Scoped? |
|---|---|---|
| GET `/staff/calls` | `listByClient(clientId, …)` / `listNeedsCallback(clientId)` | Yes. The lateral join to `callback_requests` also matches `c.client_id = l.client_id` |
| GET `/staff/reservations` | `listReservations(clientId)` | Yes. Joins to `call_logs` and `appointment_changes` go via `client_id` and `appointment_id` |
| POST `/staff/dashboard/callbacks/:id/handled` | `markHandled(id, clientId)` | Yes. `WHERE id = $1 AND client_id = $2`, so a guessed id from another client returns 404 |

### 2b. Tool-call handlers

The client comes from `StateFileAssistantResolver` (assistant name or id → `.vapi-state.<clientId>.json`), never from a model argument.

| Handler / repository method | Table(s) | Filters by client_id? |
|---|---|---|
| `check_availability` → `listTakenTimes` | `reservation_booked_slots`, `appointments` | Yes |
| `book_appointment` → `create` | `appointments` INSERT | Yes (value). Slot and reservation-number UQs include client_id |
| `book_appointment` → `services.listByClient` | `reservation_services` | Yes. See §4 for the global PK problem |
| `cancel` / `reschedule` → `change()` | `appointments` UPDATE, `appointment_changes` INSERT | Yes (`id AND client_id AND patient_phone AND active AND upcoming`) |
| `listUpcomingForPhone`, `findChangeInCall` | `appointments`, `appointment_changes` | Yes. The join is by appointment id, with `a.client_id = $1` |
| `recall_last_visit` → `findLastVisit` | `appointments` | Yes (client + phone) |
| `lookup_patient` → `findByName` | `reservation_demo_patients` | Yes. Name only, no phone (see §3) |
| `request_callback` → `create` | `callback_requests` INSERT | Yes |
| `log_call_topic` → `record` | `call_topics` INSERT | Yes |
| `transfer_to_staff` → `countTransfersSince` | `call_logs` | Yes. The in-memory `TransferLedger` keys by call id only, but `recentCount` filters by client |
| Booking notifier → `reserve` / `settle` / `record` / `countReserved` | `notification_log` | Insert and count are by client. **`settle(id, …)` updates by id only** (the id comes from this process's own `reserve`) |

### 2c. Returning-caller lookup by phone

| Path | Query | Scoped? |
|---|---|---|
| `/talk` bootstrap → `findLatestByPhone(clientId, phone)` | `call_logs WHERE client_id=$1 AND caller_phone=$2` | Yes. `clientId` comes from the URL path `/talk/:clientId/:language` and is validated through `loadClient` |
| Appointment find by phone | `appointments WHERE client_id AND patient_phone` | Yes |

### 2d. Call-log and archive jobs

| Code | Query | Scoped? |
|---|---|---|
| End-of-call report → `callLogs.record` | `call_logs` INSERT ON CONFLICT (client_id, call_id) | Yes |
| `archive.enqueue` / `claimCall(clientId, callId)` | `call_archive_jobs` | Yes |
| **`claimRunnable(limit)`** | `call_archive_jobs WHERE state='pending'…` | **No client filter, by design.** It is one global job queue; the joined `call_logs` row is matched on (client_id, call_id) |
| **`countByState()`** | `SELECT state, count(*) … GROUP BY state` | **No client filter.** Aggregates across all clients; operator-only |
| `recordSheetRow`, `recordDriveLink`, `recordTranscriptLink`, `reserveFileBaseName`, `markDone`, `recordFailure` | `UPDATE … WHERE id = $1` | Keyed by job id obtained from a scoped claim. `reserveFileBaseName` relies on the (client_id, file_base_name) unique index |

### 2e. Other

| Code | Query | Scoped? |
|---|---|---|
| `staffUsers.findByEmail`, `findById` | `staff_users` | **No client filter, by design** (login is global by email) |
| `scripts/clear-demo-calls.sql` | `DELETE FROM call_logs / appointment_changes / appointments / callback_requests` | **Deletes every client's rows.** Manual script; leaves `call_topics`, `call_archive_jobs`, `notification_log` (the last is removed by cascade with appointments) |
| `scripts/remove-follow-up-service.sql` | `reservation_services WHERE id='follow-up'`, `appointments WHERE service_id=…` | **No client filter** (and could not have one, because of the global PK) |
| `seedReservationDemoData` | INSERTs | Writes the target `clientId`. See the `ON CONFLICT (id)` issue in §4 |

**Result: no unscoped read or write of client data was found in request-handling code paths.**
Raw SQL appears only in the repositories. I grepped `src`, `scripts`, `tools` and `api`.

---

## 3. Staff auth

| Question | Finding |
|---|---|
| Are staff tied to one client? | Yes. `staff_users.client_id NOT NULL`, one row per person. `lower(email)` is **globally unique**, so one email address can never belong to two clients |
| How does the dashboard pick the client? | `session.staffUserId` → `PgStaffUserRepository.findById` on every request → `staffUser.clientId` is passed to every repository call. Nothing in the URL, query string or body can choose a client |
| Does the session carry a client? | No. Only the staff id. A changed or deleted account takes effect on the next request |
| TechMirai-admin / cross-client role? | **None.** `role` is a free-text string defaulting to `'admin'` and is not read anywhere in routing or authorization. No route lists clients or all clients' data. An operator today needs a separate `staff_users` row per client, with a different email each time, or direct DB access |
| Account creation | CLI only (`npm run staff:create -- <email> <clientId>`). The CLI **does not check that `clientId` exists** in `clients/` (not seen in the code read), so a typo creates an account for a non-existent client |
| Login hardening | Rate limit, constant-time dummy hash compare, forced password change, session regeneration on login, 8-hour rolling cookie |
| Webhook authentication | A single `WEBHOOK_SECRET` (Bearer) for **all clients and all voice tools**. The client is then derived from `message.assistant.name` or `.id` in the body (`StateFileAssistantResolver`). When only a name is sent, it is accepted if it matches a known `<clientId>--<lang>` name. Anyone who holds the secret can act as any client |
| `lookup_patient` | Matches `reservation_demo_patients` by spoken name within the client only (no phone). It returns the stored full name, which confirms to a caller that a given name is a patient |
| `/talk` public page | Public by design. The caller-typed phone number is used for the returning-caller summary (`findLatestByPhone`) and for the booking and recall tools. Entering someone else's number returns that number's earlier summary within the same client. This is not cross-client |

---

## 4. Uniqueness

| Constraint | Today | Should include `client_id`? | Note |
|---|---|---|---|
| `reservation_services.id` (PRIMARY KEY) | **global** | **Yes**, i.e. PK (client_id, id) | Two clients cannot use the same service slug. `seedReservationDemoData` uses `ON CONFLICT (id) DO NOTHING`, so seeding a second client with an existing slug is **silently skipped**: it reports "services seeded" and inserts nothing. Kanto already works around this by prefixing ids (`kanto-gas-opening`) |
| `appointments.service_id` FK → `reservation_services(id)` | single column | **Yes**, a composite (client_id, service_id) FK would be needed | The DB allows an appointment of client A to point at a service of client B. Code prevents it (`services.listByClient(clientId)` then `.find`) |
| `staff_users` UQ `lower(email)` | global | Arguable | Prevents the same person from having one account per client. A multi-client operator cannot reuse an email |
| `appointments` (client_id, reservation_number) | has it | n/a | Reservation number is `R` + 6 random digits (1M values per client); retry loop on collision |
| `appointments` active-slot UQ (client_id, date, time) | has it | n/a | One booking per clinic per start time. No service or resource dimension |
| `reservation_demo_patients` UQ (client_id, phone) | has it | n/a | Seed lists two "Hanako Sato" rows with the same phone (`08033334444`). The second is dropped by `ON CONFLICT`, though the seed reports 3 patients |
| `call_logs`, `call_topics`, `call_archive_jobs` UQ (client_id, call_id) | has it | n/a | Vapi call ids are globally unique anyway |
| `callback_requests` | **no UQ** on (client_id, call_id) | n/a | A redelivered tool call can create duplicate callbacks. Integrity, not leakage |
| `appointment_changes`, `notification_log` → `appointments(id)` | single-column FK | A composite (client_id, appointment_id) FK would be needed | Rows could in principle carry a `client_id` different from their appointment's. Code always writes the same one |
| Patient names | none | n/a | `findByName` returns undefined if the name matches more than one patient in the client |

---

## 5. Booking shape

### Current tables

- `reservation_services`: a fixed catalogue per client (slug id, `name_ja`, `name_en`, `duration_minutes`, `sort_order`). The two language columns are hard-wired to `ja` and `en`. The code builds `name: { ja, en }` from them (`reservationServiceRepository.ts`), which conflicts with "languages are data" in `CLAUDE.md`.
- `appointments`: one row per booking, with `appointment_date` and `appointment_time` stored as text (`YYYY-MM-DD`, `HH:MM`) in the clinic's local time.

### Columns and logic that assume clinic slot booking

| Item | Assumption |
|---|---|
| `reservation_number` (R + 6 digits) | Generated by us, spoken to the caller |
| `reservation_services` + `service_id` / `service_name` snapshot | Fixed bookable services |
| `appointment_date` / `appointment_time` as exact start strings | One fixed start time, no end time, no timezone column (zone comes from `client.yaml`) |
| `duration_minutes` | Stored but **not used** by `checkAvailability` (no `duration` reference in `availability.ts`). Availability is `clinic hours` minus exact taken start times |
| `reservation_booked_slots` | Fake pre-seeded "taken" times for the demo |
| `appointments_active_slot_idx` | Exactly one live booking per start time per client (capacity = 1, no staff or room dimension) |
| `patient_name`, `patient_phone NOT NULL`, `is_returning_patient` | Person-booking-for-themselves model. Phone is required; the placeholder `000-0000-0000` fills it when there is none |
| `status` | Only 'active' / 'cancelled'. No 'requested', 'confirmed' or 'declined' |
| Reschedule / cancel / recall | Match by caller phone only (not authentication) |

### What a consultation-request flow would need

| Needed | Present today? |
|---|---|
| Company name | No column |
| Contact person name | Partly: `callback_requests.caller_name` or `appointments.patient_name` |
| Topic / inquiry type | `call_topics.topic` is a slug from the client's FAQ ids, not a free request subject; `callback_requests.reason` is free text |
| Preferred times (several, possibly ranges) | No. Appointments hold one exact slot, and a `requested` row would currently *take* a slot through the unique index |
| Request status (new / contacted / scheduled / closed) | `callback_requests.status` is only 'pending' / 'handled' (CHECK). `appointments.status` is 'active' / 'cancelled' (CHECK) |
| Email | Dropped in 0007 (`patient_email`); no current column |
| Free-form per-client fields | **No JSONB or JSON column anywhere** in the application tables. The only `json` column is `session.sess` |

`callback_requests` is the closest existing shape (name, phone, reason, status, client_id). It has no company, no preferred-times field and a 2-value status CHECK.

---

## 6. Adding a client

Based on how the existing two clients (`sakura-seikotsuin`, 整骨院 judo-therapy clinic; `kanto-city-gas-demo`, 関東シティガス Kanto City Gas) are set up.

| # | Item | Where | Notes |
|---|---|---|---|
| 1 | `clients/<clientId>/client.yaml` | repo | Slug pattern enforced. Holds business data, hours + timezone, FAQ, scripts, `reservationFlow` (mode `patient-types` or `simple`; optional `changes`, `recall`), `callback`, `notifications` block (env var *names*), `transfer` block (env var *name*) |
| 2 | Assistants and squad in Vapi | `npm run vapi:sync` | Names prefixed with the client id. Produces `.vapi-state.<clientId>.json` (committed). That file is what the webhook resolver reads |
| 3 | Seed rows | `src/cli/seedReservationDemoData.ts` | **Code change required**: a new entry in the `FIXTURES` map (services, demo patients, fake booked slots). Service ids must be globally unique, so prefix them with the client id. Not needed if the client has no bookable services |
| 4 | Staff accounts | `npm run staff:create -- <email> <clientId>` | One row per person; globally unique email; no validation that the client exists |
| 5 | `.env` entries | env / Vercel | Per-client variables referenced from `client.yaml`: transfer number, LINE recipients, etc. `TELNYX_API_KEY`, the LINE channel token, `WEBHOOK_SECRET` and all `GOOGLE_*` settings are **global** |
| 6 | Google archive | **none available per client** | The same Sheet and both Drive folders are used (documented in `docs/VP19-KANTO-CITY-GAS.md` and F-section of `docs/FUTURE-FEATURES.md`) |
| 7 | Timezone | `client.yaml` (`business.hours.timezone`) | Used by `clinicTimeZoneLookup`, the archive file names and availability |
| 8 | Database migration | not needed | Client-owned tables are keyed by the `client_id` string |

### Would TechMirai's own website agent need a schema change?

- **For a consultation-request flow: yes.**
  - Needed: company, topic, preferred times and a richer status (§5).
  - The existing `appointments` slot logic would be a poor fit: one booking per start time, and `patient_phone NOT NULL`.
  - There is no JSONB column to absorb the per-client fields.
- **For a plain FAQ + callback agent with no bookings: no.** `callback_requests`, `call_logs` and `call_topics` work as they are.
- **Web-call callers will have no phone number.** They would get the placeholder `000-0000-0000` in `callback_requests.caller_phone`, which is `NOT NULL`.
- **Other constraints a new client will hit:**
  - `staff_users` is per client, so there is no cross-client operator account.
  - The shared Google archive would put TechMirai's website calls into the same Sheet and folders as the clinics' calls.

---

## 7. Phone numbers

| Table.column | Format stored | Source |
|---|---|---|
| `call_logs.caller_phone` | Normalised (below); **NULL** if the call carried no usable number | `callerPhoneFromCall` |
| `callback_requests.caller_phone` (NOT NULL) | Normalised, or the literal placeholder `000-0000-0000` | `context.callerPhone ?? DEMO_PLACEHOLDER_PHONE` |
| `appointments.patient_phone` (NOT NULL) | Normalised, or the same placeholder | same |
| `reservation_demo_patients.phone` | National digits as written by the seed | seed |

**Normalisation** (`src/lib/callerPhone.ts`):
- NFKC, full-width digits to ASCII, separators removed.
- `+81…` becomes national form `0…` (`+81 90 1234 5678` → `09012345678`).
- National numbers must match `^0\d{9,10}$`; other international numbers are kept as `+` and 8–15 digits.
- Anything else is rejected (becomes "no number").
- **Stored as text in national format, not E.164.** `toE164(stored, '+81')` converts for dialling.

**Source order** (`callerPhoneFromCall`): `call.customer.number` (network caller ID) first, then the number typed on the `/talk` page (`assistantOverrides.variableValues.callerPhone`).

**When caller ID is withheld (非通知, caller ID not notified):**

- If Vapi sends no `customer.number`, or a non-numeric value such as `anonymous`, `normalizeCallerPhone` returns `undefined`. How Telnyx and Vapi actually present a withheld number is **UNVERIFIED** (no real-call evidence in the repo).
- With no number:

| Flow | Result |
|---|---|
| `call_logs.caller_phone` | NULL |
| `callback_requests.caller_phone` and `appointments.patient_phone` | The placeholder `000-0000-0000` (hyphenated, so it never equals a normalised number) |
| `recall_last_visit` | Says no earlier visit; no DB query |
| Cancel / reschedule | Refused: "no caller phone number" |
| Booking notifications | Caller SMS is skipped (`no_caller_number`); the staff LINE alert still goes |
| Returning-caller greeting | None, because there is no number to look up |

- A callback taken from a withheld-ID call therefore has **no callable number** unless the AI asks for one. The assistants no longer ask for a spoken number (`demoCallerPhone.ts`).
- All withheld-ID bookings share one `patient_phone` string. They cannot be reached through the phone-based tools, and the `/talk` page cannot produce that string.

---

## 8. Personal data and retention

| Table | Personal data fields | Retention / deletion today |
|---|---|---|
| `callback_requests` | caller_name, caller_phone, reason (free text; may include health information) | **None.** Kept forever (stated in `docs/FUTURE-FEATURES.md`, VP-5 decision 1) |
| `call_logs` | caller_name, caller_phone, matched_patient_name, summary (AI text; may quote the others) | **None** |
| `appointments` | patient_name, patient_phone, service (health-related) | **None.** Cancelled rows are kept (soft cancel) |
| `appointment_changes` | none (dates only), but linked to an appointment | None |
| `reservation_demo_patients` | name, phone (fictional demo data) | Seed only; no delete path |
| `reservation_booked_slots`, `reservation_services` | none | n/a |
| `call_topics` | none, by schema test | n/a |
| `notification_log` | none, by design (env-var *names* and reason codes) | Cascade-deleted with its appointment |
| `call_archive_jobs` | links to Drive files; `last_error` (short text) | None |
| `staff_users` | email, password_hash | None (no delete route or CLI) |
| `session` | staff user id in the session JSON | Expired rows are pruned by connect-pg-simple (its default prune interval; not overridden in `src/server.ts` or `api/index.ts`) |

**Only deletion mechanisms found:** the manual `scripts/clear-demo-calls.sql` (all clients, not undoable) and `scripts/remove-follow-up-service.sql`. There is **no per-client or per-person erasure, no scheduled retention job, and no APPI (個人情報保護法, Personal Information Protection Act) request procedure** in code.

### Transcripts and audio: per client?

| Question | Answer |
|---|---|
| Where are they? | Transcripts: `.txt` files in one Drive folder (`GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID`). Audio: files in one Drive folder (`GOOGLE_ARCHIVE_DRIVE_FOLDER_ID`). Index: one Sheet (`GOOGLE_ARCHIVE_SHEET_ID`). All three are global environment variables |
| Separated per client? | **No.** Every client's files go into the same two folders and the same Sheet tab |
| Client identification | The Sheet row has a `client_id` column (column B). **File names carry no client id** (`<date>-<time>-<topic>`, in the clinic's local time). The DB uniqueness for file names is per client, so two clients can produce the same file name in the same folder |
| Neon DB | Holds no transcript or audio. Staff routes cannot read `call_archive_jobs`; the call_logs staff view is an allow-listed column set |
| Staff access to Drive/Sheet | Staff have no access (developer-only account). Access control is therefore by operator discipline, not by client |
| Deletion | No automatic or per-client deletion of Drive files or Sheet rows |

---

## 9. Cross-client leakage risks (ranked)

No fixes are proposed here.

### HIGH

| # | Risk | Evidence | Effect |
|---|---|---|---|
| H1 | Shared Google archive: one Sheet and two Drive folders for all clients; file names have no client id | `src/google/config.ts`; `archive.ts` `buildRow`; `archiveFileName.ts`; `docs/VP19-KANTO-CITY-GAS.md` | All clients' transcripts and recordings sit together. Anyone given access to the archive for one client sees all of them. Per-client export or erasure cannot be done reliably |
| H2 | No retention or erasure mechanism for any personal data, including health-related free text | §8; FUTURE-FEATURES VP-5 decision 1 | Data subject requests (APPI) cannot be met; every client's data accumulates indefinitely. This is a compliance exposure rather than a leak between clients |

### MEDIUM

| # | Risk | Evidence | Effect |
|---|---|---|---|
| M1 | One `WEBHOOK_SECRET` authenticates all clients; the client is taken from the assistant name or id in the request body, and a name alone resolves | `webhookAuth.ts`; `assistantResolver.ts` | Holder of the secret can write to and read (via recall and lookup tools, supplying a caller number in the body) any client's data. Becomes HIGH if any client or third party ever holds Vapi access or the secret |
| M2 | `reservation_services.id` is a global PK; `appointments.service_id` FK is not client-scoped; seed uses `ON CONFLICT (id) DO NOTHING` | `0006`; `seedReservationDemoData.ts` | A second client cannot reuse a slug; seeding silently inserts nothing; the DB would accept a cross-client FK. The app code currently prevents the cross-client link |
| M3 | `scripts/clear-demo-calls.sql` deletes `call_logs`, `appointments`, `callback_requests` for every client, with no client filter | the script | Running it for one client's demo wipes another client's real data |
| M4 | No composite FKs: `appointment_changes` and `notification_log` reference `appointments(id)` without `client_id`; `client_id` columns have no FK or table | `0013`, `0015` | The DB cannot catch a row written with the wrong client id. Today only code discipline prevents it |
| M5 | No TechMirai-admin role and one account per client, with a globally unique email | `staff_users`; `staffSession.ts` | Operators must use per-client logins or direct DB access, which pushes towards shared credentials or ad-hoc queries |

### LOW

| # | Risk | Evidence | Effect |
|---|---|---|---|
| L1 | `archiveJobs.claimRunnable` and `countByState` are global, with no client filter | `archiveJobRepository.ts` | Operator-only (retry secret). The worker handles every client's jobs in one pass |
| L2 | `TransferLedger` is keyed by call id only (client is stored alongside); `notificationLog.settle` updates by id only | `transferLedger.ts`; `notificationLogRepository.ts` | Ids are unique UUIDs generated or issued by Vapi, so collision is not a realistic path |
| L3 | `staff:create` does not validate `clientId` against `clients/` | `createStaffUser.ts` | A typo creates an account that can see nothing, or collides with a future client id |
| L4 | Returning-caller summary and `lookup_patient` can be probed by typing a number or name on the public `/talk` page | `talkPage.ts`; `lookupPatient.ts` | Stays within one client. Not a cross-client leak; a within-client privacy weakness |
| L5 | Global provider credentials (`TELNYX_API_KEY`, LINE channel token, `GOOGLE_*`); only recipients are per client | `client.yaml` notifications block | A shared sending identity and shared quota across clients. Not a data leak |
| L6 | `callback_requests` has no UQ on (client_id, call_id) | `0002` | Duplicate rows on redelivery. Integrity only |

### Confirmed good (no leakage found)

- Every dashboard query and every tool-call query filters by `client_id`.
- Callback mark-handled is guarded by `id AND client_id`.
- Joins between `call_logs`, `callback_requests`, `appointments` and `appointment_changes` carry `client_id`.
- All natural-key unique constraints, except the ones in §4, include `client_id`.
- The client id is never taken from a model-supplied argument.
- Staff session identifies the person, and the client is re-read from the database on each request.
