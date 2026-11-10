# VP-26 — CRM recall: acknowledging a returning caller's last visit

A caller whose phone number has an earlier visit on record is greeted with a short acknowledgement:
**when** it was and **what** it was for. Nothing else. A client that has not opted in behaves exactly
as before.

> "Our records show a booking on March 3rd for General Consultation."
> (no service on record: "Our records show a booking on March 3rd.")

The line says "a booking", not "a visit", on purpose (owner decision, 2026-11-10): there is no
attendance record, so the assistant never implies the caller actually came.

## Scope (owner decisions, 2026-11-10)

| Decision | Choice |
|---|---|
| What is said | The visit's **date** and **service name** only. Never the time of day, the caller's name, the reservation number, or anything about what was done or their condition. Nothing from call summaries. |
| Wording | As drafted, with a no-service variant. The Japanese lines **need native-speaker review before go-live** (glosses are in `clients/sakura-seikotsuin/client.yaml`). |
| How far back | 365 days (`maxAgeDays`, per client). An older visit is not mentioned. |
| `/talk` | Allowed, same posture as VP-25 (testing era; typed numbers). Remove together with the `/talk` phone field. |
| VP-15 (prior-call continuity) | Untouched. At most **one** earlier-contact line per call; the visit acknowledgement takes priority. |

## How it works

- **No new table.** It reads `appointments` (the bookings made through this system). New repository
  method: `findLastVisit(clientId, phone, now, oldestDate)` — the latest `active` booking whose time
  has passed and that is no older than the cutoff. It is served by the existing
  `appointments_active_phone_idx`, so there is **no migration**.
- **One function tool, `recall_last_visit`** (`src/routes/recallLastVisit.ts`), which takes **no
  arguments**. The number comes from the call itself (`callerPhoneFromCall`: Vapi caller ID, else the
  number typed on `/talk`), so nothing the model says can reach another caller's history.
- **Server-side, not in `variableValues`.** Unlike VP-15, nothing is handed to the browser, so the
  `/talk` response cannot be used to read someone's visit without placing a call.
- **The model is told on its first reply** (after the caller says what they need) to call the tool
  once and say the client's own line if a visit comes back. The tool answers the same way for "no
  number", "no visit", "too old" and "lookup failed" (a database error is logged and treated as no
  visit), so a caller is never told they have a history they do not have.
- **Opt-in** is the presence of `reservationFlow.recall` in `client.yaml` (Sakura has it; Kanto does
  not). The tool and the prompt section are rendered only then, and only if the client has bookable
  services.
- The service is shown in the **call's language** (looked up from the service catalogue by its id); if
  the id is no longer in the catalogue, the text stored at booking time is used; a returning-patient
  booking records no service, so only the date is said.

## Known limitations (read before relying on this)

1. **Phone-number matching is not authentication.** Caller ID can in principle be spoofed, and on
   `/talk` the number is typed. Anyone who can present a number can hear that number's **last visit
   date and service**. That is the whole exposure — by design it is small — and it is accepted on the
   same basis as VP-25 (`docs/VP25-APPOINTMENT-CHANGES.md`). Real caller verification stays
   postponed.
2. **A booking is not proof of attendance.** There is no attendance record, so a booking the caller
   did not turn up for looks like a visit. "Last visit" means "the latest booking whose time has
   passed".
3. **Only bookings made through this system exist.** A clinic's history from before the assistant is
   not here; importing it is the postponed CRM integration (`docs/FUTURE-FEATURES.md`).
4. **Prompt-enforced, not server-enforced:** *when* the model calls the tool, that it says only the
   date and service, and the "one earlier-contact line" rule. What the server enforces: whose rows may
   be read, the age cap, and that the result carries only a date and a service.
5. The first reply takes slightly longer for an opted-in client (one extra, quick lookup).
   (If the catalogue has no name for the call's language, the text stored at booking time is used —
   it may be in another language; the assistant is told to speak in the call's language. Service
   text is collapsed to one line and capped at 100 characters before the model sees it.)
6. **Shared numbers need no attacker.** Matching is by number only, so a household or shared line,
   or a booking made for a relative from the caller's own phone, returns that visit's date and
   service to whoever calls from that number.
7. **A spoken recall is retained like any other call content.** The sentence the assistant says, and
   the tool result, appear in Vapi's transcript and end-of-call report, and from there in the call
   log, the Google archive and the staff dashboard. A later call's VP-15 prior-call summary may
   repeat it. The server never supplies more than the date and service, so this stays inside the
   approved scope, but it is a retention point to remember when setting retention rules.

## Privacy and logging

The route logs only `clientId`, `callId` and `found` (true/false) — never the number, the date or the
service. The result text never contains the time, name, reservation number or phone number (tested).

## Unverified until a real call

- That a tool with **no** `messages` is silent (no spoken "please wait"). The Vapi docs describe
  messages as what is spoken during a tool call and show a tool with none as `"messages": []`, but this
  has not been confirmed on a call (`docs/VAPI-FACTS.md`).
- That the model calls the tool on its first reply, uses the right line, and stays within date + service.
- Japanese naturalness of the two lines.

## Rollout (all yours — nothing here ran against Vapi, Telnyx, OpenAI or LINE)

1. Merge and deploy (no `db:migrate` needed).
2. `npm run vapi:sync -- sakura-seikotsuin --language ja|ja-return|en` as a **dry run**, then
   `--apply` (creates one tool per language; then the squad as usual).
3. A real visit needs a **past** booking. Bookings are made for future dates, so for a test either
   wait, or move a test booking into the past yourself, e.g.
   `UPDATE appointments SET appointment_date = '<a past date>' WHERE reservation_number = '<yours>';`
   (use your own test row).

## Real-call checklist

- [ ] A number with a past booking → "welcome back" with the date and service, **no time**.
- [ ] A number with no booking → nothing about history; the normal flow.
- [ ] A number whose only bookings are upcoming or cancelled → nothing about history.
- [ ] A returning-patient booking (no service) → the date only.
- [ ] Ask "what did I have done?" → the assistant declines details and offers a callback.
- [ ] English line → English service name; Japanese line → Japanese.
- [ ] A caller who also has a VP-15 earlier call → only one earlier-contact line is spoken.
- [ ] No spoken "please wait" before the lookup.
- [ ] `/talk` with a typed number behaves the same.

## Tests

`tests/db/lastVisit.test.ts` (real Postgres), `tests/routes/recallLastVisit.test.ts`,
`tests/config/recall.test.ts`, `tests/vapi/recallRender.test.ts`, `tests/lib/clinicTime.test.ts`
(`daysBefore`); `tests/vapi/sakuraGolden.test.ts` proves a client without the opt-in renders
byte-identically.
