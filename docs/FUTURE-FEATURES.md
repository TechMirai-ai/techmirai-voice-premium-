# Future features (deliberately postponed)

These were decided and then postponed. Do not build them yet.
For each one, the "Base must allow" list is binding NOW: current code must not make these harder to add later.

---

## F-1 — Admin FAQ editing with automatic sync to Vapi
**What:** Clinic staff edit FAQ entries in the admin screen; saving automatically re-syncs the Vapi assistants.
**Why later:** Extra work; the demo can use the config file.
**Build when:** A real premium client needs to edit their own FAQ.
**Base must allow:**
- FAQ is read only through the `KnowledgeSource` interface (file-based now; a database-backed source later).
- The Vapi sync engine (VP-2) is idempotent and callable as a function from code, not only from the CLI.
- Admin auth (VP-5) supports roles, so a "client editor" role can be added.

## F-2 — Email and LINE notifications for callback requests
**What:** When a caller leaves a callback request, staff are notified by email and/or LINE.
**Why later:** Database storage plus the admin page is enough for v1.
**Build when:** A real client needs push notifications.
**Base must allow:**
- All notifications go through the `CallbackNotifier` interface (VP-4). New channels = new notifier classes, no change to callback logic.
- Saving a callback request must succeed even if a notifier fails. Notification delivery status is tracked separately from the callback row.

## F-3 — Several live clients at once (multi-tenancy)
**What:** Multiple clinics running on the same deployment.
**Why later:** Only one (demo) client exists.
**Build when:** A second real premium client signs up. Decide then: one set of Vapi assistants per client (generated from config — current direction) vs. one shared assistant loading data dynamically.
**Base must allow:**
- `client_id` on every client-owned table row.
- One config folder per client under `clients/`.
- Vapi resource names prefixed with the client id.
- Admin users scoped to a `client_id`.

## F-4 — Real Japanese phone number (telephony)
**What:** Callers dial a real Japanese number instead of using a web call.
**Why later:** Web calls need no phone number; phone setup waits for a paying client.
**Build when:** A paying client needs a dial-in number.
**Notes (re-verify before building):**
- Vapi's free numbers were reported as US-only and not usable for international calls. A Japanese number would need to be imported from a provider such as Twilio, Telnyx or Vonage.
- Twilio has no Japan processing region. If Twilio is chosen, pin the account to the AU1 (Sydney) region, and first re-check whether Twilio can issue and route usable Japanese numbers.
- Also compare NTT Com and KDDI.
**Base must allow:**
- No code assumes calls are web-only.
- Phone numbers stored in a form that can hold E.164 (`+81...`).
- `client.yaml` may later gain a `telephony` section; the schema must tolerate adding it.
- Server URLs come from `PUBLIC_BASE_URL`, never hard-coded.

## F-5 — Automatic language detection
**What:** Detect the caller's language automatically instead of the spoken "English" handoff.
**Why later:** Explicit selection via Squad handoff is more reliable; auto-detection needs testing first.
**Base must allow:** Language selection logic is isolated in the Squad/handoff configuration, not spread through prompts and code.

## F-6 — More languages (beyond Japanese and English)
**What:** Possibly 5–6 languages in total.
**Base must allow:** Languages are a list in `client.yaml`; the schema accepts any BCP-47 code; every script/FAQ entry is validated for every supported language; no language-specific code paths.

## F-7 — Premium tier pricing
**What:** Set the monthly price for this tier.
**Why later:** Needs real per-minute cost measurements from test calls.
**Note:** The earlier architecture notes estimated roughly $0.10–$0.40 per minute all-in and $270–450/month for a busy clinic. These figures are unverified — measure real costs from VP-2+ test calls before pricing.
**Base must allow:** Nothing in code. (Optional later: record call duration per client for cost reporting.)

## F-8 — Deployment target (open decision)
**What:** Where the server runs in production — not decided yet.
**Base must allow:**
- All configuration via environment variables.
- No reliance on local disk for anything that must persist (except local dev).
- The Vapi-facing server must be reachable over public HTTPS; local development uses a tunnel (e.g. ngrok or cloudflared) set in `PUBLIC_BASE_URL`.

---

## Suggested, not yet decided (do not build — raise with the owner)
- **S-1 Retention policy for callback personal data.** Callers' names and phone numbers are personal data under Japan's APPI (Act on the Protection of Personal Information). Decide how long callback rows are kept and how they are deleted.
- **S-2 AI disclosure in the greeting.** Consider saying "AI receptionist" in the greeting so callers know they are talking to an AI.
