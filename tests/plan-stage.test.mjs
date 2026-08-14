// Planning used to be the first few turns of the session that then wrote the code,
// which made its failure unreportable: two runs went 67 and 46 tool calls with zero
// Skill invocations and the logs looked healthy. Worse, when the planner did the
// right thing and asked a precise question, the question went to a terminal and died.
//
// Planning now runs as its own process with a verdict. These cover how that verdict
// is reached — from the filesystem wherever the filesystem can answer — and where
// each one lands.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

function python(program) {
  const stdout = execFileSync("python3", ["-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)})\n${program}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

/** A worktree with an optional GSD project and PLAN.md. */
function worktree({ planning = false, planText = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-planstage-"));
  if (planning) mkdirSync(join(dir, ".planning", "phase-1"), { recursive: true });
  if (planText !== null) writeFileSync(join(dir, ".planning", "phase-1", "PLAN.md"), planText);
  return dir;
}

// rc is spelled for Python: a timed-out run has no exit code, and JS null is not a
// Python literal.
const classify = (dir, output, rc) => python(`
import json, plan_stage
print(json.dumps(plan_stage.classify(${JSON.stringify(dir)}, ${JSON.stringify(output)}, ${rc === null || rc === undefined ? "None" : rc})))
`);

test("a plan on disk with tasks in it is the verdict, whatever the agent said", () => {
  const dir = worktree({ planning: true, planText: "# Plan\n<task id='1'>do the thing</task>\n" });
  try {
    // The transcript claims failure; the filesystem says otherwise and wins.
    const v = classify(dir, "I was unable to complete planning.", 1);
    assert.equal(v.outcome, "plan_written");
    assert.match(v.plan_path, /PLAN\.md$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a PLAN.md with no tasks is a document about planning, not a plan", () => {
  const dir = worktree({ planning: true, planText: "# Plan\n\nI will think about this later.\n" });
  try {
    const v = classify(dir, "done!", 0);
    assert.notEqual(v.outcome, "plan_written");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a question in the agreed form is picked up and marked as the planner's", () => {
  const dir = worktree({ planning: true });
  try {
    const v = classify(dir, `Thinking...
<mc-questions>
[{"question": "Which font licence did we buy?", "why": "self-hosting is not permitted under all of them", "options": ["Web Project", "Desktop"]}]
</mc-questions>`, 0);

    assert.equal(v.outcome, "questions_raised");
    assert.equal(v.questions.length, 1);
    assert.equal(v.questions[0].why, "self-hosting is not permitted under all of them");
    assert.equal(v.questions[0].question_type, "multiple_choice");
    // This is the field the ticket page leads with, and the one nothing used to write.
    assert.equal(v.questions[0].source, "planner");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a question asked in prose is not a question", () => {
  const dir = worktree({ planning: true });
  try {
    // Indistinguishable from thinking aloud, which is how the last one was lost.
    const v = classify(dir, "I wonder which font licence they bought? Should I ask?", 0);
    assert.notEqual(v.outcome, "questions_raised");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed question block is ignored rather than half-read", () => {
  const dir = worktree({ planning: true });
  try {
    const v = classify(dir, "<mc-questions>{not json</mc-questions>", 0);
    assert.notEqual(v.outcome, "questions_raised");
    assert.equal(v.questions.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a plan outranks a question — the planner asked, then answered itself", () => {
  const dir = worktree({ planning: true, planText: "<task>ship it</task>" });
  try {
    const v = classify(dir, "<mc-questions>[{\"question\": \"which one?\"}]</mc-questions>", 0);
    assert.equal(v.outcome, "plan_written");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no GSD project is a prerequisite, never a question", () => {
  const dir = worktree({ planning: false });
  try {
    const v = classify(dir, "I could not find a .planning directory.", 0);
    // Asking a human to approve creating a directory trains them to click through,
    // which is how a real question stops being read.
    assert.equal(v.outcome, "prerequisite_missing");
    assert.match(v.reason, /never created|no \.planning/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a project but no plan and no question is an error, not a silent pass", () => {
  const dir = worktree({ planning: true });
  try {
    const v = classify(dir, "All done.", 0);
    assert.equal(v.outcome, "error");
    assert.match(v.reason, /no plan and no question/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the planning prompt tells the agent how to stop, and not to write code", () => {
  const r = python(`
import json, plan_stage
p = plan_stage.build_prompt({"title": "MET-635", "description": "brand page"}, "## Decisions\\nD-01 settled")
print(json.dumps({"prompt": p}))
`);
  const p = r.prompt;
  assert.match(p, /do not write any application code/i);
  assert.match(p, /<mc-questions>/);
  assert.match(p, /Only ask what a human alone can answer/);
  // A prerequisite is reported, not asked about.
  assert.match(p, /do not ask about\s+missing setup/i);
  // The decisions already made have to reach the planner, or it re-asks them.
  assert.match(p, /D-01 settled/);
  // The GSD precondition: /gsd-plan-phase cannot plan into a repo with no .planning/.
  assert.match(p, /gsd-new-project/);
});

// ─────────── where each verdict lands ───────────

const route = (verdict) => python(`
import json, bridge
calls = {"questions": None, "status": None, "activities": [], "progress": None, "metric": None}
bridge.post_planning_questions = lambda tid, qs, **k: calls.__setitem__("questions", qs)
bridge.mc_update_task = lambda tid, up: calls.__setitem__("status", up.get("status"))
bridge.mc_log_activity = lambda tid, t, m, **k: calls["activities"].append((t, m))
bridge.mc_set_progress = lambda tid, **k: calls.__setitem__("progress", k.get("blocked_reason"))
bridge.record_step_attempt = lambda tid, n, rec: calls.__setitem__("metric", rec["outcome"])
# Parsed, not inlined: JSON true/false/null are not Python literals.
verdict = json.loads(${JSON.stringify(JSON.stringify(verdict))})
proceed = bridge.route_plan_stage_outcome({"id": "t1"}, verdict)
print(json.dumps({"proceed": proceed, **calls}))
`);

test("a written plan lets the work proceed", () => {
  const r = route({ outcome: "plan_written", plan_path: "/x/PLAN.md", duration_s: 12, gsd_ran: true });
  assert.equal(r.proceed, true);
  assert.equal(r.metric, "plan_plan_written");
});

test("a raised question reaches the ticket and stops the work", () => {
  const r = route({
    outcome: "questions_raised",
    questions: [{ id: "plan_q1", question: "Which licence?", source: "planner" }],
    duration_s: 8,
  });
  assert.equal(r.proceed, false, "no code before the plan");
  assert.equal(r.questions.length, 1, "posted as a follow-up, not just logged");
  assert.equal(r.status, "planning");
  // A dedicated type so the server raises a notification for it.
  assert.ok(r.activities.some(([t]) => t === "new_triage_question"));
});

test("a missing prerequisite escalates without being dressed up as a question", () => {
  const r = route({ outcome: "prerequisite_missing", reason: "no .planning/ in the worktree", transcript_path: "/t.log" });
  assert.equal(r.proceed, false);
  assert.equal(r.questions, null, "nobody is asked to approve creating a directory");
  assert.ok(r.activities.some(([t]) => t === "needs_human"));
  assert.match(r.progress, /no \.planning/);
});

test("a failed run escalates with somewhere to look", () => {
  const r = route({ outcome: "error", reason: "planning timed out after 1800s", transcript_path: "/tmp/t1.log", gsd_ran: false });
  assert.equal(r.proceed, false);
  const [, message] = r.activities.find(([t]) => t === "needs_human");
  // "The planner failed" with nowhere to look is what made the last two runs
  // unreadable — the transcript path and whether GSD ran are the whole point.
  assert.match(message, /\/tmp\/t1\.log/);
  assert.match(message, /GSD actually ran: False/);
});

// The first real run was killed at its 30-minute timeout and left a zero-byte
// transcript: `--output-format text` buffers until the end, so nothing had been
// flushed. That is the failure mode staging exists to prevent — the verdict said
// "timed out" and there was nowhere to look, and a question the planner had already
// emitted would have gone with it. Output is now streamed to disk as it arrives.

const fromStream = (raw) => python(`
import json, plan_stage
print(json.dumps(plan_stage.text_from_stream(json.loads(${JSON.stringify(JSON.stringify(raw))}))))
`);

test("assistant text is recovered from a stream-json transcript", () => {
  const raw = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Checking .planning" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "<mc-questions>[{\"question\":\"Which licence?\"}]</mc-questions>" }] } }),
  ].join("\n");
  const text = fromStream(raw);
  assert.match(text, /Checking \.planning/);
  assert.match(text, /mc-questions/);
});

test("a transcript cut mid-line still yields everything written before it", () => {
  // Exactly what a killed process leaves behind.
  const raw = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "<mc-questions>[{\"question\":\"Which licence?\",\"why\":\"changes the work\"}]</mc-questions>" }] } }),
    '{"type":"assistant","message":{"content":[{"type":"te',
  ].join("\n");

  const text = fromStream(raw);
  // The half-written line is dropped; the question that arrived before it is not.
  assert.match(text, /Which licence\?/);

  const dir = worktree({ planning: true });
  try {
    const v = classify(dir, text, null);
    assert.equal(v.outcome, "questions_raised", "a killed run's question still counts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a plain-text transcript still classifies rather than reading as empty", () => {
  // Belt and braces: if the format ever changes back, this must not silently
  // turn every run into "no question, no plan".
  assert.match(fromStream("<mc-questions>[{\"question\":\"x\"}]</mc-questions>"), /mc-questions/);
});

test("an empty transcript is empty, not an exception", () => {
  assert.equal(fromStream(""), "");
});

// ─────────── two stages, two budgets ───────────
// The first real run gave init and planning one shared 1800s. Setting up an
// established repo consumed all of it — a six-phase roadmap, a design contract, 61KB
// of research — and planning never started. They are separate stages now, and init
// is skipped entirely once .planning/ exists, so a retry costs only the plan.

test("init is skipped when the project already exists, at no cost", () => {
  const dir = worktree({ planning: true });
  try {
    const v = python(`
import json, plan_stage
def explode(*a, **k):
    raise AssertionError("no process should run when .planning/ already exists")
plan_stage._run_cli = explode
print(json.dumps(plan_stage.run_init_stage(${JSON.stringify(dir)}, {"id": "t1"})))
`);
    assert.equal(v.outcome, "initialised");
    assert.equal(v.duration_s, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init that does not create the project is a prerequisite, not an error", () => {
  const dir = worktree({ planning: false });
  try {
    const v = python(`
import json, plan_stage
plan_stage._run_cli = lambda *a, **k: {"output": "all done!", "returncode": 0,
                                          "timed_out": False, "duration_s": 4.2, "failed": None}
print(json.dumps(plan_stage.run_init_stage(${JSON.stringify(dir)}, {"id": "t1"})))
`);
    // The agent claimed success; the directory says otherwise and the directory wins.
    assert.equal(v.outcome, "prerequisite_missing");
    assert.match(v.reason, /without creating/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed init stops before planning is paid for", () => {
  const dir = worktree({ planning: false });
  try {
    const r = python(`
import json, plan_stage
ran = []
plan_stage._run_cli = lambda *a, **k: (ran.append("init"),
    {"output": "", "returncode": 1, "timed_out": False, "duration_s": 1, "failed": None})[1]
plan_stage.run_plan_stage = lambda *a, **k: (_ for _ in ()).throw(
    AssertionError("planning must not run after a failed init"))
v = plan_stage.plan_in_worktree(${JSON.stringify(dir)}, {"id": "t1"})
print(json.dumps({"outcome": v["outcome"], "stages": [s["stage"] for s in v["stages"]]}))
`);
    assert.equal(r.outcome, "prerequisite_missing");
    assert.deepEqual(r.stages, ["init"], "only init ran");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("both stages are reported, so a post-mortem sees where the time went", () => {
  const dir = worktree({ planning: true, planText: "<task>do it</task>" });
  try {
    const r = python(`
import json, plan_stage
plan_stage._run_cli = lambda *a, **k: {"output": "", "returncode": 0,
                                          "timed_out": False, "duration_s": 90.0, "failed": None}
v = plan_stage.plan_in_worktree(${JSON.stringify(dir)}, {"id": "t1"})
print(json.dumps({"outcome": v["outcome"], "stages": [[s["stage"], s["outcome"]] for s in v["stages"]]}))
`);
    assert.equal(r.outcome, "plan_written");
    assert.deepEqual(r.stages, [["init", "initialised"], ["plan", "plan_written"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init and plan keep separate transcripts", () => {
  const r = python(`
import json, plan_stage
print(json.dumps([str(plan_stage._transcript_path("t1", "init")),
                  str(plan_stage._transcript_path("t1", "plan"))]))
`);
  // Overwriting each other would lose the only account of whichever ran first.
  assert.notEqual(r[0], r[1]);
});

test("the init prompt does not invite questions — setup is not a decision", () => {
  const r = python(`
import json, plan_stage
print(json.dumps({"p": plan_stage.build_init_prompt({"title": "MET-635"})}))
`);
  assert.doesNotMatch(r.p, /<mc-questions>/);
  assert.match(r.p, /gsd-new-project/);
  assert.match(r.p, /do not write any application code/i);
});

// ─────────── the call site ───────────

const stage = (program) => python(`
import json, bridge
calls = {"metrics": [], "routed": None, "planned": False}
bridge.record_step_attempt = lambda tid, n, rec: calls["metrics"].append(rec["outcome"])
bridge.route_plan_stage_outcome = lambda task, v: calls.__setitem__("routed", v["outcome"]) or False
bridge._build_triage_context = lambda tid: ""
${program}
proceed, carry = bridge.stage_planning({"id": "task-1"}, [{"project": "p", "repo": "r"}])
print(json.dumps({"proceed": proceed, "carry": carry, **calls}))
`);

test("planning that cannot be set up fails open, and says so in the metrics", () => {
  // A missing repo path is not a verdict about the plan. Wedging the queue on one
  // is worse than proceeding — but it must not look like a plan that passed.
  const r = stage(`
bridge._stage_planning_enabled = lambda: True
bridge.find_repo_path = lambda project, repo: None
`);
  assert.equal(r.proceed, true);
  assert.equal(r.carry, "", "nothing to carry, so the agent plans for itself");
  assert.deepEqual(r.metrics, ["plan_stage_skipped"]);
  assert.equal(r.routed, null, "nothing was routed — no verdict was reached");
});

test("a real verdict fails closed", () => {
  const r = stage(`
import pathlib
bridge._stage_planning_enabled = lambda: True
bridge.find_repo_path = lambda project, repo: pathlib.Path("/tmp")
bridge._planning_worktree = lambda task, repo_path: pathlib.Path("/tmp")
bridge._planning_job_path = lambda tid: pathlib.Path("/tmp/nonexistent-job.json")
bridge._read_planning_job = lambda path: {"state": "done",
    "verdict": {"outcome": "questions_raised", "stages": []}}
`);
  assert.equal(r.proceed, false);
  assert.equal(r.carry, "", "a question means there is no plan to hand on");
  assert.equal(r.routed, "questions_raised");
});

test("staged planning can be turned off without touching the dispatch path", () => {
  const r = stage(`
bridge._stage_planning_enabled = lambda: False
def explode(*a, **k):
    raise AssertionError("nothing should run when staging is off")
bridge.find_repo_path = explode
`);
  assert.equal(r.proceed, true);
  assert.equal(r.carry, "");
  assert.deepEqual(r.metrics, []);
});

// ─────────── found by review, not by running ───────────

test("a plan from an earlier run is not claimed as this run's", () => {
  // .planning/ is tracked, so the second ticket in a GSD repo starts from a
  // checkout that already holds a prior phase's plan — and the planning worktree
  // is reused, so a retry starts with the previous attempt's. Without a floor the
  // verdict is plan_written whatever this run did.
  const dir = worktree({ planning: true, planText: "<task>someone else's work</task>" });
  try {
    const future = python(`
import json, time, plan_stage
print(json.dumps({"found": plan_stage.find_plan(${JSON.stringify(dir)}, since=time.time() + 60) is not None,
                  "unscoped": plan_stage.find_plan(${JSON.stringify(dir)}) is not None}))
`);
    assert.equal(future.found, false, "a plan older than the run does not count");
    assert.equal(future.unscoped, true, "…but it is still found when nothing is scoped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale plan no longer swallows the question this run raised", () => {
  const dir = worktree({ planning: true, planText: "<task>old</task>" });
  try {
    const v = python(`
import json, time, plan_stage
out = '<mc-questions>[{"question": "Which licence?"}]</mc-questions>'
print(json.dumps(plan_stage.classify(${JSON.stringify(dir)}, out, 0, since=time.time() + 60)))
`);
    // A plan outranks a question, so an unscoped match discarded it silently.
    assert.equal(v.outcome, "questions_raised");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a different question in a later round gets a different id", () => {
  const r = python(`
import json, plan_stage
first = plan_stage.parse_questions('<mc-questions>[{"question": "Which font licence?"}]</mc-questions>')
second = plan_stage.parse_questions('<mc-questions>[{"question": "What page size?"}]</mc-questions>')
same = plan_stage.parse_questions('<mc-questions>[{"question": "which   FONT licence?"}]</mc-questions>')
print(json.dumps({"first": first[0]["id"], "second": second[0]["id"], "same": same[0]["id"]}))
`);
  // Positional ids meant round two's question inherited round one's answer: it read
  // as settled, reached nobody, and went to the planner as a binding decision.
  assert.notEqual(r.first, r.second);
  // The same question re-asked is the same question, and still collapses onto its answer.
  assert.equal(r.first, r.same);
});

// ─────────── the plan has to reach the builder ───────────
// Otherwise the stage is a duplicate cost, not a precondition: the plan sat in
// worktrees/planning-<id> while the agent got a fresh worktree and a prompt telling
// it to run /gsd-plan-phase itself — paying twice, and building against a spec no
// human ever saw.

test("a carried plan forbids re-planning instead of asking for one", () => {
  const r = python(`
import json, bridge
task = {"title": "MET-635", "description": "d", "id": "t1"}
print(json.dumps({
    "ready": bridge.generate_prompt(task, "", "p", "r", plan_ready=True),
    "fresh": bridge.generate_prompt(task, "", "p", "r", plan_ready=False),
}))
`);
  assert.match(r.ready, /already exists/);
  assert.match(r.ready, /do NOT write a new plan/i);
  assert.match(r.ready, /STOP and say so rather than\s+replacing it/);
  // Without a plan it must still be told to make one — including the precondition
  // that /gsd-plan-phase cannot plan into a repo with no .planning/.
  assert.match(r.fresh, /gsd-new-project/);
  assert.doesNotMatch(r.fresh, /already exists/);
});

test("only a real plan is carried forward", () => {
  const r = python(`
import json, pathlib, bridge
bridge._stage_planning_enabled = lambda: True
bridge.find_repo_path = lambda project, repo: pathlib.Path("/tmp")
bridge._planning_worktree = lambda task, repo_path: pathlib.Path("/tmp/planning-x")
bridge._build_triage_context = lambda tid: ""
bridge.record_step_attempt = lambda *a, **k: None
bridge.mc_log_activity = lambda *a, **k: None
bridge._planning_job_path = lambda tid: pathlib.Path("/tmp/nonexistent-job.json")
bridge.route_plan_stage_outcome = lambda task, v: v["outcome"] == "plan_written"

out = {}
for outcome in ("plan_written", "questions_raised", "error"):
    bridge._read_planning_job = (lambda o: lambda path: {"state": "done",
        "verdict": {"outcome": o, "stages": []}})(outcome)
    out[outcome] = bridge.stage_planning({"id": "t1"}, [{"project": "p", "repo": "r"}])
print(json.dumps(out))
`);
  assert.deepEqual(r.plan_written, [true, "/tmp/planning-x"]);
  // A run that raised a question or failed has no plan to hand on — carrying the
  // worktree anyway would tell the agent to follow a plan that is not there.
  assert.deepEqual(r.questions_raised, [false, ""]);
  assert.deepEqual(r.error, [false, ""]);
});

test("staging turned off carries nothing and still proceeds", () => {
  const r = python(`
import json, bridge
bridge._stage_planning_enabled = lambda: False
print(json.dumps(bridge.stage_planning({"id": "t1"}, [{"project": "p", "repo": "r"}])))
`);
  assert.deepEqual(r, [true, ""]);
});

test("the spawn script copies the plan in, and only when there is one", () => {
  const sh = readFileSync(new URL("../swarm/spawn-agent.sh", import.meta.url), "utf8");
  assert.match(sh, /MC_PLANNING_DIR/);
  // Guarded on the directory actually existing, and never fatal: a spawn that
  // cannot copy should still run, planning for itself.
  assert.match(sh, /\[ -d "\$\{MC_PLANNING_DIR\}\/\.planning" \]/);
  assert.match(sh, /agent will plan for itself/);
});

test("planning's model is a setting, not whatever the CLI defaults to", () => {
  // The stage passed no --model at all, so planning_model in swarm-config.json had
  // no effect and the model in use would move if the CLI's default ever did. That is
  // the one setting Phase 0 must control.
  const r = python(`
import json, plan_stage
seen = {}
def fake_run(worktree, prompt, transcript, timeout, model="", provider="", effort=""):
    seen.setdefault("models", []).append(model)
    return {"output": "", "returncode": 0, "timed_out": False, "duration_s": 1, "failed": None}
plan_stage._run_cli = fake_run
plan_stage._configured_model = lambda role: "configured-" + role
plan_stage.gsd_backend.project_initialised = lambda w: False
plan_stage.gsd_backend.workflow_ran = lambda w: (False, "")
plan_stage.plan_in_worktree("/tmp", {"id": "t1"})
print(json.dumps(seen))
`);
  assert.ok(r.models.length >= 1);
  assert.ok(r.models.every((m) => m === "configured-planning"), JSON.stringify(r.models));
});

test("an explicit model beats the configured one", () => {
  const r = python(`
import json, plan_stage
seen = []
plan_stage._run_cli = lambda w, p, t, to, model="", provider="", effort="": (seen.append(model),
    {"output": "", "returncode": 0, "timed_out": False, "duration_s": 1, "failed": None})[1]
plan_stage._configured_model = lambda role: "configured"
plan_stage.gsd_backend.project_initialised = lambda w: False
plan_stage.gsd_backend.workflow_ran = lambda w: (False, "")
plan_stage.plan_in_worktree("/tmp", {"id": "t1"}, model="explicit")
print(json.dumps(seen))
`);
  assert.ok(r.every((m) => m === "explicit"));
});

// ─────────── planning must not freeze the daemon ───────────
// Inline, stage_planning ran plan_in_worktree inside the single poll loop, so the
// whole bridge stopped for the length of a planning run: no question servicing, no
// step dispatch, no escalation handling. One task's planning froze every other task.

const asyncStage = (program) => python(`
import json, bridge
calls = {"started": None, "metrics": [], "routed": None, "activities": 0}
bridge._build_triage_context = lambda tid: ""
bridge.record_step_attempt = lambda tid, n, rec: calls["metrics"].append(rec["outcome"])
bridge.mc_log_activity = lambda *a, **k: calls.__setitem__("activities", calls["activities"] + 1)
bridge.route_plan_stage_outcome = lambda task, v: calls.__setitem__("routed", v.get("outcome")) or (v.get("outcome") == "plan_written")
bridge._stage_planning_enabled = lambda: True
import pathlib
bridge.find_repo_path = lambda project, repo: pathlib.Path("/tmp")
bridge._planning_worktree = lambda task, repo_path: pathlib.Path("/tmp/planning-x")
${program}
proceed, carry = bridge.stage_planning({"id": "task-async"}, [{"project": "p", "repo": "r"}])
print(json.dumps({"proceed": proceed, "carry": carry, **calls}))
`);

test("the first tick starts planning and returns instead of blocking", () => {
  const r = asyncStage(`
started = {}
bridge._read_planning_job = lambda path: None
bridge._start_planning_job = lambda task, wt, job: started.setdefault("yes", True)
calls["started"] = True
`);
  // Not dispatched yet — but nothing was routed either, because there is no verdict.
  assert.equal(r.proceed, false);
  assert.equal(r.routed, null, "a wait is not a verdict");
});

test("a later tick waits while the job is alive, without re-launching it", () => {
  const r = asyncStage(`
bridge._read_planning_job = lambda path: {"state": "running", "pid": 4242}
bridge._pid_alive = lambda pid: True
def explode(*a, **k):
    raise AssertionError("a running job must not be started twice")
bridge._start_planning_job = explode
`);
  assert.equal(r.proceed, false);
  assert.deepEqual(r.metrics, [], "waiting is not an outcome worth recording");
});

test("a job that died with its daemon fails open rather than wedging the task", () => {
  const r = asyncStage(`
import pathlib
bridge._read_planning_job = lambda path: {"state": "running", "pid": 999999}
bridge._pid_alive = lambda pid: False
bridge._planning_job_path = lambda tid: pathlib.Path("/tmp/nonexistent-job.json")
`);
  assert.equal(r.proceed, true, "the queue keeps moving");
  assert.deepEqual(r.metrics, ["plan_stage_skipped"], "and it is visible in the metrics");
});

test("a finished job is routed and its plan handed on", () => {
  const r = asyncStage(`
import pathlib
bridge._read_planning_job = lambda path: {"state": "done",
    "verdict": {"outcome": "plan_written", "stages": [{"stage": "plan", "outcome": "plan_written",
                                                       "duration_s": 12, "reason": "ok"}]}}
bridge._planning_job_path = lambda tid: pathlib.Path("/tmp/nonexistent-job.json")
`);
  assert.equal(r.proceed, true);
  assert.equal(r.routed, "plan_written");
  assert.equal(r.carry, "/tmp/planning-x", "the agent gets the plan that was written");
});

test("the runner leaves a verdict even when planning throws", () => {
  const r = python(`
import json, os, tempfile, plan_stage_runner, plan_stage
job = os.path.join(tempfile.mkdtemp(), "j.json")
open(job, "w").write(json.dumps({"task": {"id": "t"}, "worktree": "/tmp", "state": "running"}))
def boom(*a, **k):
    raise RuntimeError("planner exploded")
plan_stage.plan_in_worktree = boom
plan_stage_runner.main([job])
print(json.dumps(json.load(open(job))))
`);
  // A crash that leaves no verdict would look identical to a job still running.
  assert.equal(r.state, "done");
  assert.equal(r.verdict.outcome, "error");
  assert.match(r.verdict.reason, /crashed/);
});

// ─────────── planning is a contract, not a runtime ───────────
// GSD ships as Claude Code skills, so /gsd-plan-phase resolves there and nowhere
// else. But the workflows are markdown documents, and any agent that can read a file
// can follow one — so a runtime without the skill is handed the document instead.
// The verdict never reads the transcript to decide whether a plan exists, so a plan
// written by codex counts exactly as much as one written by claude.

test("each runtime gets an invocation it can actually run", () => {
  const r = python(`
import json, plan_stage
out = {}
for prov in ("claude", "claude-cli", "codex", "codex-cli"):
    out[prov] = plan_stage.build_command(prov, "PROMPT", "m5", "high")
try:
    plan_stage.build_command("nonsense", "PROMPT")
    out["nonsense"] = "accepted"
except ValueError as e:
    out["nonsense"] = str(e)
print(json.dumps(out))
`);
  assert.equal(r.claude[0], "claude");
  assert.ok(r.claude.includes("--model") && r.claude.includes("m5"));
  assert.equal(r.codex[0], "codex");
  assert.ok(r.codex.includes("model_reasoning_effort=high"), "codex takes an effort setting");
  // Planning writes .planning/ — the read-only sandbox MC uses for Q&A will not do.
  assert.ok(r.codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(r["claude-cli"][0], "claude", "config spells it claude-cli");
  assert.match(r.nonsense, /unknown planning provider/, "an unknown runtime is refused, not guessed at");
});

test("a runtime without skills is handed the workflow document", () => {
  const r = python(`
import json, plan_stage
print(json.dumps({
  "claude": plan_stage.build_init_prompt({"title": "t"}, provider="claude"),
  "codex": plan_stage.build_init_prompt({"title": "t"}, provider="codex"),
}))
`);
  assert.match(r.claude, /Run `\/gsd-new-project/, "claude invokes the skill");
  assert.doesNotMatch(r.claude, /Read `.*new-project\.md/, "and does not need the document");

  assert.match(r.codex, /has no `\/gsd-new-project --auto` skill/);
  assert.match(r.codex, /Read `.*workflows\/new-project\.md` in full/);
  // A runtime that cannot spawn GSD's sub-agents must do the work, not skip it.
  assert.match(r.codex, /do that step's work\s+yourself/);
  // And must not substitute its own format — the thesis rests on GSD's decomposition.
  assert.match(r.codex, /Do not invent your own planning format/);
});

test("a workflow that cannot be found is reported, not improvised around", () => {
  const r = python(`
import json, plan_stage
plan_stage.gsd_backend.workflow_path = lambda cmd: None
print(json.dumps({"text": plan_stage.workflow_instruction("codex", "/gsd-plan-phase")}))
`);
  // Letting it plan some other way would produce output that counts as GSD's and is not.
  assert.match(r.text, /Stop and report/);
});

test("the provider is a setting, and the verdict does not depend on it", () => {
  const dir = worktree({ planning: true, planText: "<task>written by whichever runtime</task>" });
  try {
    const r = python(`
import json, plan_stage
seen = []
plan_stage._run_cli = lambda w, p, t, to, model="", provider="", effort="": (
    seen.append({"provider": provider, "effort": effort, "model": model}),
    {"output": "", "returncode": 0, "timed_out": False, "duration_s": 1, "failed": None})[1]
plan_stage._planning_provider = lambda: "codex"
plan_stage._planning_effort = lambda: "high"
plan_stage._configured_model = lambda role: "gpt-x"
v = plan_stage.plan_in_worktree(${JSON.stringify(dir)}, {"id": "t1"})
print(json.dumps({"outcome": v["outcome"], "calls": seen}))
`);
    assert.ok(r.calls.every((c) => c.provider === "codex"), JSON.stringify(r.calls));
    assert.ok(r.calls.every((c) => c.effort === "high"));
    // find_plan reads the filesystem, so the artefact is the contract.
    assert.equal(r.outcome, "plan_written");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the planner is told to block while waiting, not to poll", () => {
  // GSD backgrounds its planner and says "repeat gsd_stall_watch while waiting".
  // On Claude Code each repeat is a turn with a full context re-read: 485 turns of
  // `echo pN` on MET-635, ~36% of the run, ~97M tokens spent idling.
  const r = python(`
import json, plan_stage
print(json.dumps({"plan": plan_stage.build_prompt({"title": "t"}, provider="claude"),
                  "init": plan_stage.build_init_prompt({"title": "t"}, provider="claude")}))
`);
  assert.match(r.plan, /single shell command that blocks/);
  assert.match(r.plan, /one blocking call costs one turn/i);
  // Naming the actual failure, because the model invented it once already.
  assert.match(r.plan, /echo p1/);
  assert.match(r.plan, /stall-detection helper if it defines one/);
  // Setup does not spawn background subagents, so it does not need the rule.
  assert.doesNotMatch(r.init, /single shell command that blocks/);
});
