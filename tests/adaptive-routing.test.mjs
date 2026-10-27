import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys, json, copy
sys.path.insert(0, ${JSON.stringify(SWARM)})
import workflow_router as w
SAFE = dict(ui_only=.1, scope=.5, money_or_chain=.01,
    behavioral_uncertainty=.1, blast_radius=.1, hard_to_reverse=.1,
    hard_to_test=.1, migration_or_contract=.01)
${code}`], { encoding: "utf8" }));
}
test("bounded backend and UI use the same behavioral risk policy", () => {
  const r = python(`
print(json.dumps([w.choose_workflow({**SAFE, "ui_only": ui}, enabled=True) for ui in (.01, .99)]))`);
  for (const d of r) {
    assert.equal(d.workflow, "light");
    assert.ok(d.why.some(s => /uncertainty/.test(s)));
  }
});
test("every high risk dimension, unknown, invalid and failed assessment escalates", () => {
  const r = python(`
cases = [{**SAFE, key: .9} for key in ("money_or_chain", "behavioral_uncertainty",
    "blast_radius", "hard_to_reverse", "hard_to_test", "migration_or_contract")]
cases += [{k:v for k,v in SAFE.items() if k != "hard_to_test"},
          {**SAFE, "blast_radius": float("nan")}, {**SAFE, "scope": float("inf")},
          {**SAFE, "hard_to_test": -1}, {**SAFE, "hard_to_test": "0.1"}, None]
print(json.dumps([w.choose_workflow(c, enabled=True)["workflow"] for c in cases]))`);
  assert.ok(r.every(tier => tier === "heavy"));
});
test("backend mapping and local SQL are allowed; migrations, schema and CI escalate", () => {
  const r = python(`
print(json.dumps({p: w.crosses_light_bounds([p]) for p in [
 "apps/api/src/output.rs", "packages/api/mapping.ts", "apps/api/sql/read.sql",
 "apps/ui/src/auth/login.tsx", "apps/api/migrations/001.sql", "packages/db/schema.ts",
 ".github/workflows/test.yml", "programs/market/src/lib.rs"]}))`);
  for (const p of ["apps/api/src/output.rs", "packages/api/mapping.ts", "apps/api/sql/read.sql"]) assert.equal(r[p], null);
  for (const p of ["apps/ui/src/auth/login.tsx", "apps/api/migrations/001.sql", "packages/db/schema.ts", ".github/workflows/test.yml", "programs/market/src/lib.rs"]) assert.match(r[p], /touches/);
});
const HARNESS = `
import bridge
bridge._workflow_routing_enabled = lambda *a: True
bridge._typesafe_api_key = lambda: "key"
bridge._read_planning_job = lambda path: None
calls = {"asks":0, "writes":[], "activity":[]}
def ask(*a, **kw):
    calls["asks"] += 1
    return {"answers": {k: {"score" if k == "scope" else "noul":v} for k,v in SAFE.items()}}
w.ask_jev = ask
bridge.mc_request = lambda method, path, body=None: calls["writes"].append(body) or {}
bridge.mc_log_activity = lambda tid, kind, msg, **kw: calls["activity"].append(msg)
`;
test("persisted pickup and process recovery are idempotent; escalation outranks the cache and override", () => {
  const r = python(`${HARNESS}
task = {"id":"test", "triage_state":{"questions":[]}}
a = bridge._choose_workflow(task)
b = bridge._choose_workflow(json.loads(json.dumps(task)))
task["triage_state"].update(workflow_override="light", workflow_escalation={"reason":"shared contract changed"})
c = bridge._choose_workflow(task)
d = bridge._choose_workflow(json.loads(json.dumps(task)))
print(json.dumps(dict(a=a,b=b,c=c,d=d,calls=calls)))`);
  assert.equal(r.a.workflow, "light");
  assert.equal(r.a.policy_version, "adaptive-bounded-v1");
  assert.deepEqual(r.a, r.b);
  assert.equal(r.c.workflow, "heavy");
  assert.deepEqual(r.c, r.d);
  assert.equal(r.calls.asks, 1);
  assert.equal(r.calls.writes.length, 2);
});
test("a GSD job and active legacy run cannot be rerouted by policy or override", () => {
  const r = python(`${HARNESS}
bridge._read_planning_job = lambda path: {"pid":1}
job = bridge._choose_workflow({"id":"job", "triage_state": {"workflow_override":"light", "workflow": {"workflow":"light", "source":"jev"}}})
bridge._read_planning_job = lambda path: None
active = bridge._choose_workflow({"id":"active", "status":"in_progress", "triage_state":{"workflow_override":"light"}})
bridge._workflow_routing_enabled = lambda *a: False
record = {"workflow":"heavy", "source":"jev", "override":""}
off = bridge._choose_workflow({"id":"off", "status":"in_progress", "triage_state":{"workflow":record}})
print(json.dumps(dict(job=job,active=active,off=off,calls=calls)))`);
  assert.equal(r.job.workflow, "gsd");
  assert.equal(r.active.workflow, "gsd");
  assert.equal(r.off.workflow, "heavy");
  assert.equal(r.calls.asks, 0);
});
test("lean prompt requires trace, brief plan, regression, stage telemetry, independent review and draft PR", () => {
  const r = python(`${HARNESS}
prompt = bridge.generate_prompt({"id":"t", "title":"[MET-1] fix mapping"}, "", "p", "r", workflow={"workflow":"light","why":["bounded"]})
print(json.dumps(prompt))`);
  for (const pattern of [/Trace.*repro/i, /Brief plan/, /regression/i, /independent/i,
    /--draft/, /workflow_stage/, /policy_version/, /missing decision/, /checkpoints/]) assert.match(r, pattern);
});

test("canary rollout is task-scoped and malformed/empty allowlists fail closed", () => {
  const r = python(`
config = lambda ids: {"workflowRouting":{"enabled": True,"taskIds":ids}}
print(json.dumps([w.routing_applies(config(ids), task) for ids,task in [
    (["future"],"future"), (["future"],"active"), ([],"future"), ("future","future"), ([1],"1"), (None,"future"), ({},"future"), (False,"future")]]))`);
  assert.deepEqual(r, [true, false, false, false, false, false, false, false]);
});
test("failed persistence prevents dispatch decision and is retried without a phantom cached record", () => {
  const r = python(`${HARNESS}
task = {"id":"t", "triage_state":{}}
def fail(*a): raise OSError("unavailable")
bridge.mc_request = fail
try:
    bridge._choose_workflow(task)
    raised = False
except OSError:
    raised = True
print(json.dumps(dict(raised=raised,state=task["triage_state"])))`);
  assert.equal(r.raised, true);
  assert.equal(r.state.workflow, undefined);
});
test("a running light agent's explicit escalation survives recovery without another assessment", () => {
  const r = python(`${HARNESS}
task = {"id":"t", "status":"in_progress", "triage_state":{
 "workflow":{"workflow":"light","source":"jev"},
 "workflow_escalation":{"reason":"funds semantics changed"}}}
a = bridge._choose_workflow(task)
b = bridge._choose_workflow(json.loads(json.dumps(task)))
print(json.dumps(dict(a=a,b=b,calls=calls)))`);
  assert.equal(r.a.workflow, "heavy");
  assert.deepEqual(r.a,r.b);
  assert.equal(r.calls.asks, 0);
  assert.equal(r.calls.writes.length, 1);
});
test("malformed blocked planner output creates an actionable operational escalation", () => {
  const r = python(`${HARNESS}
bridge.record_step_attempt = lambda *a, **kw: None
bridge.mc_set_progress = lambda *a, **kw: None
result = bridge.route_plan_stage_outcome({"id":"t"}, {"outcome":"questions_raised","questions":[],"reason":"invalid question output"})
print(json.dumps(dict(result=result, messages=calls["activity"])))`);
  assert.equal(r.result,false);
  assert.match(r.messages[0], /without an actionable question.*invalid question output/);
});

test("assessment request scope criteria explicitly support bounded backend fixes", () => {
  const r = python(`print(json.dumps(w.QUESTIONS["scope"]["criteria"]))`);
  assert.match(r[0], /output field mapping/);
  assert.match(r[0], /read-query correction/);
  assert.match(r[3], /consumers\/services/);
});
