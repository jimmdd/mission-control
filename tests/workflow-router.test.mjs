import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys, json, tempfile
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(SWARM)})
${code}
`], { encoding: "utf8" }));
}

// A Jev response in the API's shape, for stubbing the network call.
const jevResponse = (ui, scope, money) => ({
  model: "jev-test",
  answers: { ui_only: { noul: ui }, scope: { score: scope, confidence: 0.8 }, money_or_chain: { noul: money } },
});

// Jev's answers on real past tickets (backtest 2026-09-22), and what their merged PRs
// turned out to be. The policy must reproduce the calls the backtest was fitted on.
const BACKTEST = {
  "MET-661 footer weight, 2 lines": { ui_only: 0.83, scope: 0.64, money_or_chain: 0.02 },
  "MET-667 breadcrumb color, 8 lines": { ui_only: 0.97, scope: 0.57, money_or_chain: 0.02 },
  "MET-726 founders game, 7067 lines": { ui_only: 0.35, scope: 2.92, money_or_chain: 0.15 },
  "MET-650 homepage, 1793 lines UI-only": { ui_only: 0.86, scope: 1.94, money_or_chain: 0.03 },
  "MET-591 connect w/o signing": { ui_only: 0.83, scope: 1.52, money_or_chain: 0.89 },
  "MET-606 backoffice migration": { ui_only: 0.03, scope: 1.72, money_or_chain: 0.03 },
};

test("the policy reproduces the backtest's calls on real tickets", () => {
  const r = python(`
import workflow_router as w
cases = json.loads(${JSON.stringify(JSON.stringify(BACKTEST))})
print(json.dumps({k: w.decide(v) for k, v in cases.items()}))
`);
  assert.deepEqual(r["MET-661 footer weight, 2 lines"],
    { verdict: "light", why: ["UI-only 83%", "size 0.6/3", "funds/chain/auth 2%"] });
  assert.equal(r["MET-667 breadcrumb color, 8 lines"].verdict, "light");
  // UI-only is not enough on its own: MET-650 was frontend-only and 1.8k lines.
  assert.deepEqual(r["MET-650 homepage, 1793 lines UI-only"],
    { verdict: "full", why: ["size 1.9/3 is above 1.2"] });
  assert.deepEqual(r["MET-726 founders game, 7067 lines"].why,
    ["may need more than frontend changes (UI-only 35% ≤ 70%)", "size 2.9/3 is above 1.2"]);
  assert.equal(r["MET-726 founders game, 7067 lines"].verdict, "full");
  assert.deepEqual(r["MET-591 connect w/o signing"],
    { verdict: "full", why: ["size 1.5/3 is above 1.2", "may change funds, chain or auth behaviour (89%)"] });
  assert.equal(r["MET-606 backoffice migration"].verdict, "full");
});

test("each threshold is exclusive on the risky side, and thresholds can be overridden", () => {
  const r = python(`
import workflow_router as w
ok = {"ui_only": 0.9, "scope": 0.5, "money_or_chain": 0.0}
print(json.dumps({
  "ui_at_min": w.decide({**ok, "ui_only": 0.7})["verdict"],
  "ui_above": w.decide({**ok, "ui_only": 0.701})["verdict"],
  "scope_at_max": w.decide({**ok, "scope": 1.2})["verdict"],
  "scope_above": w.decide({**ok, "scope": 1.201})["verdict"],
  "money_at_max": w.decide({**ok, "money_or_chain": 0.3})["verdict"],
  "money_below": w.decide({**ok, "money_or_chain": 0.299})["verdict"],
  "custom": w.decide(ok, thresholds={"scope_max": 0.4})["verdict"],
}))
`);
  assert.deepEqual(r, {
    ui_at_min: "full", ui_above: "light",
    scope_at_max: "light", scope_above: "full",
    money_at_max: "full", money_below: "light",
    custom: "full",
  });
});

test("Jev reads the ticket title and context, capped at 8000 characters", () => {
  const r = python(`
import workflow_router as w
print(json.dumps([w.ticket_state({"title": "Fix footer", "description": "Weight 500"}),
                  len(w.ticket_state({"title": "t", "description": "x" * 20000})["ticket"])]))
`);
  assert.deepEqual(r[0], { ticket: "# Task: Fix footer\n\n## Context\nWeight 500" });
  assert.equal(r[1], 8000);
});

test("shadow appends one record per call with the verdict, numbers and thresholds", () => {
  const r = python(`
import workflow_router as w
log = Path(tempfile.mkdtemp()) / "nested" / "shadow.jsonl"
resp = json.loads(${JSON.stringify(JSON.stringify(jevResponse(0.83, 0.64, 0.02)))})
seen = []
rec = w.shadow({"id": "t1", "title": "Footer weight"}, "k", log, ref="MET-661",
               ask=lambda task, key: seen.append([task["id"], key]) or resp)
print(json.dumps({"rec": rec, "lines": [json.loads(l) for l in log.read_text().splitlines()], "seen": seen}))
`);
  assert.deepEqual(r.seen, [["t1", "k"]]);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0], r.rec);
  const { at, ...rest } = r.rec;
  assert.match(at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(rest, {
    task_id: "t1", ref: "MET-661", title: "Footer weight",
    thresholds: { ui_only_min: 0.7, scope_max: 1.2, money_max: 0.3 },
    jev: { model: "jev-test", ui_only: 0.83, scope: 0.64, scope_confidence: 0.8, money_or_chain: 0.02 },
    verdict: "light", why: ["UI-only 83%", "size 0.6/3", "funds/chain/auth 2%"],
  });
});

test("a failed or malformed Jev call is recorded as an error, never as a verdict", () => {
  const r = python(`
import urllib.error, workflow_router as w
log = Path(tempfile.mkdtemp()) / "shadow.jsonl"
def http_500(task, key): raise urllib.error.HTTPError("u", 500, "boom", {}, None)
a = w.shadow({"id": "t1"}, "k", log, ask=http_500)
b = w.shadow({"id": "t1"}, "k", log, ask=lambda t, k: {"answers": {}})
print(json.dumps([a, b]))
`);
  assert.equal(r[0].error, "HTTPError 500");
  assert.equal(r[1].error, "KeyError");
  for (const rec of r) {
    assert.equal(rec.verdict, undefined);
    assert.equal(rec.jev, undefined);
  }
});

test("a ticket is asked once after a verdict, and at most three times while failing", () => {
  const r = python(`
import workflow_router as w
log = Path(tempfile.mkdtemp()) / "shadow.jsonl"
fail = lambda t, k: (_ for _ in ()).throw(TimeoutError())
ok = lambda t, k: json.loads(${JSON.stringify(JSON.stringify(jevResponse(0.3, 2.5, 0.1)))})
out = {"fresh": w.needs_verdict(log, "a")}
for i in range(3):
    w.shadow({"id": "a"}, "k", log, ask=fail)
    out[f"after_fail_{i+1}"] = w.needs_verdict(log, "a")
w.shadow({"id": "b"}, "k", log, ask=fail)
w.shadow({"id": "b"}, "k", log, ask=ok)
out["b_after_success"] = w.needs_verdict(log, "b")
out["other_ticket"] = w.needs_verdict(log, "c")
with log.open("a") as f: f.write("not json\\n")
out["tolerates_garbage"] = w.needs_verdict(log, "c")
print(json.dumps(out))
`);
  assert.deepEqual(r, {
    fresh: true, after_fail_1: true, after_fail_2: true, after_fail_3: false,
    b_after_success: false, other_ticket: true, tolerates_garbage: true,
  });
});

// The hook in dispatch. Everything before and after it is stubbed; stage_planning
// stops the dispatch so the test sees exactly what reached the planner.
function dispatch({ jev, env = "", key = "k", logActivityThrows = false }) {
  return python(`
import os, bridge, workflow_router
${env ? `os.environ["MC_JEV_SHADOW"] = ${JSON.stringify(env)}` : ""}
bridge.WORKFLOW_SHADOW_LOG = Path(tempfile.mkdtemp()) / "shadow.jsonl"
bridge._typesafe_api_key = lambda: ${JSON.stringify(key)}
asked, planned, activity = [], [], []
def fake_jev(task, key):
    asked.append(task["description"])
    ${jev === "raise" ? "raise TimeoutError()" : `return json.loads(${JSON.stringify(JSON.stringify(jev ?? {}))})`}
workflow_router.ask_jev = fake_jev
bridge._normalize_repos = lambda r: r
bridge._existing_pr_handoff = lambda t: None
bridge._latest_reset_pr = lambda t: ""
bridge._pr_matches_repos = lambda u, r: True
bridge._pr_guard = lambda t, r: True
bridge.fetch_task_activities = lambda t: []
bridge._build_triage_context = lambda t: "## Routing\\napps/new-ui"
def log_activity(task_id, kind, msg, *a):
    ${logActivityThrows ? "raise RuntimeError('MC down')" : "activity.append(msg)"}
bridge.mc_log_activity = log_activity
bridge.stage_planning = lambda task, repos: planned.append(task["description"]) or (False, "")
task = {"id": "t-123456789", "title": "Footer weight", "description": "Make it 500", "task_type": "implementation"}
for _ in range(2):
    bridge._spawn_for_repos(dict(task), [{"project": "GitProjects", "repo": "backend"}])
log = bridge.WORKFLOW_SHADOW_LOG
print(json.dumps({"asked": asked, "planned": planned, "activity": activity,
                  "log": [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []}))
`);
}

test("dispatch records Jev's verdict on the triage-augmented ticket, then plans as before", () => {
  const r = dispatch({ jev: jevResponse(0.9, 0.5, 0.01) });
  const augmented = "Make it 500\n\n---\n\n## Routing\napps/new-ui";
  // Asked once across two dispatch ticks; planning still runs on both — light is not acted on.
  assert.deepEqual(r.asked, [augmented]);
  assert.deepEqual(r.planned, [augmented, augmented]);
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].verdict, "light");
  assert.deepEqual(r.activity, [
    "Jev (shadow) would route this **light** — UI-only 90%; size 0.5/3; funds/chain/auth 1%. "
    + "Recorded only; the ticket runs the full workflow as usual.",
  ]);
});

test("a failing Jev, a failing activity log, no key, or the opt-out never block planning", () => {
  const failing = dispatch({ jev: "raise" });
  assert.equal(failing.planned.length, 2);
  assert.equal(failing.asked.length, 2, "a failure is retried on the next tick");
  assert.deepEqual(failing.log.map((l) => l.error), ["TimeoutError", "TimeoutError"]);
  assert.deepEqual(failing.activity, []);

  const mcDown = dispatch({ jev: jevResponse(0.9, 0.5, 0.01), logActivityThrows: true });
  assert.equal(mcDown.planned.length, 2);
  assert.equal(mcDown.log.length, 1);

  const noKey = dispatch({ jev: jevResponse(0.9, 0.5, 0.01), key: "" });
  assert.deepEqual([noKey.asked, noKey.log, noKey.planned.length], [[], [], 2]);

  const optedOut = dispatch({ jev: jevResponse(0.9, 0.5, 0.01), env: "0" });
  assert.deepEqual([optedOut.asked, optedOut.log, optedOut.planned.length], [[], [], 2]);
});
