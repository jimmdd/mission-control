// GSD sizes a task so a competent model can pass it, and every task carries its own
// check. That makes a verify failure evidence about this task rather than about the
// plan — so the retry runs on a stronger runtime instead of the same one.
//
// Separately, a runtime that refuses on quota never attempted the work at all, so it
// must not be charged against the retry budget.
//
// Every attempt is recorded, passes included: first-try pass rate and escalation rate
// are the two numbers the whole model-routing thesis turns on.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

let mcHome;

test.before(() => {
  mcHome = mkdtempSync(join(tmpdir(), "mc-esc-"));
  mkdirSync(join(mcHome, "swarm"), { recursive: true });
});

test.after(() => {
  if (mcHome) rmSync(mcHome, { recursive: true, force: true });
});

/** Write planner config, then run a python program against bridge. */
function python(program, plannerCfg) {
  if (plannerCfg) {
    writeFileSync(join(mcHome, "swarm", "swarm-config.json"),
      JSON.stringify({ planner: plannerCfg }));
  }
  const stdout = execFileSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)})\n${program}`], {
    env: { ...process.env, MC_HOME: mcHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

const LADDER = {
  escalation_ladder: { claude: ["claude", "claude-opus5", "codex"] },
  escalation_ladder_default: ["pi", "claude"],
};

test("each attempt climbs one rung of the ladder", () => {
  const picks = python(`
import json, bridge
print(json.dumps([bridge._profile_for_attempt("claude", n) for n in range(3)]))
`, LADDER);
  assert.deepEqual(picks, ["claude", "claude-opus5", "codex"]);
});

test("attempts past the top of the ladder stay on the strongest runtime", () => {
  const picks = python(`
import json, bridge
print(json.dumps([bridge._profile_for_attempt("claude", n) for n in (3, 9)]))
`, LADDER);
  assert.deepEqual(picks, ["codex", "codex"]);
});

test("a profile with no ladder of its own uses the default", () => {
  const picks = python(`
import json, bridge
print(json.dumps([bridge._profile_for_attempt("codex", n) for n in range(3)]))
`, LADDER);
  // The starting profile always leads, even when the default ladder omits it —
  // escalation says where to go next, never where to begin.
  assert.equal(picks[0], "codex");
  assert.deepEqual(picks.slice(1), ["pi", "claude"]);
});

test("no ladder configured means the runtime never changes", () => {
  const picks = python(`
import json, bridge
print(json.dumps([bridge._profile_for_attempt("claude", n) for n in range(4)]))
`, { escalation_ladder: {}, escalation_ladder_default: [] });
  assert.deepEqual(picks, ["claude", "claude", "claude", "claude"]);
});

test("rate-limit refusals are recognised across the phrasings runtimes use", () => {
  const verdicts = python(`
import json, bridge
cases = [
    "Error: rate limit exceeded, retry after 60s",
    "HTTP 429 Too Many Requests",
    "You have hit your usage limit for this model",
    "{'type': 'overloaded_error'}",
    "insufficient_quota",
    "Build failed: 3 tests failing",
    "TypeError: cannot read property of undefined",
]
print(json.dumps([bridge._looks_rate_limited(c) for c in cases]))
`, LADDER);
  assert.deepEqual(verdicts, [true, true, true, true, true, false, false]);
});

test("a real build failure is never mistaken for a quota refusal", () => {
  // The distinction decides whether a retry is spent, so a false positive here
  // would let a genuinely failing step retry forever.
  const verdict = python(`
import json, bridge
print(json.dumps(bridge._looks_rate_limited("FAIL src/app.test.ts — expected 1304 got 1200")))
`, LADDER);
  assert.equal(verdict, false);
});

test("attempts are recorded as one JSON object per line", () => {
  const rows = python(`
import json, bridge
bridge.record_step_attempt("task-1", 2, {"outcome": "passed", "attempt": 1, "profile": "claude"})
bridge.record_step_attempt("task-1", 3, {"outcome": "failed_verification", "attempt": 2, "profile": "codex"})
path = bridge.MC_HOME / "bridge" / "metrics" / "step-attempts.jsonl"
print(json.dumps([json.loads(l) for l in path.read_text().splitlines() if l.strip()]))
`, LADDER);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].outcome, "passed");
  assert.equal(rows[1].profile, "codex");
  // Every row has to stand alone for later analysis to correlate anything.
  for (const r of rows) {
    assert.ok(r.task_id && r.step !== undefined && r.at, "row must carry task, step and time");
  }
});

test("a metrics failure never breaks the run", () => {
  const ok = python(`
import json, bridge, pathlib
# Point the metrics dir at something that cannot be created.
bridge.MC_HOME = pathlib.Path("/dev/null/nope")
bridge.record_step_attempt("t", 1, {"outcome": "passed"})
print(json.dumps(True))
`, LADDER);
  assert.equal(ok, true);
});

test("task shape is observable properties only, never a difficulty judgement", () => {
  const shape = python(`
import json, bridge
print(json.dumps(bridge._step_shape({
    "category": "quick",
    "files": ["a.ts", "b.ts"],
    "acceptance_criteria": ["x", "y", "z"],
    "verify_command": "bun test",
    "depends_on": [1],
})))
`, LADDER);
  assert.deepEqual(shape, {
    category: "quick", file_count: 2, criteria_count: 3,
    has_verify_command: true, depends_on_count: 1,
  });
  // No confidence/difficulty/complexity field: GSD forbids the planner from rating
  // difficulty, and self-rated confidence is a weak predictor of outcome.
  assert.ok(!("difficulty" in shape) && !("confidence" in shape));
});

// A gate is only meaningful if it can pass. A verify_command that fails on unmodified
// code fails every attempt too — so the step burns its retry budget, escalates to the
// scarcest model, still fails, and the metrics read "the model could not do it".
// Observed for real: a plan's build command failed identically on the base commit and
// on the agent's work, because the app needed build-time env the worktree lacked.

test("a gate that passes on unmodified code is usable", () => {
  const r = python(`
import json, planner, tempfile
print(json.dumps(planner.check_verify_command_baseline("true", tempfile.gettempdir())))
`, LADDER);
  assert.equal(r.runnable, true);
  assert.equal(r.exit_code, 0);
});

test("a gate that fails on unmodified code is reported unusable, with its output", () => {
  const r = python(`
import json, planner, tempfile
print(json.dumps(planner.check_verify_command_baseline(
    "echo 'PUBLIC_API_URL is not exported' >&2; exit 1", tempfile.gettempdir())))
`, LADDER);
  assert.equal(r.runnable, false);
  assert.equal(r.exit_code, 1);
  // The reason has to carry the real error, or a human cannot fix the gate.
  assert.match(r.reason, /PUBLIC_API_URL is not exported/);
  assert.match(r.reason, /cannot distinguish good work from bad/);
});

test("a gate that cannot be run at all is unusable rather than passing", () => {
  const r = python(`
import json, planner
print(json.dumps(planner.check_verify_command_baseline("true", "/no/such/dir")))
`, LADDER);
  assert.equal(r.runnable, false);
  assert.equal(r.exit_code, null);
});

test("a hanging gate is unusable rather than blocking forever", () => {
  const r = python(`
import json, planner, tempfile
print(json.dumps(planner.check_verify_command_baseline("sleep 30", tempfile.gettempdir(), timeout=1)))
`, LADDER);
  assert.equal(r.runnable, false);
  assert.match(r.reason, /timed out/);
});

test("gate checking can be turned off for a repo that cannot build locally", () => {
  const on = python(`
import json, bridge
print(json.dumps(bridge._gate_check_enabled()))
`, { validate_gates: true });
  const off = python(`
import json, bridge
print(json.dumps(bridge._gate_check_enabled()))
`, { validate_gates: false });
  assert.equal(on, true);
  assert.equal(off, false);
});

// "Do not publish this work" had no expression: draft-vs-ready was the only PR
// control, and every agent prompt ends by telling the agent to push and open a PR.
// Relying on a broken push URL to stop that is luck, not a control.

test("no-PR mode is recognised from environment, config, triage state, or description", () => {
  const verdicts = python(`
import json, os, bridge
cases = {}
cases["default"] = bridge._pr_is_disabled({"description": "normal ticket"})
cases["description"] = bridge._pr_is_disabled({"description": "do the thing\\nPR: none\\n"})
cases["no_pr_line"] = bridge._pr_is_disabled({"description": "No PR"})
cases["triage_state"] = bridge._pr_is_disabled({"triage_state": json.dumps({"no_pr": True})})
os.environ["MC_NO_PR"] = "1"
cases["from_environment"] = bridge._pr_is_disabled({"description": "normal ticket"})
del os.environ["MC_NO_PR"]
print(json.dumps(cases))
`, LADDER);
  assert.equal(verdicts.default, false);
  assert.equal(verdicts.description, true);
  assert.equal(verdicts.no_pr_line, true);
  assert.equal(verdicts.triage_state, true);
  assert.equal(verdicts.from_environment, true);
});

test("a no-PR prompt forbids push and overrides the earlier PR instruction", () => {
  const prompt = python(`
import json, pathlib, tempfile, bridge
bridge.SWARM_DIR = pathlib.Path(tempfile.mkdtemp())
bridge.subprocess = type("S", (), {
    "run": staticmethod(lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()),
    "TimeoutExpired": Exception, "DEVNULL": None,
})
bridge.detect_base_branch = lambda p: "origin/main"
bridge.spawn_agent("t", "lbl", pathlib.Path("/tmp"), "BODY", no_pr=True)
print(json.dumps((bridge.SWARM_DIR / "prompts" / "lbl.md").read_text()))
`, LADDER);
  assert.match(prompt, /Do not run `git push`/);
  assert.match(prompt, /Do not run `gh pr create`/);
  // The body may still carry a PR step; the footer has to win explicitly.
  assert.match(prompt, /this section overrides it/);
});

test("normal mode still instructs a draft PR against the right base", () => {
  const prompt = python(`
import json, pathlib, tempfile, bridge
bridge.SWARM_DIR = pathlib.Path(tempfile.mkdtemp())
bridge.subprocess = type("S", (), {
    "run": staticmethod(lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()),
    "TimeoutExpired": Exception, "DEVNULL": None,
})
bridge.spawn_agent("t", "lbl", pathlib.Path("/tmp"), "BODY", base_branch="origin/coda/new-ui", draft_pr=True)
print(json.dumps((bridge.SWARM_DIR / "prompts" / "lbl.md").read_text()))
`, LADDER);
  assert.match(prompt, /gh pr create --draft --base coda\/new-ui/);
  assert.doesNotMatch(prompt, /Do not run `git push`/);
});
