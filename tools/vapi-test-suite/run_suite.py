"""Run the test set against Vapi and report. THIS SPENDS MONEY (Evals ~$0.001-0.005 per run; chat Simulations
cost is not exposed by the API: measure it with the dashboard balance before/after).

    python3 tools/vapi-test-suite/build_suite.py                          # free: create/adopt objects + targets
    python3 tools/vapi-test-suite/run_suite.py --evals --only R01         # Evals whose id starts with R01
    python3 tools/vapi-test-suite/run_suite.py --evals --skip R01         # every other Eval
    python3 tools/vapi-test-suite/run_suite.py --sims                     # chat Simulations
    python3 tools/vapi-test-suite/run_suite.py --report --results-dir docs/vapi-test-runs/<date>

Raw per-scenario runs accumulate in out/runs/ (gitignored); --report merges them into results.json + report.md.
Every target is a transient copy with webhooks stripped and all side-effecting tools mocked (see build_suite.py).
"""
import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import suite_defs as D  # noqa: E402
from vapi import OUT, list_all, safe_api  # noqa: E402

WORKERS = 8
POLL_SECONDS = 4
RUN_TIMEOUT_SECONDS = 420
SIM_ITEM_PAGE = 50


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=1)


def wilson(passed, total, z=1.96):
    """95% Wilson score interval for a pass rate."""
    if total == 0:
        return (0.0, 0.0)
    p = passed / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def mark_batch_start():
    path = os.path.join(OUT, "batch_start.txt")
    if not os.path.exists(path):
        os.makedirs(OUT, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(now_iso())


# ---------------------------------------------------------------- Evals
def summarise_eval_run(eval_id, run_id, run):
    results = run.get("results") or []
    ended = run.get("endedReason")
    checkpoints, status = [], "error"
    if results and ended == "mockConversation.done":
        status = results[0]["status"]  # pass | fail
        index = 0
        for message in results[0]["messages"]:
            if message["role"] != "assistant":
                continue
            judge = message.get("judge") or {}
            calls = [{"name": c["function"]["name"], "arguments": c["function"]["arguments"][:200]} for c in (message.get("toolCalls") or [])]
            checkpoints.append({"i": index, "judge": judge.get("status"), "reason": (judge.get("failureReason") or "")[:300],
                                "text": (message.get("content") or "")[:300], "tools": calls})
            index += 1
    return {"evalId": eval_id, "runId": run_id, "status": status, "endedReason": ended, "endedMessage": (run.get("endedMessage") or "")[:200],
            "cost": run.get("cost") or 0, "checkpoints": checkpoints}


def one_eval_run(args):
    eval_id, eval_vapi_id, target = args
    body = {"type": "eval", "evalId": eval_vapi_id, "target": {"type": "assistant", "assistant": target}}
    for attempt in range(6):
        status, result = safe_api("POST", "/eval/run", body)
        if status == 429:  # not created: safe to retry
            time.sleep(5 * (attempt + 1))
            continue
        break
    if status >= 300:
        return {"evalId": eval_id, "runId": None, "status": "error", "endedReason": "submit-failed-%s" % status,
                "endedMessage": str(result)[:200], "cost": 0, "checkpoints": []}
    run_id = result["evalRunId"]
    started = time.time()
    run = {}
    while time.time() - started < RUN_TIMEOUT_SECONDS:
        time.sleep(POLL_SECONDS)
        status, run = safe_api("GET", "/eval/run/" + run_id)
        if status < 300 and isinstance(run, dict) and run.get("status") == "ended":
            return summarise_eval_run(eval_id, run_id, run)
    return {"evalId": eval_id, "runId": run_id, "status": "error", "endedReason": "poll-timeout", "endedMessage": "", "cost": 0, "checkpoints": []}


def run_evals(only, skip):
    ids = read_json(os.path.join(OUT, "suite_ids.json"))
    mark_batch_start()
    selected = [e for e in D.EVALS if (not only or any(e["id"].startswith(p) for p in only)) and not any(e["id"].startswith(p) for p in skip)]
    jobs = []
    for e in selected:
        target = read_json(os.path.join(OUT, "targets", "%s-%s.json" % (e["member"], e["clock"])))
        jobs += [(e["id"], ids["evals"][e["id"]], target)] * e["n"]
    print("%s submitting %d eval runs for %d scenarios (workers=%d)" % (now_iso(), len(jobs), len(selected), WORKERS), flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        records = list(pool.map(one_eval_run, jobs))
    for e in selected:
        runs = [r for r in records if r["evalId"] == e["id"]]
        write_json(os.path.join(OUT, "runs", e["id"] + ".json"), {"id": e["id"], "category": e["category"], "n": e["n"], "finishedAt": now_iso(), "runs": runs})
        passed = sum(r["status"] == "pass" for r in runs)
        errored = sum(r["status"] == "error" for r in runs)
        print("  %-42s pass %2d/%-2d  errors %d  cost $%.4f" % (e["id"], passed, len(runs), errored, sum(r["cost"] for r in runs)), flush=True)
    print("%s done. eval cost recorded: $%.4f" % (now_iso(), sum(r["cost"] for r in records)))


# ------------------------------------------------------------ Simulations
def run_sims(only):
    ids = read_json(os.path.join(OUT, "suite_ids.json"))
    mark_batch_start()
    for sim_id, category, member, clock, iterations, _persona, _instr, criteria in D.SIMS:
        if only and not any(sim_id.startswith(p) for p in only):
            continue
        target = read_json(os.path.join(OUT, "targets", "%s-%s.json" % (member, clock)))
        body = {"simulations": [{"type": "simulation", "simulationId": ids["sims"][sim_id]["simulation"]}],
                "target": {"type": "assistant", "assistant": target}, "transport": {"provider": "vapi.webchat"}, "iterations": iterations}
        status, result = safe_api("POST", "/eval/simulation/run", body, {"Idempotency-Key": "suite-%s-%d" % (sim_id, int(time.time()))})
        if status >= 300:
            print("  %-34s SUBMIT FAILED %s %s" % (sim_id, status, str(result)[:200]))
            write_json(os.path.join(OUT, "sims", sim_id + ".json"), {"id": sim_id, "category": category, "n": iterations, "error": str(result)[:300], "items": []})
            continue
        run_id = result["id"]
        started = time.time()
        run = result
        while time.time() - started < RUN_TIMEOUT_SECONDS:
            time.sleep(POLL_SECONDS * 2)
            status, run = safe_api("GET", "/eval/simulation/run/" + run_id)
            if status < 300 and run.get("status") == "ended":
                break
        status, items = safe_api("GET", "/eval/simulation/run/%s/item?limit=%d" % (run_id, SIM_ITEM_PAGE))
        items = items if isinstance(items, list) else (items or {}).get("results", [])
        compact = []
        for item in items:
            results = item.get("results") or {}
            compact.append({"status": item.get("status"), "passed": results.get("passed"), "failureReason": (item.get("failureReason") or "")[:200],
                            "criteria": [{"name": c.get("name"), "passed": c.get("passed"), "value": c.get("extractedValue")} for c in results.get("evaluations", [])],
                            "transcript": [{"role": m.get("role"), "text": (m.get("message") or "")[:400]} for m in ((item.get("metadata") or {}).get("call") or {}).get("messages", [])]})
        passed = sum(1 for c in compact if c["passed"])
        write_json(os.path.join(OUT, "sims", sim_id + ".json"), {"id": sim_id, "category": category, "n": iterations, "runId": run_id,
                                                                  "endedReason": run.get("endedReason"), "finishedAt": now_iso(), "items": compact})
        print("  %-34s pass %d/%d  (run %s, %s)" % (sim_id, passed, len(compact), run_id[:8], run.get("endedReason")), flush=True)


# ----------------------------------------------------------------- Report
def build_report(results_dir):
    ids = read_json(os.path.join(OUT, "suite_ids.json"))
    start_path = os.path.join(OUT, "batch_start.txt")
    batch_start = open(start_path, encoding="utf-8").read().strip() if os.path.exists(start_path) else None
    scenarios, by_category = [], {}
    for e in D.EVALS:
        path = os.path.join(OUT, "runs", e["id"] + ".json")
        if not os.path.exists(path):
            continue
        data = read_json(path)
        runs = data["runs"]
        n = len(runs)
        passed = sum(r["status"] == "pass" for r in runs)
        errors = sum(r["status"] == "error" for r in runs)
        lo, hi = wilson(passed, n)
        failures = {}
        for r in runs:
            if r["status"] == "fail":
                bad = next((c for c in r["checkpoints"] if c["judge"] == "fail"), None)
                key = "checkpoint %s: %s" % (bad["i"], bad["reason"][:160]) if bad else "failed (no judge detail)"
                failures[key] = failures.get(key, 0) + 1
            elif r["status"] == "error":
                key = "ERROR %s %s" % (r["endedReason"], r["endedMessage"][:80])
                failures[key] = failures.get(key, 0) + 1
        scenarios.append({"layer": "eval", "id": e["id"], "category": e["category"], "n": n, "passed": passed, "errors": errors,
                          "rate": passed / n if n else None, "ci95": [round(lo, 3), round(hi, 3)], "cost": round(sum(r["cost"] for r in runs), 4),
                          "failureReasons": failures, "note": e["note"]})
    for sim_id, category, *_rest in D.SIMS:
        path = os.path.join(OUT, "sims", sim_id + ".json")
        if not os.path.exists(path):
            continue
        data = read_json(path)
        items = data["items"]
        n = len(items)
        passed = sum(1 for c in items if c["passed"])
        lo, hi = wilson(passed, n)
        failing = {}
        for item in items:
            for criterion in item["criteria"]:
                if not criterion["passed"]:
                    failing[criterion["name"]] = failing.get(criterion["name"], 0) + 1
        scenarios.append({"layer": "sim", "id": sim_id, "category": category, "n": n, "passed": passed, "errors": 0 if n else 1,
                          "rate": passed / n if n else None, "ci95": [round(lo, 3), round(hi, 3)], "cost": None,
                          "failureReasons": {"criterion failed: " + k: v for k, v in failing.items()}, "note": data.get("error", "")})
    for row in scenarios:
        agg = by_category.setdefault((row["layer"], row["category"]), {"scenarios": 0, "n": 0, "passed": 0, "errors": 0})
        agg["scenarios"] += 1
        agg["n"] += row["n"]
        agg["passed"] += row["passed"]
        agg["errors"] += row["errors"]

    # Reconcile cost against Vapi's own list (catches orphan/duplicate runs from retried submissions).
    suite_ids = set(ids["evals"].values())
    all_runs = [r for r in list_all("/eval/run") if r.get("evalId") in suite_ids and (not batch_start or r["createdAt"] >= batch_start.replace("+00:00", "Z"))]
    vapi_total = round(sum(r.get("cost") or 0 for r in all_runs), 4)
    recorded = sum(row["n"] for row in scenarios if row["layer"] == "eval")
    recorded_cost = round(sum(row["cost"] or 0 for row in scenarios if row["layer"] == "eval"), 4)
    summary = {"generatedAt": now_iso(), "batchStart": batch_start, "evalRunsRecorded": recorded, "evalRunsInVapiSinceStart": len(all_runs),
               "evalCostRecorded": recorded_cost, "evalCostVapiListTotal": vapi_total,
               "simulationCost": "not exposed by the Vapi API; measure by dashboard balance before/after"}
    write_json(os.path.join(results_dir, "results.json"), {"summary": summary, "scenarios": scenarios,
                                                           "categories": {"%s/%s" % k: v for k, v in by_category.items()}})
    lines = ["# Vapi Evals + chat Simulations: results", "", "Generated %s. Targets: transient copies of the live Sakura assistants, webhooks stripped, "
             "all side-effecting tools mocked. Rates are pass counts with 95%% Wilson intervals." % summary["generatedAt"], "",
             "## By category", "", "| Layer | Category | Scenarios | Runs | Passed | Pass rate (95% CI) | Errors |", "|---|---|---|---|---|---|---|"]
    for (layer, category), agg in sorted(by_category.items()):
        lo, hi = wilson(agg["passed"], agg["n"])
        lines.append("| %s | %s | %d | %d | %d | %.0f%% (%.0f-%.0f%%) | %d |" % (layer, category, agg["scenarios"], agg["n"], agg["passed"],
                                                                              100 * agg["passed"] / max(agg["n"], 1), 100 * lo, 100 * hi, agg["errors"]))
    lines += ["", "## By scenario", "", "| Scenario | Layer | Category | Passed / runs | 95% CI | Cost |", "|---|---|---|---|---|---|"]
    for row in scenarios:
        lines.append("| %s | %s | %s | %d / %d | %.0f-%.0f%% | %s |" % (row["id"], row["layer"], row["category"], row["passed"], row["n"],
                                                                      100 * row["ci95"][0], 100 * row["ci95"][1], "$%.4f" % row["cost"] if row["cost"] is not None else "n/a"))
    lines += ["", "## Failure reasons (judge text, English)", ""]
    for row in scenarios:
        if row["failureReasons"]:
            lines.append("- **%s** (%d/%d failed)" % (row["id"], row["n"] - row["passed"], row["n"]))
            for reason, count in sorted(row["failureReasons"].items(), key=lambda kv: -kv[1]):
                lines.append("  - %dx %s" % (count, reason))
    lines += ["", "## Cost", "", "- Eval runs recorded: %d, cost recorded $%.4f" % (recorded, recorded_cost),
              "- Vapi's own run list since batch start: %d runs, $%.4f (a difference means orphan or duplicate runs)" % (len(all_runs), vapi_total),
              "- Chat Simulations: " + summary["simulationCost"], ""]
    os.makedirs(results_dir, exist_ok=True)
    with open(os.path.join(results_dir, "report.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    print("\n".join(lines[:14 + len(by_category)]))
    print("cost: recorded $%.4f | vapi list $%.4f | runs recorded %d vs vapi %d" % (recorded_cost, vapi_total, recorded, len(all_runs)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evals", action="store_true")
    parser.add_argument("--sims", action="store_true")
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--only", default="", help="comma-separated id prefixes to include")
    parser.add_argument("--skip", default="", help="comma-separated id prefixes to exclude (Evals)")
    parser.add_argument("--results-dir", default="docs/vapi-test-runs/latest")
    args = parser.parse_args()
    only = [p for p in args.only.split(",") if p]
    skip = [p for p in args.skip.split(",") if p]
    if args.evals:
        run_evals(only, skip)
    if args.sims:
        run_sims(only)
    if args.report:
        build_report(args.results_dir)
    if not (args.evals or args.sims or args.report):
        parser.print_help()


if __name__ == "__main__":
    main()
