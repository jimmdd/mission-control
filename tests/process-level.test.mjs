// How much process a ticket needs, decided from what is already known.
//
// The objection that produced this — "I can't imagine a very simple task needs
// this whole process" — is right, and the answer is not a new judgement call.
// Triage already returns `ready`, defined in its own prompt as "enough detail to
// write code". That is a complexity assessment, made per ticket, already paid for.
// What made it unsafe to act on was not the judgement but its invisibility.
//
// So: every input is something MC already has, no extra model call is made, and
// the level always travels with the reasons that produced it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

function assess(kwargs) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import process_level
print(json.dumps(process_level.assess(**json.loads(sys.argv[1]))))
`, JSON.stringify(kwargs)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

function needsConfirm(level, override = "") {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import process_level
print(json.dumps(process_level.requires_confirmation(sys.argv[1], sys.argv[2])))
`, level, override], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

const SIMPLE = {
  questions: [], repos: [{ project: "p", repo: "r" }],
  gate_runnable: true, paths: ["src/greet.js"], pushable: false, triage_ready: true,
};

test("a ticket that is simple on every axis is simple", () => {
  const r = assess(SIMPLE);
  assert.equal(r.level, "simple");
  assert.ok(r.why.length, "a level with no reasons is the unreviewable judgement this replaces");
});

test("an open question outranks everything — nothing is decidable while one is owed", () => {
  const r = assess({ ...SIMPLE, questions: [{ id: "q", question: "which?" }] });
  assert.equal(r.level, "normal");
  assert.match(r.why.join(" "), /1 question\(s\) still open/);
});

test("a deferred question does not count as owed", () => {
  // "Decide later" is an answer about timing. Treating it as open would make the
  // exit a trap, the same way it once parked tickets in planning forever.
  const r = assess({ ...SIMPLE, questions: [{ id: "q", question: "rate limit?", deferred: true }] });
  assert.notEqual(r.level, "normal");
  assert.doesNotMatch(r.why.join(" "), /still open/);
});

test("any single risk is enough to make it careful", () => {
  // The costs are not symmetric: a simple ticket treated carefully wastes a click,
  // a careful one treated simply writes to a database.
  const cases = [
    [{ paths: ["db/migrations/003_add_col.sql"] }, /migrations.*does not undo/],
    [{ repos: [{ repo: "a" }, { repo: "b" }] }, /spans 2 repos/],
    [{ gate_runnable: false }, /no verify command/],
    [{ triage_ready: false }, /did not consider it ready/],
    [{ paths: [".github/workflows/deploy.yml"] }, /does not undo/],
    [{ paths: ["infra/main.tf"] }, /does not undo/],
  ];
  for (const [patch, why] of cases) {
    const r = assess({ ...SIMPLE, ...patch });
    assert.equal(r.level, "careful", `${JSON.stringify(patch)} should be careful`);
    assert.match(r.why.join(" "), why);
  }
});

test("being able to push is enough to lose `simple`", () => {
  // Not a risk in itself, but it is the difference between a mistake that stays on
  // the machine and one that does not.
  const r = assess({ ...SIMPLE, pushable: true });
  assert.equal(r.level, "normal");
  assert.match(r.why.join(" "), /leaves this machine/);
});

test("simple needs every condition, not merely the absence of trouble", () => {
  assert.equal(assess({ ...SIMPLE, gate_runnable: null }).level, "normal",
    "at build time an unknown gate is not a passing one");
  assert.equal(assess({ ...SIMPLE, repos: [] }).level, "normal", "no repo is not one repo");
});

test("the two gates guard different things, so they judge differently", () => {
  // Before planning there is no plan: no gate to probe, no file list to read. And
  // planning writes nothing but .planning/. Treating that absence as risk would
  // mean confirming before an agent may think, which is the objection this answers.
  const prePlan = assess({ ...SIMPLE, gate_runnable: null, paths: [], stage: "plan" });
  assert.equal(prePlan.level, "simple");
  assert.match(prePlan.why.join(" "), /no code is written at this stage/);

  // The same unknowns before code is written are a reason to stop.
  const preBuild = assess({ ...SIMPLE, gate_runnable: null, paths: [], stage: "build" });
  assert.equal(preBuild.level, "normal");

  // A real risk still stops the planning gate — it is not a rubber stamp.
  assert.equal(assess({ ...SIMPLE, stage: "plan", repos: [{ r: 1 }, { r: 2 }] }).level, "careful");
  assert.equal(assess({ ...SIMPLE, stage: "plan", triage_ready: false }).level, "careful");
});

test("only `simple` skips the gate, and an explicit choice outranks the rules", () => {
  assert.equal(needsConfirm("simple"), false);
  assert.equal(needsConfirm("normal"), true);
  assert.equal(needsConfirm("careful"), true);
  // Both directions: someone who marks a ticket careful gets the gate anyway, and
  // someone who marks it simple has said so deliberately, on a ticket, visibly —
  // which is the whole difference from the silent auto-dispatch this replaces.
  assert.equal(needsConfirm("simple", "careful"), true);
  assert.equal(needsConfirm("careful", "simple"), false);
  // A typo must not silently disable the gate.
  assert.equal(needsConfirm("careful", "sImPle!"), true);
});

test("settled questions still allow simple, and say so", () => {
  const r = assess({ ...SIMPLE, questions: [{ id: "q", question: "which?", answer: "that one" }] });
  assert.equal(r.level, "simple");
  assert.match(r.why.join(" "), /1 question\(s\), all settled/);
});

test("a remote on this disk does not count as leaving the machine", () => {
  // The local-bare-origin pattern exists precisely so worktrees resolve and pushes
  // work while nothing reaches the internet. Counting that as pushable would make
  // the safest available setup look like the riskiest.
  const out = execFileSync("python3", ["-c", `
import json, subprocess, sys, tempfile
sys.path.insert(0, ${JSON.stringify(SWARM)})
import bridge
res = {}
for name, url in [("https", "https://github.com/o/r.git"),
                  ("local path", "/tmp/x.git"),
                  ("file url", "file:///tmp/x.git"),
                  ("disabled", "DISABLED://no-push")]:
    d = tempfile.mkdtemp()
    subprocess.run(["git","init","-q",d], check=True)
    subprocess.run(["git","-C",d,"remote","add","origin",url], check=True)
    res[name] = bridge._repo_is_pushable_at(d)
print(json.dumps(res))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const r = JSON.parse(out);
  assert.equal(r["https"], true, "a real remote can carry a mistake off the machine");
  assert.equal(r["local path"], false);
  assert.equal(r["file url"], false);
  assert.equal(r["disabled"], false);
});
