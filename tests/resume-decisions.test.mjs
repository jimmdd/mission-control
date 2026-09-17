// The agent prompt promises that a human's checkpoint decision "appears in this
// task's activity history. Read it on resume." The prompt is regenerated from the
// ticket on every spawn and carried none of it, so a resumed agent was blind to the
// answer it had stopped for and re-raised the same checkpoint. MET-680 asked whether
// to use the live Paper URLs or the plan's placeholders; without this it would have
// asked a second time and stalled again.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

function python(program) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
sys.argv = ["test"]
import bridge
${program}
`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}

test("only decided checkpoints carrying a response are handed to the next spawn", () => {
  const result = python(`
bridge.mc_request = lambda method, path: [
    {"status": "pending",  "prompt": "still open",   "response": None,        "created_at": "2026-01-01T00:00:00Z"},
    {"status": "answered", "prompt": "no response",  "response": "   ",       "created_at": "2026-01-02T00:00:00Z"},
    {"status": "answered", "prompt": "second",       "response": "B",         "resolved_at": "2026-01-05T00:00:00Z"},
    {"status": "approved", "prompt": "first",        "response": "A",         "resolved_at": "2026-01-04T00:00:00Z"},
    {"status": "rejected", "prompt": "third",        "response": "no",        "resolved_at": "2026-01-06T00:00:00Z"},
]
print(json.dumps([c["prompt"] for c in bridge.resolved_decisions("t1")]))
`);
  // Pending and blank-response checkpoints are not decisions; the rest are oldest first.
  assert.deepEqual(result, ["first", "second", "third"]);
});

test("a lost checkpoints call degrades to no decisions rather than failing the spawn", () => {
  const result = python(`
def boom(method, path):
    raise RuntimeError("mc unreachable")
bridge.mc_request = boom
print(json.dumps(bridge.resolved_decisions("t1")))
`);
  assert.deepEqual(result, []);
});

test("the rendered section states the decision and forbids re-asking it", () => {
  const result = python(`
section = bridge.render_decisions([{
    "status": "answered",
    "prompt": "Use the live Paper URLs   or\\n the plan's placeholders?",
    "response": "A - use the live URLs.",
    "resolved_at": "2026-08-31T14:40:44Z",
}])
print(json.dumps({"section": section, "empty": bridge.render_decisions([])}))
`);
  assert.equal(result.empty, "", "no decisions must add nothing to the prompt");
  assert.match(result.section, /## Decisions already made \(MUST FOLLOW\)/);
  assert.match(result.section, /do NOT\nraise a checkpoint asking any of them again/);
  assert.match(result.section, /the decision wins — amend the plan to match it/);
  // The question is re-flowed onto one line so it cannot break the section's shape.
  assert.match(result.section, /Use the live Paper URLs or the plan's placeholders\?/);
  assert.match(result.section, /A - use the live URLs\./);
});

test("generate_prompt carries the decisions into the agent's prompt", () => {
  const result = python(`
task = {"id": "t1", "title": "T", "description": "D", "external_url": ""}
without = bridge.generate_prompt(task, "ctx", "proj", "repo")
with_decision = bridge.generate_prompt(task, "ctx", "proj", "repo", decisions=[
    {"status": "answered", "prompt": "placeholders?", "response": "use live URLs", "resolved_at": "2026-08-31T14:40:44Z"},
])
print(json.dumps({"without": "Decisions already made" in without,
                  "with": "Decisions already made" in with_decision,
                  "answer": "use live URLs" in with_decision}))
`);
  assert.equal(result.without, false, "a task with no decisions gets no such section");
  assert.equal(result.with, true);
  assert.equal(result.answer, true);
});

test("new and staged agents receive the evidence storage policy without requiring PR publication", () => {
  const result = python(`
import planner
from evidence_policy import EVIDENCE_POLICY
task = {"id": "t1", "title": "MET-1", "description": ""}
step = {"step": 1, "title": "Implement", "description": "fix", "files": []}
print(json.dumps({
    "normal": EVIDENCE_POLICY in bridge.generate_prompt(task, "", "p", "r"),
    "ready": EVIDENCE_POLICY in bridge.generate_prompt(task, "", "p", "r", plan_ready=True),
    "step": EVIDENCE_POLICY in planner.build_step_prompt(task, step, {"total_steps": 1}),
    "policy": EVIDENCE_POLICY,
}))
`);
  assert.equal(result.normal, true);
  assert.equal(result.ready, true);
  assert.equal(result.step, true);
  assert.match(result.policy, /including branch history/);
  assert.match(result.policy, /No-PR\/local-only tasks must keep evidence local/);
  assert.match(result.policy, /required product assets and intentional test fixtures/);
});
