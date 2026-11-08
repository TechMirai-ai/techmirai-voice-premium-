# VP-24 — Call transfer to staff

A caller can be connected to a staff phone during clinic hours. Per-client, off unless the client's
`client.yaml` has an enabled `transfer:` block. Vapi facts (with sources and dates) are in
`docs/VAPI-FACTS.md`, rows **VP-24 R1–R7**. R7 describes what ships.

## How it works

1. The model calls our function tool `transfer_to_staff` (no arguments).
2. Vapi POSTs it to `POST /api/voice/transfer-to-staff` on this server.
3. The server runs the **hard gate** (`src/lib/transferGate.ts`). The model cannot override it:
   - clinic open now (`business.hours`, clinic timezone), at least `closingBufferMinutes` before closing, and today not in `transfer.closedDates`;
   - no transfer already started on this call;
   - fewer than `maxPerDay` transfers for this client in the last 24 h (stored calls + this instance's not-yet-reported ones);
   - the staff number, read from the env var named by `transfer.numberEnv`, is E.164 and starts with an allowed country code.
4. Only if all pass, the server sends ONE Live Call Control `transfer` command to the call's own control address, with the client's `transferring` line as the spoken `content`.
5. Anything else — a refusal, a missing number, an unreadable count, a rejected or failed command — is an error result. The prompt then makes the assistant say the "failed" line and take a callback. **The gate fails closed.**

The staff number is **not** in `client.yaml`, git, the Vapi tool, the prompt, the model's tool result or the logs.

## What a caller experiences

| Situation | Clinic open (and ≥10 min before closing) | Clinic closed |
| --- | --- | --- |
| Caller **asks for a person** ("can I speak to a staff member?") | One fixed line is spoken by the platform, then the call is transferred. No confirmation, no name collected. | The assistant says the "closed" line, then the usual callback flow (name → confirm → contact number → saved). Never a transfer. If the model tries anyway, the server refuses and the same callback flow follows. |
| Assistant **can't handle** the request | Callback is taken first and saved. Only then: "shall I try to connect you to staff now?" Transfer happens only on a clear yes; a no ends the offer. | Callback only. A transfer is never mentioned. |
| The server refuses or the transfer command fails | The assistant says the "failed" line and takes a callback if none was saved. | n/a |

**Known gap (accepted 2026-11-08):** on the Telnyx number, if staff don't answer or the transfer
fails after Vapi has accepted it, the caller is probably **dropped** (documented for the native tool;
unverified for Live Call Control, so assume the same). Only the out-of-scope path has a safety net
(the callback saved beforehand).

## Config (`clients/<clientId>/client.yaml`)

```yaml
transfer:
  enabled: true                            # off switch; keep the block, stop offering transfers
  numberEnv: TRANSFER_STAFF_NUMBER_SAKURA  # .env variable holding the staff phone (E.164); must start with TRANSFER_
  allowedCountryCodes: ["+81"]             # default Japan only — the server refuses any other number
  mode: blind-transfer                     # not sent today (VAPI-FACTS VP-24 R7)
  closingBufferMinutes: 10                 # default 10, enforced by the server
  maxPerDay: 10                            # default 20, rolling 24 h, enforced by the server
  closedDates: []                          # "YYYY-MM-DD" days the server refuses (holidays, closures)
  # fallbackPlan:                          # not sent today
  scripts:                                 # every supported language needs every line
    offer: {…}  transferring: {…}  closedOffer: {…}  failed: {…}
```

Clinic hours are **not** repeated here: both the prompt and the gate reuse `business.hours`.
The platform has **no national-holiday calendar**: `closedOnNationalHolidays` only tells the model.
To make the server refuse on holidays, list them in `closedDates` (e.g. `"2026-11-23"`).

## Spoken lines (Sakura)

The Japanese needs a native-speaker review (marked in the yaml too).

| Line | Japanese | English meaning |
| --- | --- | --- |
| `offer` (after a saved callback) | よろしければ、今すぐスタッフにお電話をおつなぎすることもできますが、おつなぎいたしましょうか？ | "If you like, I can also connect you to a staff member by phone right now — shall I connect you?" |
| `transferring` (sent with the transfer) | かしこまりました。スタッフにおつなぎいたします。少々お待ちくださいませ。 | "Certainly. I'll connect you to a staff member. One moment please." |
| `closedOffer` (staff asked for outside hours) | 申し訳ございません。ただいま営業時間外のため、スタッフにお電話をおつなぎすることができません。 | "I'm very sorry. We're currently outside business hours, so I can't connect you to a staff member by phone." |
| `failed` (refused or error) | 申し訳ございません。スタッフにおつなぎすることができませんでした。 | "I'm very sorry. I was unable to connect you to a staff member." |

## What you need to do

1. **Set the staff number** (not in git): `TRANSFER_STAFF_NUMBER_SAKURA=+81…` in your local `.env` **and** in Vercel's environment variables (Production). It must be E.164 and start with `+81`. Unset or malformed = every transfer is refused (callback instead). A Vercel env change needs a redeploy.
2. **Review the Japanese lines** above.
3. **Telnyx:** you confirmed the Outbound Voice Profile (Japan only, $2/day) is attached to the "Vapi" connection. Not re-checked.
4. **Deploy this branch first**, then sync. The new Vapi tool points at `/api/voice/transfer-to-staff`; syncing before the server has it would make the tool fail.
5. **Sync (yours — I did not run it):**
   ```
   npm run vapi:sync -- sakura-seikotsuin --language ja            # dry run first
   npm run vapi:sync -- sakura-seikotsuin --language ja --apply
   npm run vapi:sync -- sakura-seikotsuin --language en --apply
   npm run vapi:sync -- sakura-seikotsuin --language ja-return --apply
   npm run vapi:sync -- sakura-seikotsuin --squad --apply
   ```
   Each member's dry run should show one new line: `transfer: create "sakura-seikotsuin--<member>--transfer-call"`.
   The state file gains three tool ids — commit it before the next sync (existing rule).
   **Sync every member before the squad.** The squad sync does not attach tools; if a member's
   prompt is re-synced without its transfer tool (or the reverse), the model is told to call a
   tool it doesn't have.
6. **Real-call test (billable, yours).** After each call check the Vapi call log (the `transfer_to_staff` tool call and its result), `endedReason`, the Vercel function logs and the Telnyx call record/cost. The server logs `transfer started (outcome unconfirmed)` or `transfer refused` with a `reason` (`closed`, `closing_soon`, `closed_date`, `daily_cap`, `call_already_transferred`, `destination_unavailable`, `disabled`) — never the number.

   | # | Do | Expect |
   | --- | --- | --- |
   | a | Mon–Sat, 09:00–18:49 JST: "can I speak to a staff member" | The fixed line, then the staff phone rings. Log: `transfer started`. Dashboard row: summary starts "Transferred to staff (outcome unconfirmed).", status Unresolved. **This also proves the open questions:** the tool call carried a control address on a phone call, the transfer works on the Telnyx number, and the line is spoken first. Also check the assistant judged the time correctly (Vapi's own resolution of the "Today" line is still unconfirmed on a real call). |
   | b | Same, but staff don't answer | Probably the call ends (known gap). Note what the caller hears and the `endedReason`. |
   | c | Ask something the clinic can't answer | Name → read-back → contact number → callback saved → one offer. "Yes" transfers; "no" does not. A Needs Callback row exists either way. |
   | d | Sunday (or after 19:00): ask for staff | Closed line, then the callback flow. No transfer. If the model did call the tool, the log shows `transfer refused reason=closed` and the callback flow still follows. |
   | e | 18:55 JST: ask for staff | Treated as closed (model) or `reason=closing_soon` (server). No transfer. |
   | f | English leg: switch to English, ask for staff | The English fixed line; the transfer works. |
   | g | Add today's date to `closedDates`, deploy, ask for staff | Refused by the server, callback instead (the one hard-gate check a normal weekday can exercise). Remove it afterwards. |
   | h | Optional cap test: set `maxPerDay: 1` in client.yaml, deploy, do (a) twice | The first transfers; the second is refused (`daily_cap`) and goes to the callback. Note the second may need the first call's report to be stored first — or it is caught by the per-instance memory. Restore `maxPerDay: 10`. |
7. **Roll back:** set `transfer.enabled: false`, deploy, re-sync the three members and the squad. The Vapi `transfer_to_staff` tools stay on Vapi, unreferenced, and in `.vapi-state.*.json`; they hold no number, so deleting them in the dashboard is optional tidying.

## Limitations (documented, not bugs)

- **Dropped caller on a failed Telnyx transfer** — above. Fix: a Vapi number or SIP trunk (and then the native tool's `fallbackPlan`, which needs code to send it).
- **The daily cap is approximate.** Stored transfers (`call_logs.ended_reason = 'assistant-forwarded-call'`) plus this serverless instance's memory of transfers whose report has not arrived yet. Several instances can each miss the others' in-flight transfers for a few minutes. An exact cap needs a table — a migration, which is yours to decide. The Telnyx $2/day limit remains the backstop.
- **Cap details.** The in-memory half remembers a started transfer for 90 minutes (a call only reaches `call_logs` when it ends) and overlaps the stored half afterwards, so for up to 90 minutes a transfer can count twice — this errs on the safe side (earlier refusals). It is also per client. **Unverified:** the stored half assumes a Live Call Control transfer ends with `endedReason: assistant-forwarded-call` (documented for the native tool only). If the first real transfer ends differently, the stored count stays 0 and only the 90-minute in-memory window limits volume — check the real `endedReason` in test (a) and tell me.
- **Once per call is per instance, too.** If a transfer attempt fails or times out and the call stays up, a retry that lands on another serverless instance is not blocked by the memory. The prompt tells the model never to retry.
- **A timeout can still transfer.** The control request has a 5 s limit; Vapi may accept it late, so a caller can hear the "failed" line and still be transferred. It is logged as `timeout (transfer may still happen)`.
- **`mode` and `fallbackPlan` are not sent** (the control command has no `transferPlan`). Setting `fallbackPlan` does not bring a failed caller back.
- **Config check:** overnight opening hours, or a closing buffer as long as a day's opening window, are rejected while the transfer is enabled (the gate could never allow a transfer).
- **National holidays** are refused only if listed in `transfer.closedDates`.
- **No outcome signal.** A transferred call is recorded as "outcome unconfirmed" and shown as *Unresolved*. A dedicated status needs a migration (`call_logs.status` has a CHECK constraint, `db/migrations/0009_call_logs.sql`) — not done; yours to decide.
- A connected transfer after a saved callback leaves a callback request staff should mark handled.
- Telnyx chooses the caller ID staff see.
- **The staff number is still in git history** of this branch (the first two commits, `ca379ce` and `31ebbbe`, contained it before it moved to `.env`). Nothing has been pushed. Squash or rewrite those commits before pushing if that matters; the working tree no longer has it.
- **Model behaviour is untested.** The local text tester is broken for the Gemini model and OpenAI had no credits for the proxy run (VAPI-FACTS VP-24 R6). `docs/vp24-test-runs/transfer-suite.ts.txt` is ready to run when that changes.

## Adding a second client

Add a `transfer:` block (`numberEnv` — a new `TRANSFER_…` variable —, scripts per language) and set that variable. No code change. Also check, because they can contradict the tool: the client's `promptOverrides.identity` and its `staffContactOffer` / `noMatch` scripts (Kanto's currently say it cannot transfer calls). `callback.enabled` must be true (enforced). The client's number must be on a provider/profile that can place outbound calls to the transfer destination.

## Code map

`src/config/transferSchema.ts`, `transferRules.ts`, `envVarName.ts` (config) · `src/lib/transferGate.ts` (the hard gate), `transferLedger.ts` (unreported transfers) · `src/routes/transferToStaff.ts` (the webhook that sends the command) · `src/repositories/callLogRepository.ts` `countTransfersSince` · `src/vapi/transferTool.ts` (tool payload) · `src/vapi/promptExtraSections.ts` `transferSection` (rules the model follows) · `src/vapi/sync.ts` (one tool per language leg, `<clientId>--<member>--transfer-call`) · `src/lib/callStatus.ts`, `src/routes/endOfCallReport.ts` (outcome-unconfirmed recording) · `src/vapi/textTester.ts` (stub).
