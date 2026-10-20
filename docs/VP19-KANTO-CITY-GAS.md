# VP-19 — Kanto City Gas demo client

A second, parallel demo client next to `sakura-seikotsuin`: a fictional gas utility's customer line
(「関東シティガス」 — "Kanto City Gas"), run by a fictional BPO ("Mirai Customer Support Services").
Same codebase, database and Vapi account. `client_id = kanto-city-gas-demo`. The BPO story exists only
in the greeting; the system treats this as one ordinary client.

Content source: `gas_utility_bpo_demo_profile.md` (content only, never a feature spec). Everything
policy-like in it is a **demo assumption**, not a real utility rule.

## What it does

| Caller says | Assistant does |
| --- | --- |
| A general question (hours, how gas start/stop works, …) | Answers from the 18 FAQ entries in `client.yaml` |
| "I'm moving in / out" | Books a **real** appointment via the reservation engine: service → date/time → availability check → address (voice only) → name → book |
| Anything about an existing appointment (change/cancel), a bill, payment status/links, registered details, SMS, "connect me to a person" | Says plainly it cannot, offers a **staff callback**, never claims it did the thing |
| Smells gas / suspected leak / hissing | Says the fixed emergency wording, asks the name, records a callback flagged `SAFETY: caller reported possible gas smell/leak`, ends. **Nothing is paged or dispatched.** |
| Asks for English / Japanese | Squad handoff `ja → en → ja-return`, same structure as sakura |
| Goes silent | The existing VP-16 mechanism, unchanged (only the closing line's wording differs) |

## How it is built (the shared-code change)

The shared prompt template was written for a clinic, so adding this client needed a small additive
refactor. Three **optional** `client.yaml` sections, each of which leaves a client that omits it
byte-for-byte unchanged (guarded by `tests/vapi/sakuraGolden.test.ts`, captured before the change):

- `promptOverrides` — replaces the few pieces of clinic-flavoured prose (identity, sympathy line,
  off-topic line, "visiting or booking" line) and sets the business noun ("company" vs "clinic").
- `reservationFlow` — `mode: simple` skips first-time-vs-returning and the patient lookup; optionally
  asks a service-address question (`askServiceAddress`).
- `emergency` — label, trigger phrases, the fixed wording per language, and the exact callback reason.

Code: `src/vapi/promptShared.ts` (helpers moved out of `promptTemplate.ts`), `src/vapi/promptExtraSections.ts`
(emergency + simple booking sections), plus small conditionals in `render.ts`, `callReporting.ts`,
`routes/checkAvailability.ts`. The VP-16 silence and VP-17 conversational-quality rules are
not copied anywhere — this client uses the same functions (`styleSection`, `leadingSection`,
`silenceHooks`).

## Where things live

- Config and content: `clients/kanto-city-gas-demo/client.yaml`
- Bookable services (DB, client-prefixed ids): `kanto-gas-opening`, `kanto-gas-closing` — seeded by
  `npm run demo:seed -- kanto-city-gas-demo`
- Vapi resources (prefix `kanto-city-gas-demo--`): assistants `ja`, `en`, `ja-return`; squad; call-outcome
  structured output; tools per language. IDs in `.vapi-state.kanto-city-gas-demo.json`.
- Staff login: `jamalgit1993+kanto@gmail.com` (client `kanto-city-gas-demo`). Temporary password was
  shown once at creation; the first login forces a new one. Re-create with
  `npm run staff:create -- <email> kanto-city-gas-demo` if lost (needs a different email: emails are unique
  across clients).

## Current deployment state — read before demoing

The Kanto assistants' tool webhooks currently point at the **local dev server through the ngrok
domain** (`corporate-starry-heftiness.ngrok-free.dev`), because the Vercel deployment cannot serve this
client until this branch is merged (it resolves assistants from `clients/**` and `.vapi-state.*.json`,
which only exist on the branch). To make it permanent:

1. Merge the VP-19 PR to `main` and let Vercel deploy.
2. Re-sync every member to the Vercel URL (default `PUBLIC_BASE_URL`), committing the state file between
   syncs as the sync engine requires:
   `npm run vapi:sync -- kanto-city-gas-demo --language ja --apply`, then `en`, `ja-return`, then `--squad`.
3. Until step 2, calls to the Kanto assistants only work while the local server and tunnel are running
   (`npx tsx src/server.ts` with `TRUST_PROXY_HOPS=1`, and
   `ngrok http 3000 --url https://corporate-starry-heftiness.ngrok-free.dev`).

## Real-call test checklist (needs a person with a microphone)

Chat-based testing is not possible: Vapi's `/chat` returns 402 until a payment method is added to the
org (VAPI-FACTS.md). Start each call from a browser. Language pages start one assistant:
`/talk/kanto-city-gas-demo/ja` and `/talk/kanto-city-gas-demo/en` (add `?key=<TALK_BYPASS_KEY>` to skip the
per-visitor call limit). The **squad** (needed for the handoff test) starts from the generated test page:
`npm run vapi:test-page -- kanto-city-gas-demo`, then `npm run vapi:test-page:serve`.

| # | Language | Say | Expect |
| --- | --- | --- | --- |
| 1 | ja | 受付時間を教えてください。 ("What are your hours?") | Mon–Fri 9–18, Sat 9–17, closed Sun/holidays |
| 2 | ja | 引っ越しでガスの開栓を予約したいのですが。 ("I want to book a gas opening for my move.") | Asks for a date/time, checks availability, asks the address, then name → confirms → contact-number question → books; states the confirmed date/time |
| 3 | ja | ガスのにおいがします。 ("I smell gas.") — also try mid-booking | Says the emergency line word for word, asks for the name, saves the callback, ends. No instructions, no claim anyone was alerted |
| 4 | ja | 先月のガス料金はいくらですか？ ("How much was last month's bill?") | Says it cannot look up bills, offers a callback; does not invent an amount |
| 5 | ja | 予約をキャンセルしたいです。 ("I want to cancel my appointment.") | Says it cannot, offers a callback, does not say it was cancelled |
| 6 | ja→en→ja | 「English」, then 「日本語」 ("Japanese") | Hands off both ways, gives the correct greetings (squad test page) |
| 7 | ja | Stay silent after the greeting | VP-16 checks, then the ending line, then hang-up |
| 8 | en | "What are your hours?" / "I'm moving in next week and need the gas turned on." / "I smell gas." / "What's my balance?" | Same behaviour as 1–4 in English |

After each call, check the dashboard as the Kanto staff user: calls appear under this client only; a
completed booking shows as `reservation_made` with the address in its summary; the gas-smell call shows
as `needs_callback` with a summary beginning `SAFETY: caller reported possible gas smell/leak`.
**Report the model's actual wording for the address in the booking summary** — that depends on the
call-outcome extraction following its instruction and has not been seen on a live call.

## Known limitations and production blockers

- **Gas-smell handling is a script, not a safety system** (decision 3). The wording is the source
  document's placeholder; the caller is given no instructions; there is no escalation. A real utility must
  supply and approve all of it before any live use. See FUTURE-FEATURES F-11.
- Change/cancel, billing/account, SMS, transfer: not built (decision 5) — callback fallback only.
- The address has no column; it reaches staff only through the AI call summary (decision made in VP-19).
- Booking slots are generated from the business hours, not real capacity; two callers can book the same
  slot in a race (unchanged VP-8 behaviour). Booking is not tied to any real gas-company system.
- The Google archive is shared with sakura (VP-18); Kanto calls are archived into the same sheet and folders.
- Not re-verified on a live call: Vapi's server-side resolution of the "today" placeholder, and every
  behaviour in the checklist above.
