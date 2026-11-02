# Notification facts (Telnyx SMS, LINE push, Vapi caller ID)

Facts the booking-notification code (VP-23, `src/notifications/`) relies on. Same rule as
`VAPI-FACTS.md`: verify against current docs before changing the code, and add what you verify
here with the source and date. **Status** says how each fact was checked — "live" means a real API
call, "docs" means read from the vendor's documentation only.

| # | Fact | Status | Source / date |
|---|------|--------|---------------|
| T1 | Telnyx sends an SMS with `POST https://api.telnyx.com/v2/messages`. Only `to` is strictly required by the schema; for SMS we send `from`, `to`, `text`, `messaging_profile_id`, `type: "SMS"`. Auth is `Authorization: Bearer <API key>`. Success is HTTP 200 `{ data: { id, to: [{ status }] } }`. | docs | developers.telnyx.com/api/messaging/send-message, 2026-11-02 |
| T2 | **`messaging_profile_id` is required when `from` is an alphanumeric sender ID** (or a number pool). That is why it is mandatory per-client config (`notifications.sms.messagingProfileId`). | docs | same page, 2026-11-02 |
| T3 | An optional `Idempotency-Key` header (1–255 letters, digits, hyphens, underscores) makes a retry safe. We send `booking-<appointmentId>-sms`. | docs | same page, 2026-11-02 |
| T4 | Alphanumeric sender IDs: 3–11 characters, ASCII letters/digits/space, not digits only; one-way (recipients cannot reply); **requires the Telnyx account to be verified to Level 2**; for non-US destinations the messaging profile needs a **default alphanumeric sender ID** set. | docs (search summary) | Telnyx "Choosing a Sender Type" + "Sending Alphanumeric SMS" articles, found via search 2026-11-02 — **re-check in the portal before relying on it** |
| T5 | **Japan (MCC 440, +81): alphanumeric sender IDs are supported and need no registration.** SMS containing URLs may be filtered by carriers (one reason confirmations carry no links). | docs (search summary) | support.telnyx.com/en/articles/6674476-japan-sms-guidelines, 2026-11-02. Page is ~1 month old; Telnyx says rules change often. |
| T6 | Telnyx's compliance guide says Japan's rules sit under the Act on Specified Commercial Transactions (特定商取引法) and call for an opt-out link and sender identification **for marketing** messages. Our confirmations are transactional, strictly factual and link-free by design (the template validator rejects URLs); whether a link-free transactional SMS needs any opt-out wording is a legal question this project has not settled. | docs (search summary) | developers.telnyx.com/docs/messaging/messages/international-sms-compliance, 2026-11-02 |
| L1 | LINE push to one recipient is `POST https://api.line.me/v2/bot/message/push` with `Authorization: Bearer <channel access token>` and body `{ to, messages: [{ type: "text", text }] }`. Success: HTTP 200 `{ sentMessages: [{ id }] }`. Not the broadcast endpoint. | **live** (HTTP 200, message received) | real call from this repo's session, 2026-11-02 |
| L2 | A LINE userId is `U` followed by 32 lowercase hex characters (33 characters total). Captured from a webhook `message` event's `source.userId`, signature-verified with `X-Line-Signature` (HMAC-SHA256 of the raw body keyed with the channel secret, base64). | **live** | 2026-11-02 |
| L3 | The LINE channel's webhook URL can be set via `PUT /v2/bot/channel/webhook/endpoint` (200) and tested via `POST /v2/bot/channel/webhook/test`. Real message events are delivered only once **"Use webhook" is switched on** in LINE Official Account Manager; the API reported `active=false` until the owner turned it on. | **live** | 2026-11-02 |
| L4 | `to` may also be a **groupId** (`C` + 32 hex) — the same endpoint — so moving staff to a group is a `.env` change. | docs / prior knowledge — **NOT yet exercised live**. A groupId is only obtainable from a webhook event after the bot is added to the group. | unverified, 2026-11-02 |
| L5 | `X-Line-Retry-Key` (a UUID) makes a push idempotent for 24 hours; we send a fresh UUID per attempt (no automatic retries exist yet). | live for the header being accepted (HTTP 200); the 24-hour idempotency behaviour is from docs | 2026-11-02 |
| V1 | Vapi's call object has an optional `customer` with an optional string `number`, E.164 by default (`numberE164CheckEnabled` true). Documented as relevant to inbound and outbound **phone** calls; **not documented for web calls**. | docs | docs.vapi.ai/api-reference/calls/get, 2026-11-02 |
| V2 | **Not yet confirmed:** that the `call` object inside a `tool-calls` webhook payload carries `customer.number` on a real phone call. The code reads it if present and falls back to the number typed on `/talk`, so nothing breaks if it is absent — but a real phone call is needed to prove it arrives. | unverified | 2026-11-02 |

## Where each is used

- T1–T5: `src/notifications/telnyxSms.ts`, `src/config/notificationsSchema.ts` (sender id pattern).
- T6, link-free rule: `src/config/notificationRules.ts` (placeholders limited to `[[businessName]]`, `[[date]]`, `[[time]]`; URLs rejected).
- L1–L5: `src/notifications/linePush.ts`.
- V1–V2: `callerPhoneFromCall` in `src/vapi/callVariables.ts`.
