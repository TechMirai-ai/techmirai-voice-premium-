# Test run 2026-11-09: how to read these results

`report.md` and `results.json` are the final results (Evals + chat Simulations, Sakura assistants, production
model, all side-effecting tools mocked, webhooks stripped). Read this file first: the numbers have a history.

## What happened (so the numbers are not over-trusted)

1. **Round 1 was invalid and is not reported.** It ran 300 Eval runs, and most callback flows scored 0%. The causes
   were my test data, not the model: the "unanswerable question" mentioned Saturday (now a closed day, so the model
   correctly answered instead of starting a callback), handoff tool names were matched exactly, the booking tool's
   argument set was incomplete, and the Eval history had no opening greeting.
2. **Round 2** added the assistant's `firstMessage` to every Eval history (a real call always starts with it) and
   fixed the above. Four scenarios (X03, X05, E06, E08) were then corrected again for test-design reasons and
   re-run; their first-pass results are not in the final numbers.
3. **S04 (booking Simulation)** scored 1/4 on its first pass because an LLM-judged criterion misread the caller-ID
   consent question ("may we contact you on the number you are calling from?") as a request for a phone number.
   No transcript asked for a number or email. The criterion wording was corrected and S04 re-run: 4/4.
4. Judge verdicts can still be wrong. Failing transcripts were read before a failure was called real.

## Cost

- Final results: 305 Eval runs, **$0.4083**.
- Everything the batch submitted (both rounds, reruns): 635 Eval runs, **$0.8705** (Vapi's own run list).
- All Eval runs on the account that day, including pilot and probe runs: 652 runs, $0.9068.
- Chat Simulation cost is not exposed by the API (measure by dashboard balance). 24 + 4 chat runs were made.

## Findings that look real

Per-run replies, tool calls and judge verdicts for every scenario are in `raw/evals/<scenario>.json` and
`raw/sims/<scenario>.json`; `results.json` holds the per-scenario summary and confidence intervals.

| Scenario | Result | What the model does |
| --- | --- | --- |
| R14 / X04 | 0 of 15 | On "connect me to staff" it speaks the whole "connecting you to staff, one moment" line AND calls `transfer_to_staff` in the same turn. The prompt says to add no words because the system announces it, so callers may hear it twice. Needs a listen on a real call. |
| R15 / E09 | 0 of 15 | After saving a callback it never offers the live transfer ("shall I connect you now?"), although staff are reachable. It says "staff will contact you by the next business day" and asks "anything else?". |
| X02 | 0 of 10 | When booking fails with "that time is taken, call `check_availability` again", it does not call the tool and instead invents alternative times (e.g. 14:00, 16:00). |
| E04 | 0 of 5 | After a clear "No, it's fine" to a callback offer, it asks "anything else?" and logs the call topic in the same turn (early, before the caller is finished). The same early-log never happened in the 60 hours-flow runs. |
| E05 | 0 of 5 | An ambiguous "it's fine" is treated as a decline instead of being checked. |
| X05 | 0 of 5 | On the first line of pure static it gives the "line is faint, call again later" goodbye and ends. The prompt reserves that for the third failure. Artificial input. |
| A03 | 0 of 5 | "Are you a human?" is answered honestly ("I am the clinic's AI receptionist") but opens with "yes" (はい), which can be misheard as "yes, I am". Wording only. |
| R13 | 3 of 5 | Returning-patient booking: once skipped the contact-number question, once passed a service id it should not. |

`log_call_topic` timing (the pilot's concern): in 60 runs of the hours-then-goodbye flow (30 without the greeting
in history, 30 with it) the answer turn never carried a tool call and the goodbye produced the silent
`log_call_topic` call every time. The early call is real only in the callback-decline path (E04).

## Limits

Scripted callers, mocked tools and 5 to 30 runs per scenario. A 5/5 has a 95% interval of 57 to 100%. This tests
the model and prompt, not speech recognition, voice quality, latency, barge-in, or the real handoff and transfer
mechanics. Do not quote a bare pass rate externally; quote the interval and these limits.
