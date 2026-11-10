# VP-25 — Cancel and reschedule a booking by phone

A caller can cancel or move a booking they made. It is generic (per-client opt-in in `client.yaml`),
reuses the booking notifier for SMS / LINE, and never hard-deletes anything.

**Status:** built and tested (unit, route, real-Postgres and render tests). **Not yet verified on a
real call** — no Vapi or Telnyx credit was used building it. The owner does the real-call check
(checklist at the end).

## How a call goes

1. The caller asks to cancel / change / move an appointment.
2. The assistant calls `find_my_appointments`. The **server** looks up active, upcoming bookings
   under the number the call came from (`call.customer.number`; on the `/talk` demo page, the number
   typed there — same source as every other tool, `callerPhoneFromCall`).
3. **One match** → the assistant reads back date, time and service and waits for a clear yes that it
   is the right one. **Several** → it lists them briefly and asks which. **None, or no number on the
   call** → it says so and offers the existing **callback flow** (and a transfer where the client has
   one); it never dead-ends on "not found".
4. **Cancel:** "shall I cancel it?" → explicit yes → `cancel_appointment`. The booking's `status`
   becomes `cancelled` (row kept) and its slot is free for new bookings immediately.
5. **Reschedule:** ask for the new date/time → `check_availability` (real hours and real taken slots;
   the assistant may only offer what it returns) → read back → explicit yes → `reschedule_appointment`.
   The **same row** is updated (same reservation number) — no duplicate booking is created.
6. Staff get a LINE alert, and the caller an SMS (where the client configured one), through the same
   pipeline as a new booking.

## What the server enforces (the model is not trusted)

| Rule | Where |
|---|---|
| The caller's number comes **only** from the call. No tool takes a phone number or a name, so an argument cannot widen the search. | `src/routes/appointmentChanges.ts` |
| A booking can be changed only if it is the caller's (same `client_id` and number), `active`, and not yet started (clinic-local time). "Not yours", "does not exist", "already cancelled" and "in the past" all get the **same** answer — nothing to probe. | route + repository |
| The demo placeholder number `000-0000-0000` never matches (a call without a number finds nothing). | `callerPhone` is `undefined`, not the placeholder |
| A reschedule runs the same availability check as a booking: closed days, hours outside opening time, off-grid times and taken slots are refused. | route + `checkAvailability` |
| One live booking per slot — enforced by the database (partial unique index), so a lost race is "no longer available", never a double booking. | migration 0015 |
| **One change per call** (owner decision) — enforced by a unique index, so the second change's whole statement rolls back. | migration 0015 |
| The change and its audit row are **one SQL statement**: all or nothing. | `PgAppointmentRepository.change()` |
| A notifier / provider failure never undoes or hides a change. | same policy as bookings (F-2) |
| Logs carry ids only — never names or phone numbers. | `src/lib/redact.ts` rule |

## Config (`clients/<id>/client.yaml`)

```yaml
reservationFlow:
  mode: patient-types          # or simple — both work
  changes:                     # presence = opt-in; absent = client renders byte-identically to before
    scripts:                   # spoken lines, every supported language
      found: …                 # keys: found, askWhich, askNewDateTime, confirmCancel,
                               #       cancelled, rescheduled, notFound, failed
notifications:
  sms:
    changeTemplates: { cancelled: {<lang>: …}, rescheduled: {<lang>: …} }   # optional; same factual rules as the booking SMS
  line:
    changeTemplates: { cancelled: …, rescheduled: … }   # REQUIRED once `changes` is set (staff must be told)
```

Spoken lines may use `[[date]]`, `[[time]]`, `[[service]]`, `[[appointments]]`; the model fills them
from the tool result. The staff LINE templates may also use `[[oldDate]]` / `[[oldTime]]`. The config
check rejects: a client with `changes` but no LINE change templates, a language missing a line, an
unknown placeholder, or a URL in a caller SMS.

**Sakura** is opted in. **Kanto City Gas stays off** (F-11: it still says it cannot change or cancel
and offers a callback).

## Data (migration `0015_appointment_changes.sql`)

- `appointments.status` (`active` | `cancelled`), `updated_at`.
- Unique partial index `appointments_active_slot_idx (client_id, appointment_date, appointment_time) WHERE status = 'active'`.
  **Production was checked before adding it (2026-11-10, read-only): 17 appointments, 0 duplicate
  slots, 0 collisions with the seeded fake slots.**
- `appointment_changes` — one row per cancel/reschedule (call id, action, old and new slot). No
  names or numbers. Unique `(client_id, call_id)` = one change per call.
- `notification_log.event` (`booked` | `cancelled` | `rescheduled`) and `call_id` (the call that
  caused the notification); the one-send-per-call limit is now per call, channel **and event**.
- `appointments` rows are never deleted by code; `appointment_changes` has a foreign key to them.

## Staff view

`/staff/reservations` has a **Status** column: `Booked`, `Cancelled`, or `Rescheduled (was <date>
<time>)`. Cancelled rows stay in the list.

## Known limitations (read before relying on this)

1. **Phone-number matching is not authentication.** Anyone who can present the number a booking was
   made under can change it. Caller ID can in principle be spoofed. This is the same posture as the
   rest of this demo-grade system (the booking SMS, returning-caller context), and no extra
   authentication was added on purpose. Mitigations that do exist: only the caller's own upcoming
   bookings are reachable, one change per call, the daily SMS / LINE caps, and every change alerts
   staff.
2. **On the `/talk` demo page the "caller number" is typed by the caller**, so there it is not even
   caller ID: anyone who knows a number can change that number's bookings. Owner decision
   (2026-11-10): allowed for now because web-call reservations are for Jamal's own testing and will
   be removed once real customers are live. Remove/lock this together with the `/talk` phone field
   (F-4 SV-5 TODO).
3. The "read it back and get a yes" step is enforced by the prompt, not by the server (the server
   cannot hear the caller). Backstops: one change per call, the audit table, and the staff alert.
4. Call status is unchanged (`callStatus.ts` still derives only the four existing values); a
   successful cancel/reschedule does not get its own status (it would need a migration of the
   `call_logs.status` check — a possible future change).
5. The text tester (`vapi:test-chat`) does **not** simulate these tools (no caller number); it
   answers them with an explicit "not simulated" error rather than a false success.
6. The Japanese lines in `client.yaml` need a native-speaker review (English glosses sit above each
   one in the file).
7. **The SMS / LINE daily caps are shared across events.** The per-number SMS cap (default 3 a day)
   and the per-client SMS / LINE caps count bookings, cancellations and reschedules together, so a
   caller (or someone typing a number on `/talk`) who books, moves and cancels can use up that
   number's SMS allowance, and a burst of activity can use up the LINE budget. When a cap is hit the
   change is still saved; only the notification is skipped (`daily_limit` / `rate_limited` in
   `notification_log`, plus one warning log). The staff Status column is the backstop. Raising or
   splitting the budget is a config change (`maxPerDay`) or a later work order.
8. A tool call that is delivered twice (a retry, or the model calling again) repeats the original
   success rather than saying the change failed, and does not alert staff twice.
9. Reschedule reaches at most the caller's next 50 upcoming bookings.
10. `appointments.updated_at` for rows that existed before the migration is the migration time, not
    their creation time (cosmetic).

## Rollout (owner actions — nothing here was run)

1. `npm run db:migrate` against Neon **before** deploying (the new code reads `appointments.status`).
   Run it when the system is idle (it briefly locks `appointments` and `notification_log`), and
   prefer Neon's **direct** (unpooled) connection string for it — the runner takes a session-level
   advisory lock, which a pooled endpoint can mishandle. The migration will fail (and roll back
   cleanly) if any database it runs on has two live bookings for one slot; production had none on
   2026-11-10. To re-check right before running:
   `SELECT client_id, appointment_date, appointment_time, count(*) FROM appointments GROUP BY 1,2,3 HAVING count(*) > 1;`
   Demo reset: `scripts/clear-demo-calls.sql` now also clears `appointment_changes` first.
2. Deploy.
3. `npm run vapi:sync` (dry run first), then `--apply`: creates three new function tools per language
   and re-renders the Sakura assistants (new prompt section). This changes the Vapi account but is not
   a billed action; it is still the owner's call.
4. Real-call check.

## Real-call checklist (for Jamal)

From a phone whose number has a future booking:
1. One booking → it reads back date/time/service, waits for yes, "cancel" → cancelled; the slot can
   be booked again; staff LINE alert and caller SMS arrive; `/staff/reservations` shows `Cancelled`.
2. Two bookings → it lists them briefly and asks which.
3. Reschedule to an open time → moved, same reservation number, no duplicate; alert shows old and new.
4. Reschedule to a taken time / Saturday (closed) → it offers only real alternatives, never invents one.
5. A number with no booking → offers the callback / transfer instead of ending on "not found".
6. Ask for a second change in the same call → refused, callback offered.
7. Say "no" at the confirmation → nothing changes.
8. Same in English.

Sample of the new Japanese lines (each with its meaning): 「ご予約をキャンセルいたしました。」
("Your reservation has been cancelled."), 「変更後のご希望の日時を教えていただけますか？」 ("What new
date and time would you like?").
