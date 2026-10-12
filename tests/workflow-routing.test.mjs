// Routing half of workflow_router: which workflow a ticket gets once
// `workflowRouting.enabled` is on, the light run's bounds, the bridge's cached
// choice, the prompts each tier is given, and the ticket page's Workflow panel.
// The shadow half (verdict, log, ask-once) is tested in workflow-router.test.mjs.
// Routing tests turn the switch on explicitly; the off path has its own tests below.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SWARM)})
${code}
`], { encoding: "utf8" }));
}

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
route = lambda jev, **kw: w.choose_workflow(jev, enabled=True, **kw)
cases = json.loads(${JSON.stringify(JSON.stringify(BACKTEST))})
print(json.dumps({k: route(v) for k, v in cases.items()}))
`);
  assert.equal(r["MET-661 footer weight, 2 lines"].workflow, "light");
  assert.equal(r["MET-667 breadcrumb color, 8 lines"].workflow, "light");
  assert.deepEqual(r["MET-661 footer weight, 2 lines"].why,
    ["UI-only 83%", "size 0.6/3", "funds/chain/auth 2%"]);
  // UI-only is not enough on its own: MET-650 was frontend-only and 1.8k lines.
  assert.equal(r["MET-650 homepage, 1793 lines UI-only"].workflow, "heavy");
  assert.deepEqual(r["MET-650 homepage, 1793 lines UI-only"].why, ["size 1.9/3 is above 1.2"]);
  assert.equal(r["MET-726 founders game, 7067 lines"].workflow, "heavy");
  assert.equal(r["MET-726 founders game, 7067 lines"].why.length, 2, "both the UI and size reasons are reported");
  assert.equal(r["MET-591 connect w/o signing"].workflow, "heavy");
  assert.match(r["MET-591 connect w/o signing"].why.join(), /funds, chain or auth behaviour \(89%\)/);
  assert.equal(r["MET-606 backoffice migration"].workflow, "heavy");
  for (const v of Object.values(r)) assert.equal(v.source, "jev");
});

test("each threshold is exclusive on the risky side", () => {
  const r = python(`
import workflow_router as w
route = lambda jev, **kw: w.choose_workflow(jev, enabled=True, **kw)
ok = {"ui_only": 0.9, "scope": 0.5, "money_or_chain": 0.0}
print(json.dumps({
  "ui_at_min": route({**ok, "ui_only": 0.7})["workflow"],
  "ui_above": route({**ok, "ui_only": 0.701})["workflow"],
  "scope_at_max": route({**ok, "scope": 1.2})["workflow"],
  "scope_above": route({**ok, "scope": 1.201})["workflow"],
  "money_at_max": route({**ok, "money_or_chain": 0.3})["workflow"],
  "money_below": route({**ok, "money_or_chain": 0.299})["workflow"],
  "custom": route({**ok, "scope": 0.5}, thresholds={"scope_max": 0.4})["workflow"],
}))
`);
  assert.deepEqual(r, { ui_at_min: "heavy", ui_above: "light", scope_at_max: "light",
    scope_above: "heavy", money_at_max: "heavy", money_below: "light", custom: "heavy" });
});

test("override, careful, and a missing Jev all resolve before the numbers", () => {
  const r = python(`
import workflow_router as w
route = lambda jev, **kw: w.choose_workflow(jev, enabled=True, **kw)
light = {"ui_only": 0.95, "scope": 0.1, "money_or_chain": 0.0}
heavy = {"ui_only": 0.1, "scope": 3.0, "money_or_chain": 0.9}
print(json.dumps({
  "override_light": route(heavy, override="light"),
  "override_heavy": route(light, override="heavy"),
  "override_gsd": route(light, override="gsd"),
  "never_gsd": sorted({route({"ui_only": u, "scope": sc, "money_or_chain": m})["workflow"]
                       for u in (0, .5, 1) for sc in (0, 1.5, 3) for m in (0, .5, 1)}),
  "override_beats_careful": route(heavy, override="light", level="careful")["workflow"],
  "careful": route(light, level="careful"),
  "no_key": route(None),
  "jev_error": route(None, jev_error="HTTPError 401"),
}))
`);
  assert.deepEqual(r.override_light, { workflow: "light", source: "override", why: ["set to light on the ticket"] });
  assert.equal(r.override_heavy.workflow, "heavy");
  assert.equal(r.override_gsd.workflow, "gsd", "GSD is reachable, but only by asking for it");
  assert.deepEqual(r.never_gsd, ["heavy", "light"], "no reading of Jev's numbers picks GSD");
  assert.equal(r.override_beats_careful, "light", "an explicit choice on the ticket wins");
  assert.deepEqual(r.careful, { workflow: "heavy", source: "rules", why: ["process level is careful"] });
  assert.deepEqual(r.no_key, { workflow: "heavy", source: "fallback", why: ["Jev not configured"] });
  assert.deepEqual(r.jev_error.why, ["Jev unavailable (HTTPError 401)"]);
});

test("summarise reads the documented response shape", () => {
  const r = python(`
import workflow_router as w
route = lambda jev, **kw: w.choose_workflow(jev, enabled=True, **kw)
print(json.dumps(w.summarise({"model": "jev-1.13.0", "answers": {
  "ui_only": {"type": "noul", "noul": 0.8312},
  "scope": {"type": "score", "score": 0.6418, "confidence": 0.71, "legend": {}, "probabilities": {}},
  "money_or_chain": {"type": "noul", "noul": 0.0188}}})))
`);
  assert.deepEqual(r, { model: "jev-1.13.0", ui_only: 0.831, scope: 0.642,
    scope_confidence: 0.71, money_or_chain: 0.019 });
});

test("a light run's bounds catch the backend work tickets never mention", () => {
  const r = python(`
import workflow_router as w
route = lambda jev, **kw: w.choose_workflow(jev, enabled=True, **kw)
ui = ["apps/backable/src/components/a%d.tsx" % i for i in range(15)]
print(json.dumps({
  "ui15": w.crosses_light_bounds(ui),
  "ui16": w.crosses_light_bounds(ui + ["apps/new-ui/src/x.svelte"]),
  # The four the backtest's rule sent light wrongly, or would have (MET-552/657/659/584).
  "new_api": w.crosses_light_bounds(["apps/new-ui/a.svelte", "apps/new-api/src/api/v1/jupiter_api.rs"]),
  "sqlx": w.crosses_light_bounds(["apps/new-api/.sqlx/query-1.json"]),
  "sql": w.crosses_light_bounds(["apps/new-api/sql/proposal/trade.sql"]),
  "workflow": w.crosses_light_bounds([".github/workflows/lint.yml"]),
  "backable_api": w.crosses_light_bounds(["apps/backable-api/src/routes/x.ts"]),
  "packages": w.crosses_light_bounds(["packages/database/schema/etls/ui/src/schema.ts"]),
  "drizzle": w.crosses_light_bounds(["apps/backoffice/drizzle/0006.sql"]),
  "sql_named_ui_file": w.crosses_light_bounds(["apps/new-ui/src/lib/sql-format.ts"]),
  "e2e": w.crosses_light_bounds(["apps/new-integration-tests/tests/nav.spec.ts"]),
}))
`);
  assert.equal(r.ui15, null);
  assert.equal(r.ui16, "changes 16 files (light allows 15)");
  assert.equal(r.new_api, "touches apps/new-api/src/api/v1/jupiter_api.rs");
  for (const k of ["sqlx", "sql", "workflow", "backable_api", "packages", "drizzle"]) {
    assert.match(r[k] || "", /^touches /, `${k} must cross the bounds`);
  }
  assert.equal(r.sql_named_ui_file, null, "a UI file named sql-* is not SQL");
  assert.equal(r.e2e, null, "UI tests belong to a UI change");
});

// ─────────── the bridge: decide once, record it, reuse it ───────────

const BRIDGE_HARNESS = `
import bridge, workflow_router
bridge._workflow_routing_enabled = lambda: True
calls = {"jev": 0, "writes": [], "activity": []}
def fake_jev(task, key, **kw):
    calls["jev"] += 1
    calls["jev_input"] = workflow_router.ticket_state(task)
    return {"model": "jev-1.13.0", "answers": {
        "ui_only": {"noul": JEV["ui"]}, "scope": {"score": JEV["scope"], "confidence": 0.8},
        "money_or_chain": {"noul": JEV["money"]}}}
workflow_router.ask_jev = fake_jev
bridge._typesafe_api_key = lambda: KEY
bridge._read_planning_job = lambda path: PLANNING_JOB
bridge.mc_request = lambda method, path, body=None: calls["writes"].append([method, path, body]) or {}
bridge.mc_log_activity = lambda tid, kind, msg, *a, **k: calls["activity"].append(msg)
JEV = {"ui": 0.9, "scope": 0.5, "money": 0.02}
KEY = "k"
PLANNING_JOB = None
`;

test("the bridge asks Jev once, records the call on the ticket, then reuses it", () => {
  const r = python(`
${BRIDGE_HARNESS}
task = {"id": "t1", "title": "[MET-1] Footer weight", "description": "d", "triage_state": {"questions": []}}
first = bridge._choose_workflow(task)
# The same dict comes round again on the next tick with the record now on it.
second = bridge._choose_workflow(task)
print(json.dumps({"first": first, "second": second, "calls": calls, "task_state": task["triage_state"]}))
`);
  assert.equal(r.first.workflow, "light");
  assert.equal(r.first.source, "jev");
  assert.deepEqual(r.first.jev, { model: "jev-1.13.0", ui_only: 0.9, scope: 0.5,
    scope_confidence: 0.8, money_or_chain: 0.02 });
  assert.equal(r.calls.jev, 1, "cached after the first decision");
  assert.deepEqual(r.second, r.first);
  // Jev reads the ticket in the backtest's shape.
  assert.equal(r.calls.jev_input.ticket, "# Task: [MET-1] Footer weight\n\n## Context\nd");
  // One PATCH carrying the record — merged, not a full replace of triage state.
  assert.equal(r.calls.writes.length, 1);
  assert.deepEqual(r.calls.writes[0].slice(0, 2), ["PATCH", "/api/tasks/t1/triage-state"]);
  assert.deepEqual(Object.keys(r.calls.writes[0][2]), ["workflow"]);
  assert.equal(r.calls.writes[0][2].workflow.workflow, "light");
  assert.deepEqual(r.calls.activity, ["Workflow: **light** — UI-only 90%; size 0.5/3; funds/chain/auth 2%"]);
  assert.deepEqual(r.task_state.questions, [], "the rest of the state survives");
});

test("changing the override re-decides without asking Jev", () => {
  const r = python(`
${BRIDGE_HARNESS}
task = {"id": "t1", "title": "t", "description": "d", "triage_state": {}}
bridge._choose_workflow(task)
task["triage_state"] = {**task["triage_state"], "workflow_override": "heavy"}
flipped = bridge._choose_workflow(task)
task["triage_state"] = {**task["triage_state"], "workflow_override": "nonsense"}
garbage_is_auto = bridge._choose_workflow(task)
print(json.dumps({"flipped": flipped, "auto": garbage_is_auto, "jev": calls["jev"]}))
`);
  assert.equal(r.flipped.workflow, "heavy");
  assert.equal(r.flipped.source, "override");
  assert.equal(r.flipped.override, "heavy");
  assert.equal(r.auto.override, "", "an unknown override is Auto");
  assert.equal(r.auto.workflow, "light");
  assert.equal(r.jev, 2, "the override skips Jev; returning to Auto asks again");
});

test("escalation, errors and a missing key go heavy; an in-flight GSD plan stays GSD", () => {
  const r = python(`
${BRIDGE_HARNESS}
out = {}
out["escalated"] = bridge._choose_workflow({"id": "a", "title": "t", "description": "",
    "triage_state": {"workflow_escalation": {"reason": "needs a new-api query"}}})
PLANNING_JOB = {"pid": 1}
out["planning"] = bridge._choose_workflow({"id": "b", "title": "t", "description": "", "triage_state": {}})
PLANNING_JOB = None
def boom(task, key, **kw):
    import urllib.error
    raise urllib.error.HTTPError("u", 401, "unauthorized", {}, None)
workflow_router.ask_jev = boom
out["error"] = bridge._choose_workflow({"id": "c", "title": "t", "description": "", "triage_state": {}})
KEY = ""
out["no_key"] = bridge._choose_workflow({"id": "d", "title": "t", "description": "", "triage_state": {}})
print(json.dumps(out))
`);
  assert.deepEqual([r.escalated.workflow, r.escalated.source], ["heavy", "escalation"]);
  assert.deepEqual(r.escalated.why, ["a light run escalated: needs a new-api query"]);
  assert.deepEqual([r.planning.workflow, r.planning.why], ["gsd", ["GSD planning had already started"]]);
  assert.deepEqual([r.error.workflow, r.error.why], ["heavy", ["Jev unavailable (HTTPError 401)"]]);
  assert.equal(r.error.jev, null);
  assert.deepEqual([r.no_key.workflow, r.no_key.why], ["heavy", ["Jev not configured"]]);
});

test("the key is read fresh from the env file the bridge started without", () => {
  const r = python(`
import os, tempfile, bridge
from pathlib import Path
os.environ.pop("TYPESAFE_API_KEY", None)
d = tempfile.mkdtemp()
bridge.ENV_FILE = Path(d) / ".env"
before = bridge._typesafe_api_key()
bridge.ENV_FILE.write_text("OTHER=1\\nTYPESAFE_API_KEY='sk-test'\\n")
print(json.dumps({"before": before, "after": bridge._typesafe_api_key()}))
`);
  assert.deepEqual(r, { before: "", after: "sk-test" });
});

// ─────────── the switch ───────────

test("routing is off unless swarm-config.json explicitly turns it on", () => {
  const r = python(`
import workflow_router as w
print(json.dumps([w.routing_enabled(c) for c in [
  None, {}, {"workflowRouting": {}}, {"workflowRouting": {"enabled": "true"}},
  {"workflowRouting": {"enabled": 1}}, {"workflowRouting": True}, {"workflowRouting": {"enabled": False}},
  {"workflowRouting": {"enabled": True}},
]]))
`);
  assert.deepEqual(r, [false, false, false, false, false, false, false, true]);
});

test("with routing off every ticket stays on GSD unless it carries an explicit override", () => {
  const r = python(`
import workflow_router as w
light = {"ui_only": 0.9, "scope": 0.5, "money_or_chain": 0.02}
print(json.dumps({
  "light_numbers": w.choose_workflow(light, enabled=False),
  "careful": w.choose_workflow(light, enabled=False, level="careful")["workflow"],
  "no_jev": w.choose_workflow(None, enabled=False)["workflow"],
  "override_light": w.choose_workflow(None, enabled=False, override="light"),
  "override_heavy": w.choose_workflow(None, enabled=False, override="heavy")["workflow"],
}))
`);
  assert.deepEqual(r.light_numbers, { workflow: "gsd", source: "off", why: ["Jev workflow routing is off"] });
  assert.equal(r.careful, "gsd");
  assert.equal(r.no_jev, "gsd");
  assert.deepEqual(r.override_light, { workflow: "light", source: "override", why: ["set to light on the ticket"] });
  assert.equal(r.override_heavy, "heavy");
});

test("the bridge reads the switch fresh from swarm-config.json, and a bad file means off", () => {
  const r = python(`
import tempfile, bridge
from pathlib import Path
d = Path(tempfile.mkdtemp())
bridge.SWARM_CONFIG_PATH = d / "swarm-config.json"
out = {"missing": bridge._workflow_routing_enabled()}
bridge.SWARM_CONFIG_PATH.write_text("{not json")
out["garbage"] = bridge._workflow_routing_enabled()
bridge.SWARM_CONFIG_PATH.write_text(json.dumps({"workflowRouting": {"enabled": True}}))
out["on"] = bridge._workflow_routing_enabled()
bridge.SWARM_CONFIG_PATH.write_text(json.dumps({"workflowRouting": {"enabled": False}}))
out["off_again"] = bridge._workflow_routing_enabled()
print(json.dumps(out))
`);
  assert.deepEqual(r, { missing: false, garbage: false, on: true, off_again: false });
});

test("routing off: the bridge never asks Jev or records a choice, so turning it on later still routes", () => {
  const r = python(`
${BRIDGE_HARNESS}
bridge._workflow_routing_enabled = lambda: False
task = {"id": "t1", "title": "[MET-1] Footer weight", "description": "d", "triage_state": {"questions": []}}
off = bridge._choose_workflow(task)
off_calls, off_writes, off_activity = calls["jev"], list(calls["writes"]), list(calls["activity"])
# The confirm gate stores whatever was chosen; that "off" record must not stick once routing is on.
task["triage_state"] = {"questions": [], "workflow": off}
bridge._workflow_routing_enabled = lambda: True
on = bridge._choose_workflow(task)
overridden = bridge._choose_workflow({"id": "t2", "title": "t", "description": "d",
                                      "triage_state": {"workflow_override": "light"}})
print(json.dumps({"off": off, "off_calls": off_calls, "off_writes": off_writes, "off_activity": off_activity,
                  "on": on["workflow"], "on_source": on["source"], "on_calls": calls["jev"],
                  "override": overridden["workflow"]}))
`);
  assert.deepEqual(r.off, { workflow: "gsd", source: "off", why: ["Jev workflow routing is off"] });
  assert.equal(r.off_calls, 0);
  assert.deepEqual(r.off_writes, []);
  assert.deepEqual(r.off_activity, []);
  assert.equal(r.on, "light");
  assert.equal(r.on_source, "jev");
  assert.equal(r.on_calls, 1);
  assert.equal(r.override, "light");
});

test("with routing off an explicit override is still honoured and recorded on the ticket", () => {
  const r = python(`
${BRIDGE_HARNESS}
bridge._workflow_routing_enabled = lambda: False
task = {"id": "t3", "title": "t", "description": "d", "triage_state": {"workflow_override": "heavy"}}
chosen = bridge._choose_workflow(task)
print(json.dumps({"chosen": chosen["workflow"], "source": chosen["source"], "jev": calls["jev"],
                  "patched": [w[1] for w in calls["writes"]]}))
`);
  assert.deepEqual(r, { chosen: "heavy", source: "override", jev: 0, patched: ["/api/tasks/t3/triage-state"] });
});

test("the isolated Codex home is opt-in, so today's Codex runs are unchanged", () => {
  const src = readFileSync(new URL("../swarm/run-codex.sh", import.meta.url), "utf8");
  assert.match(src, /if \[ "\$\{MC_CODEX_ISOLATE:-0\}" = "1" \]; then/);
});

// ─────────── what the agent is told ───────────

test("light and heavy prompts carry the discipline, the helpers and a budget — no GSD", () => {
  const r = python(`
import bridge
task = {"title": "[MET-661] Footer weight", "description": "d", "id": "t1"}
wf = lambda tier, why: {"workflow": tier, "why": why}
print(json.dumps({
  "light": bridge.generate_prompt(task, "", "p", "r", workflow=wf("light", ["UI-only 83%", "size 0.6/3", "funds/chain/auth 2%"])),
  "heavy": bridge.generate_prompt(task, "", "p", "r", workflow=wf("heavy", ["size 2.9/3 is above 1.2"])),
  "role": str(bridge.ROLE_SH), "tdir": str(bridge._ticket_dir("t1")),
}))
`);
  const { light, heavy, role, tdir } = r;
  assert.ok(role.endsWith("/swarm/role.sh") && !role.includes(".mission-control"), "the repo copy, not a symlink farm");
  for (const [name, p] of [["light", light], ["heavy", heavy]]) {
    assert.doesNotMatch(p, /Mandatory Workflow/, name);
    assert.doesNotMatch(p, /Run `\/gsd-/, `${name} never tells the agent to run GSD`);
    assert.match(p, /do NOT launch other agent CLIs \(`claude -p`,\s+`codex exec`\)/, name);
    // The distilled rules.
    assert.match(p, /Say the intent first/, name);
    assert.match(p, /A criterion that cannot fail is not a criterion/, name);
    assert.match(p, /Smallest correct change wins/, name);
    assert.match(p, /Stop exploring the moment you can name the files you will change/, name);
    assert.match(p, /Tests alone never prove done/, name);
    assert.match(p, /ONE full run of the app's suite right before the PR/, name);
    assert.match(p, /Two identical failures = stop and change approach/, name);
    // Helpers by absolute path, visuals only through the looker.
    for (const helper of ["explore", "looker", "critic", "oracle"]) {
      assert.ok(p.includes(`${role} ${helper} --cd`), `${name} names the ${helper} helper`);
    }
    assert.match(p, /Do not open screenshots or design exports yourself/, name);
    assert.match(p, /never ask a helper to verify work you can verify directly/, name);
    assert.ok(p.includes(`${tdir}/evidence/`), `${name} keeps proof out of git`);
    assert.match(p, /gh pr create` — title MUST start with `\[MET-661\]`/, name);
    assert.match(p, /success criteria are the source of truth/, name);
  }
  // Budgets and criteria counts differ by tier.
  assert.match(light, /budget 45 minutes/);
  assert.match(heavy, /budget 120 minutes/);
  assert.match(light, /1–2 success criteria/);
  assert.match(heavy, /1–5 success criteria/);
  // Light: one gate review, bounded; bounds escalate to heavy.
  assert.match(light, /## Light Workflow/);
  assert.match(light, /routed this ticket to the light workflow — UI-only 83%; size 0\.6\/3/);
  assert.match(light, /Re-run the critic at most twice/);
  assert.match(light, /more than 15 changed files/);
  assert.match(light, /"workflow_escalation": \{"from": "light", "to": "heavy", "reason": "WHAT_YOU_FOUND"\}/);
  assert.match(light, /Your budget becomes 120 minutes/);
  assert.doesNotMatch(light, /plan\.md/);
  // Heavy: self-written plan outside the repo, one critic pass on it, final review.
  assert.match(heavy, /## Heavy Workflow/);
  assert.ok(heavy.includes(`Plan** in \`${tdir}/plan.md\` (outside the repo, never committed)`));
  assert.match(heavy, /## Must have` \/ `## Must NOT have/);
  assert.match(heavy, /Implementation and its test are ONE step, never two/);
  assert.ok(heavy.includes(`cat ${tdir}/plan.md | ${role} critic --cd`));
  assert.match(heavy, /approval with notes is approval/);
  assert.match(heavy, /at most two re-reviews of what changed/);
  assert.doesNotMatch(heavy, /Stay inside the light bounds/);
});

test("GSD keeps its old prompt, and no record means GSD", () => {
  const r = python(`
import bridge
task = {"title": "[MET-1] t", "description": "d", "id": "t1"}
print(json.dumps({
  "gsd": bridge.generate_prompt(task, "", "p", "r", workflow={"workflow": "gsd", "why": []}),
  "legacy": bridge.generate_prompt(task, "", "p", "r"),
}))
`);
  for (const p of [r.gsd, r.legacy]) {
    assert.match(p, /## Mandatory Workflow/);
    assert.match(p, /### Step 7: PR \+ Report\nAfter local verification and independent review pass, publish the PR/);
    assert.match(p, /GSD verification is the source of truth/);
    assert.doesNotMatch(p, /Light Workflow|Heavy Workflow/);
  }
  assert.equal(r.gsd, r.legacy);
});

test("dispatch: only GSD stages a plan and runs on Claude; light and heavy set their effort", () => {
  const r = python(`
import bridge
seen = {"staged": 0, "spawns": []}
def stage(task, repos):
    seen["staged"] += 1
    return True, "/tmp/plan"
bridge.stage_planning = stage
for name in ["mc_update_task", "mc_log_activity"]:
    setattr(bridge, name, lambda *a, **k: None)
bridge._pr_guard = lambda *a: True
bridge.fetch_task_activities = lambda tid: []
bridge._build_triage_context = lambda tid: ""
bridge.read_repo_index = lambda *a: ""
bridge.find_repo_path = lambda *a: "/repo"
bridge.recall_knowledge = lambda *a: {}
bridge.resolved_decisions = lambda tid: []
bridge._resolve_base_branch = lambda *a: "origin/master"
bridge._existing_pr_handoff = lambda task: None
bridge._latest_reset_pr = lambda tid: ""
bridge._pr_matches_repos = lambda *a: True
def spawn(task_id, label, path, prompt, **kw):
    seen["spawns"].append({"prompt": prompt[:0] + ("light" if "## Light Workflow" in prompt else "heavy" if "## Heavy Workflow" in prompt else "gsd" if "## Mandatory Workflow" in prompt else "?"),
                           "planning_dir": kw.get("planning_dir"), "agent_type": kw.get("agent_type", "codex"),
                           "effort": kw.get("effort")})
    return True
bridge.spawn_agent = spawn
def run(workflow):
    bridge._choose_workflow = lambda task: {"workflow": workflow, "why": ["x"]}
    bridge._spawn_for_repos({"id": "t", "title": "[MET-1] t", "description": "d"},
                            [{"project": "p", "repo": "r"}])
run("light"); run("heavy"); run("gsd")
print(json.dumps(seen))
`);
  assert.equal(r.staged, 1, "only GSD staged a plan");
  assert.deepEqual(r.spawns, [
    { prompt: "light", planning_dir: "", agent_type: "codex", effort: "medium" },
    { prompt: "heavy", planning_dir: "", agent_type: "codex", effort: "high" },
    { prompt: "gsd", planning_dir: "/tmp/plan", agent_type: "claude", effort: "" },
  ]);
});

test("the effort override reaches the launcher for Codex only, after profile fallback", () => {
  const sh = readFileSync(new URL("../swarm/spawn-agent.sh", import.meta.url), "utf8");
  const override = sh.indexOf('if [ -n "${MC_AGENT_EFFORT:-}" ] && [ "$AGENT_LAUNCHER" = "codex" ]; then');
  const fallback = sh.indexOf('AGENT_PROFILE="$AGENT_FALLBACK_PROFILE"');
  assert.ok(override > 0, "override present and gated on the codex launcher");
  assert.ok(override > fallback, "applied after a fallback profile could have replaced the effort");
  const py = readFileSync(new URL("../swarm/bridge.py", import.meta.url), "utf8");
  assert.match(py, /env\["MC_AGENT_EFFORT"\] = effort or ""/);
  const codex = readFileSync(new URL("../swarm/run-codex.sh", import.meta.url), "utf8");
  assert.match(codex, /CFG_EFFORT=\$\{AGENT_EFFORT:-/, "run-codex.sh reads the effort spawn-agent.sh exports");
});

test("the choice is made before the confirm gate and survives its full-replace write", () => {
  // The gate PUTs triage state from the loop's local copy; the record must be in it.
  const src = readFileSync(new URL("../swarm/bridge.py", import.meta.url), "utf8");
  const choose = src.indexOf("chosen = _choose_workflow(augmented)");
  const gate = src.indexOf('if not (state or {}).get("confirmed"):');
  assert.ok(choose > 0 && gate > choose, "workflow is chosen before the confirmation gate");
  assert.match(src.slice(choose, gate), /state = \{\*\*\(state or \{\}\), "workflow": chosen\}/);
});

// ─────────── the ticket page ───────────

function page(extraShim = "", after = "") {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
    ${extraShim}
  `;
  return new Function(`${shim}\n${body}\n${after}\nreturn { renderWorkflow, workflowFacts, renderConversation, setWorkflowOverride, runStatus };`)();
}

const LIGHT_RECORD = {
  workflow: "light", source: "jev", override: "",
  why: ["UI-only 83%", "size 0.6/3", "funds/chain/auth 2%"],
  jev: { model: "jev-1.13.0", ui_only: 0.83, scope: 0.64, scope_confidence: 0.7, money_or_chain: 0.02 },
};
const SETTLED = [{ id: "a", becomes: "D-01", question: "Which cursor column?", answer: "created_at" }];

test("before dispatch the panel shows Jev's numbers and lets you pick any of four paths", () => {
  const { renderWorkflow } = page();
  const out = renderWorkflow({ status: "planning" }, { workflow: LIGHT_RECORD });
  assert.match(out, /data-workflow="light"/);
  assert.match(out, /<select class="repo-select" data-workflow-select/);
  assert.match(out, /<option value="" selected>Auto \(Light\)<\/option>/);
  for (const [v, l] of [["light", "Light"], ["heavy", "Heavy"], ["gsd", "GSD"]]) {
    assert.match(out, new RegExp(`<option value="${v}" >${l}</option>`));
  }
  assert.doesNotMatch(out, /value="full"/);
  assert.match(out, /UI-only 83% · size 0\.6\/3 · funds\/chain\/auth 2%/);
  // Jev's numbers already say why a light call was made; the row is not repeated.
  assert.doesNotMatch(out, /<span class="k">why<\/span>/);
});

test("a heavy call shows its reasons, because they are not just the numbers", () => {
  const { renderWorkflow } = page();
  const out = renderWorkflow({ status: "planning" }, { workflow: { ...LIGHT_RECORD, workflow: "heavy",
    why: ["may need more than frontend changes (UI-only 35% ≤ 70%)", "size 2.9/3 is above 1.2"] } });
  assert.match(out, /<span class="k">why<\/span><span class="v" title="may need more than frontend changes \(UI-only 35% ≤ 70%\) · size 2\.9\/3 is above 1\.2">/);
  assert.match(out, /<option value="" selected>Auto \(Heavy\)<\/option>/);
});

test("an override is shown as the selection, and the decision it replaced is not claimed", () => {
  const { renderWorkflow } = page();
  const out = renderWorkflow({ status: "inbox" },
    { workflow_override: "gsd", workflow: { ...LIGHT_RECORD, workflow: "gsd", source: "override",
      override: "gsd", why: ["set to gsd on the ticket"], jev: null } });
  assert.match(out, /data-workflow="gsd"/);
  assert.match(out, /<option value="gsd" selected>GSD<\/option>/);
  assert.match(out, /<option value="" >Auto<\/option>/, "no stale '(Light)' on Auto");
  assert.doesNotMatch(out, /UI-only/, "no Jev line when Jev was not asked");
});

test("after dispatch the path is read-only, and an escalation is called out", () => {
  const { renderWorkflow } = page();
  const running = renderWorkflow({ status: "in_progress" }, { workflow: LIGHT_RECORD });
  assert.doesNotMatch(running, /data-workflow-select/);
  assert.match(running, /<span class="k">workflow<\/span><span class="v" title="Light">Light<\/span>/);
  const gsd = renderWorkflow({ status: "in_progress" }, { workflow: { ...LIGHT_RECORD, workflow: "gsd" } });
  assert.match(gsd, /<span class="v" title="GSD">GSD<\/span>/);

  const escalated = renderWorkflow({ status: "in_progress" }, { workflow: LIGHT_RECORD,
    workflow_escalation: { from: "light", to: "heavy", reason: "needs a new-api endpoint" } });
  assert.match(escalated, /data-workflow="heavy"/);
  assert.match(escalated, /Heavy · escalated from light/);
  assert.match(escalated, /class="fld warn"><span class="k">escalated<\/span><span class="v" title="needs a new-api endpoint"/);
  assert.doesNotMatch(renderWorkflow({ status: "planning" }, { workflow: LIGHT_RECORD,
    workflow_escalation: { reason: "r" } }), /data-workflow-select/);
});

test("no record, no override: nothing is drawn rather than a guess", () => {
  const { renderWorkflow } = page();
  assert.equal(renderWorkflow({ status: "planning" }, { questions: [] }), "");
  assert.equal(renderWorkflow({ status: "planning" }, null), "");
});

test("the thread, rail and button tell the truth about planning on each path", () => {
  const { renderConversation } = page();
  const gate = tier => renderConversation({ questions: SETTLED, workflow: { ...LIGHT_RECORD, workflow: tier } }, null, {});
  const running = tier => renderConversation({ questions: SETTLED, confirmed: true, workflow: { ...LIGHT_RECORD, workflow: tier } }, null, {});

  const lightGate = gate("light");
  assert.match(lightGate, /data-act="confirm">Confirm and start building</);
  assert.match(lightGate, /class="cwhy"><b>workflow · light<\/b> — UI-only 83% · size 0\.6\/3/);
  assert.match(lightGate, /no planning stage — confirm below/);
  assert.match(running("light"), /light workflow<span class="el">no planning stage/);

  const heavyGate = gate("heavy");
  assert.match(heavyGate, /data-act="confirm">Confirm and start building</);
  assert.match(heavyGate, /write a short plan and build it — no separate planning stage/);
  assert.match(running("heavy"), /heavy workflow<span class="el">plan written in-session/);
  for (const p of [lightGate, heavyGate, running("light"), running("heavy")]) {
    assert.doesNotMatch(p, /no plan on disk yet|Writing the plan next|as the phase brief/);
  }
  for (const p of [lightGate, heavyGate]) {
    assert.match(p, /<b>confirm<\/b> to start building<br>/);
    assert.match(p, /no separate planning stage\.<\/div>|there is no separate planning stage/);
  }

  const gsdGate = gate("gsd");
  assert.match(gsdGate, /data-act="confirm">Confirm and start planning</);
  assert.match(gsdGate, /<b>confirm<\/b> to start planning<br>/);
  assert.match(gsdGate, /lands in <code>\.planning\/<\/code> as the phase brief/);
  assert.match(running("gsd"), /planning<span class="el">no plan on disk yet/);
  assert.match(renderConversation({ questions: SETTLED, confirmed: true }, null, {}),
    /planning<span class="el">no plan on disk yet/, "no record keeps the old wording");
});

test("the header status line does not promise a planner unless it is GSD", () => {
  const { runStatus } = page();
  const task = { status: "planning" };
  assert.equal(runStatus(task, null, null, SETTLED, null, "light"), "everything is settled · building, no plan");
  assert.equal(runStatus(task, null, null, SETTLED, null, "heavy"), "everything is settled · plan + build in-session");
  assert.equal(runStatus(task, null, null, SETTLED, null, "gsd"), "everything is settled · the planner runs next");
  assert.equal(runStatus(task, null, null, SETTLED), "everything is settled · the planner runs next");
  const open = [{ id: "q", question: "?" }];
  assert.equal(runStatus(task, null, null, open, null, "heavy"), "building starts when the questions are settled");
});

test("choosing a workflow PATCHes the one field the bridge reads", async () => {
  const { setWorkflowOverride } = page(`
    const calls = globalThis.__wfCalls = [];
    const fetch = (url, opts) => { calls.push([url, opts]); return Promise.resolve({ ok: true }); };
  `, "load = () => { globalThis.__wfReloaded = true; };");
  const select = { value: "light", disabled: false };
  await setWorkflowOverride(select);
  const [[url, opts]] = globalThis.__wfCalls;
  assert.equal(url, "/api/tasks/x/triage-state");
  assert.equal(opts.method, "PATCH");
  assert.deepEqual(JSON.parse(opts.body), { workflow_override: "light" });
  assert.equal(select.disabled, true, "held until the reload redraws it");
  assert.equal(globalThis.__wfReloaded, true, "the page reloads to show the bridge's new call");
});
