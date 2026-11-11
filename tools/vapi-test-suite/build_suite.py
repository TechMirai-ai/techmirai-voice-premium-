"""Create the test set in Vapi. FREE: creating Evals / scenarios / simulations costs nothing and nothing is run here.

    python3 tools/vapi-test-suite/build_suite.py

* Targets are TRANSIENT copies of the LIVE assistants (fetched now, so they always match what is deployed) with
  `server` and `hooks` removed and `serverMessages: []`, so no webhook can reach production. The prompt's
  {{"now"}} is pinned per scenario clock and {{priorCall}} -> "none". Written to out/targets/.
* Idempotent: objects are adopted by name ("SUITE <id>"); anything named "SUITE ..." that is no longer in
  suite_defs.py is deleted from Vapi (prune).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import suite_defs as D  # noqa: E402
from vapi import OUT, REPO, list_all, safe_api  # noqa: E402

CLIENT_ID = "sakura-seikotsuin"
NOW_RX = re.compile(r'\{\{"now"\s*\|\s*date:[^}]*\}\}')
STRIP = ["id", "orgId", "createdAt", "updatedAt", "latestVersion", "isServerUrlSecretSet", "server", "hooks"]
SIM_MOCKS = [{"toolName": n, "result": r, "enabled": True} for n, r in [
    ("log_call_topic", "Logged."), ("request_callback", D.CB_OK), ("check_availability", D.AVAIL_OK),
    ("lookup_patient", D.LOOKUP_NONE), ("book_appointment", D.BOOK_OK), ("transfer_to_staff", D.XFER_OK)]]
CALLER_PROMPT = ("You are a patient phoning a Japanese seikotsuin (bone-setting clinic). Speak ONLY in natural, short, %s. "
                 "Follow your scenario; never invent personal data; end the call with the endCall tool when your goal is done.")
PERSONALITIES = {"ja": ("SUITE ja caller", "polite Japanese", "ja", "ja-JP-NanamiNeural"),
                 "en": ("SUITE en caller", "English", "en", "en-US-JennyNeural")}

_assistants = {}


def live_assistant(member):
    if member not in _assistants:
        with open(os.path.join(REPO, ".vapi-state.%s.json" % CLIENT_ID), encoding="utf-8") as handle:
            assistant_id = json.load(handle)["assistants"]["%s--%s" % (CLIENT_ID, member)]
        status, assistant = safe_api("GET", "/assistant/" + assistant_id)
        if status >= 300:
            raise SystemExit("cannot fetch assistant %s: %s %s" % (member, status, assistant))
        _assistants[member] = assistant
    return json.loads(json.dumps(_assistants[member]))  # deep copy


def load_adaptation_splice():
    """The caller-adaptation delta from render_adaptation.ts (only used with --with-adaptation)."""
    path = os.path.join(OUT, "adaptation_splice.json")
    if not os.path.exists(path):
        raise SystemExit("run `npx tsx src/cli/renderAdaptationSplice.ts` first")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def splice_adaptation(text, splice):
    """Apply the delta to a live prompt; fail loudly if the live prompt does not have the anchors."""
    anchors = [r["old"] for r in splice["replacements"]] + [splice["insertBefore"]]
    if any(anchor not in text for anchor in anchors):
        raise SystemExit("live prompt lacks the splice anchors (already synced, or the prompt changed?)")
    for replacement in splice["replacements"]:
        text = text.replace(replacement["old"], replacement["new"], 1)
    return text.replace(splice["insertBefore"], "\n\n" + splice["section"] + splice["insertBefore"], 1)


def make_target(member, clock, splice=None):
    assistant = live_assistant(member)
    for key in STRIP:
        assistant.pop(key, None)
    assistant["serverMessages"] = []
    assistant["name"] = "SUITE-%s-%s" % (member, clock)
    for message in assistant["model"]["messages"]:
        if message.get("role") == "system":
            text = message["content"].replace("{{priorCall}}", "none")
            if splice:
                text = splice_adaptation(text, splice)
            if D.CLOCKS[clock] is not None:
                text = NOW_RX.sub(D.CLOCKS[clock], text)
            message["content"] = text
    assert "server" not in assistant and assistant["serverMessages"] == [] and "hooks" not in assistant
    return assistant


def main():
    os.makedirs(os.path.join(OUT, "targets"), exist_ok=True)
    splice = load_adaptation_splice() if "--with-adaptation" in sys.argv else None
    needed = sorted({(e["member"], e["clock"]) for e in D.EVALS} | {(s[2], s[3]) for s in D.SIMS})
    for member, clock in needed:
        with open(os.path.join(OUT, "targets", "%s-%s.json" % (member, clock)), "w", encoding="utf-8") as handle:
            json.dump(make_target(member, clock, splice), handle, ensure_ascii=False)

    have_eval = {x["name"]: x["id"] for x in list_all("/eval")}
    have_scenario = {x["name"]: x["id"] for x in list_all("/eval/simulation/scenario")}
    have_sim = {x["name"]: x["id"] for x in list_all("/eval/simulation")}
    have_personality = {x["name"]: x["id"] for x in list_all("/eval/simulation/personality") if x.get("orgId")}
    ids = {"evals": {}, "sims": {}, "personalities": {}}

    for e in D.EVALS:
        name = "SUITE " + e["id"]
        # A real call always starts with the assistant's firstMessage; an Eval history without it makes the model greet
        # again on the first turn. A leading assistant message with no judgePlan is accepted and unjudged (probed 2026-11-09).
        greeting = {"role": "assistant", "content": live_assistant(e["member"])["firstMessage"]}
        messages = [greeting] + e["messages"]
        payload = {"description": e["note"] or e["category"], "messages": messages}
        if name in have_eval:  # keep existing objects in sync with suite_defs.py
            status, result = safe_api("PATCH", "/eval/" + have_eval[name], payload)
        else:
            status, result = safe_api("POST", "/eval", {"name": name, "type": "chat.mockConversation", **payload})
            if status < 300:
                have_eval[name] = result["id"]
        if status >= 300:
            print("EVAL FAILED", e["id"], status, str(result)[:300])
            continue
        ids["evals"][e["id"]] = have_eval[name]

    for key, (name, language_text, language_code, voice) in PERSONALITIES.items():
        if name not in have_personality:
            status, result = safe_api("POST", "/eval/simulation/personality", {"name": name, "assistant": {
                "model": {"provider": "openai", "model": "gpt-4.1", "messages": [{"role": "system", "content": CALLER_PROMPT % language_text}],
                          "tools": [{"type": "endCall"}]},
                "firstMessageMode": "assistant-waits-for-user", "maxDurationSeconds": 120,
                "transcriber": {"provider": "deepgram", "model": "nova-3", "language": language_code},
                "voice": {"provider": "azure", "voiceId": voice}}})
            if status >= 300:
                raise SystemExit("personality failed: %s %s" % (status, result))
            have_personality[name] = result["id"]
        ids["personalities"][key] = have_personality[name]

    for sim_id, _cat, _member, _clock, _n, persona, instructions, criteria in D.SIMS:
        name = "SUITE " + sim_id
        evaluations = [{"structuredOutput": {"name": c, "description": d, "schema": {"type": "boolean"}},
                        "comparator": "=", "value": True, "required": True} for c, d in criteria]
        scenario_body = {"instructions": instructions, "evaluations": evaluations, "toolMocks": SIM_MOCKS}
        if name in have_scenario:  # keep existing objects in sync with suite_defs.py
            status, result = safe_api("PATCH", "/eval/simulation/scenario/" + have_scenario[name], scenario_body)
        else:
            status, result = safe_api("POST", "/eval/simulation/scenario", {"name": name, **scenario_body})
            if status < 300:
                have_scenario[name] = result["id"]
        if status >= 300:
            print("SCENARIO FAILED", sim_id, status, str(result)[:300])
            continue
        if name not in have_sim:
            status, result = safe_api("POST", "/eval/simulation", {"name": name, "scenarioId": have_scenario[name],
                                                                   "personalityId": ids["personalities"][persona]})
            if status >= 300:
                print("SIMULATION FAILED", sim_id, status, str(result)[:300])
                continue
            have_sim[name] = result["id"]
        ids["sims"][sim_id] = {"scenario": have_scenario[name], "simulation": have_sim[name]}

    wanted_evals = {"SUITE " + e["id"] for e in D.EVALS}
    wanted_sims = {"SUITE " + s[0] for s in D.SIMS}
    pruned = 0
    for name, object_id in list(have_eval.items()):
        if name.startswith("SUITE ") and name not in wanted_evals:
            pruned += safe_api("DELETE", "/eval/" + object_id)[0] < 300
    for name, object_id in list(have_sim.items()):
        if name.startswith("SUITE ") and name not in wanted_sims:
            pruned += safe_api("DELETE", "/eval/simulation/" + object_id)[0] < 300
    for name, object_id in list(have_scenario.items()):
        if name.startswith("SUITE ") and name not in wanted_sims:
            pruned += safe_api("DELETE", "/eval/simulation/scenario/" + object_id)[0] < 300

    with open(os.path.join(OUT, "suite_ids.json"), "w", encoding="utf-8") as handle:
        json.dump(ids, handle, indent=1)
    by_category = {}
    for e in D.EVALS:
        row = by_category.setdefault(e["category"], [0, 0])
        row[0] += 1
        row[1] += e["n"]
    print("targets: %s" % ", ".join("%s-%s" % t for t in needed))
    print("evals %d/%d | sims %d/%d | pruned %d stale objects" % (len(ids["evals"]), len(D.EVALS), len(ids["sims"]), len(D.SIMS), pruned))
    for category, (scenarios, runs) in by_category.items():
        print("  eval %-12s scenarios %2d  runs %3d" % (category, scenarios, runs))
    print("  sim runs", sum(s[4] for s in D.SIMS))


if __name__ == "__main__":
    main()
