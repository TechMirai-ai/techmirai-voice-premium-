# Vapi test suite (Evals + chat Simulations)

Automated behaviour tests for the Sakura assistants, run on Vapi against the **real production model**
(unlike the local text tester, which cannot call Gemini). Python, stdlib only.

| File             | Purpose                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `suite_defs.py`  | The scenarios (data): 44 Evals + 6 chat Simulations, with mocks and pinned clocks |
| `build_suite.py` | Creates/adopts the objects in Vapi and writes transient targets (**free**)        |
| `run_suite.py`   | Runs them, records per-run cost, writes `results.json` + `report.md` (**spends**) |
| `vapi.py`        | REST helper; reads `VAPI_API_KEY` from the environment or one line of `.env`      |

## Safety (read before running)

- Targets are **transient copies** of the live assistants with `server`, `hooks` and `serverMessages`
  removed, so no `end-of-call-report` or tool webhook can reach production.
- Every side-effecting tool (`request_callback`, `book_appointment`, `transfer_to_staff`, ...) is mocked:
  Evals take the mock result as a `tool` message; Simulations use scenario `toolMocks`. An unmocked tool
  "runs for real" on Vapi, so add a mock before adding a scenario that can reach a new tool.
- The prompt's `{{"now"}}` is pinned per scenario clock (open / Saturday / 08:30 / 18:55), so hours-dependent
  behaviour is deterministic. `{{priorCall}}` is set to `none`.
- After a run, check that `call_logs`, `callback_requests` and `appointments` did not change.

## How the checks work (verified 2026-11-09)

- Eval tool-call checks must give `arguments` patterns (name-only fails). A text check (`say(...)`) passes
  only when the reply contains **no** tool call, so it also asserts "no tool call this turn".
- The target's own replies, not the mock text, carry the conversation forward. A run stops at its first
  failed checkpoint, so a failure at checkpoint _k_ says nothing about later checkpoints.
- Simulation transcripts hold spoken text only, so tool-call assertions live in Evals.
- AI judges use `gpt-4.1-mini`; treat their verdicts as a second opinion, and read failing transcripts.

## Cost

- Eval runs: about $0.001-0.005 each (`EvalRun.cost`, summed in the report and reconciled against
  Vapi's own run list). Voice Simulations cost about $0.08 per 36 s (both legs bill) and are **not** in this suite.
- Chat Simulations: the API exposes no cost. Read the dashboard balance before and after a batch.

## Usage

```
python3 tools/vapi-test-suite/build_suite.py
python3 tools/vapi-test-suite/run_suite.py --evals --only R01
python3 tools/vapi-test-suite/run_suite.py --evals --skip R01
python3 tools/vapi-test-suite/run_suite.py --sims
python3 tools/vapi-test-suite/run_suite.py --report --results-dir docs/vapi-test-runs/<date>
```

Results are only as good as the sample: scenarios run 5-30 times, so a 100% rate over 5 runs has a 95%
interval of roughly 57-100%. Quote the interval, not the bare rate, in any external claim.
