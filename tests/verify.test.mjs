// Step verification is deterministic: it runs the step's verify_command in the
// agent's worktree and judges by exit code. The model judge is a fallback for
// steps that carry no runnable command, never the primary gate.
//
// planner.py is Python, so each case drives it through a short python3 program.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

let mcHome;
let workdir;

// A scratch MC_HOME keeps planner config off the developer's real ~/.mission-control.
test.before(() => {
  mcHome = mkdtempSync(join(tmpdir(), "mc-verify-home-"));
  workdir = mkdtempSync(join(tmpdir(), "mc-verify-work-"));
});

test.after(() => {
  for (const dir of [mcHome, workdir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Run verify_step_completion and return the parsed result dict. */
function verify(step, agentOutput, cwd) {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
from planner import verify_step_completion
step, output, cwd = json.loads(sys.stdin.read())
print(json.dumps(verify_step_completion(step, output, cwd=cwd)))
`;
  const stdout = execFileSync("python3", ["-c", program], {
    input: JSON.stringify([step, agentOutput, cwd ?? null]),
    env: { ...process.env, MC_HOME: mcHome },
    encoding: "utf8",
    // stderr carries planner's logging; keep it out of the test output.
    stdio: ["pipe", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

const criteria = ["The thing works"];

test("verify_command exiting 0 passes without a model", () => {
  const result = verify(
    { title: "t", acceptance_criteria: criteria, verify_command: "true" },
    "",
    workdir,
  );
  assert.equal(result.passed, true);
  assert.equal(result.verified_by, "command");
  assert.equal(result.exit_code, 0);
});

test("verify_command exiting non-zero fails, carrying the exit code", () => {
  const result = verify(
    { title: "t", acceptance_criteria: criteria, verify_command: "exit 3" },
    "the agent claimed success",
    workdir,
  );
  assert.equal(result.passed, false);
  assert.equal(result.verified_by, "command");
  assert.equal(result.exit_code, 3);
});

test("a failing verify_command reports its output in the reason", () => {
  const result = verify(
    { title: "t", acceptance_criteria: criteria, verify_command: "echo 'boom' >&2; exit 1" },
    "",
    workdir,
  );
  assert.equal(result.passed, false);
  assert.match(result.results[0].reason, /boom/);
});

test("a step with no acceptance criteria passes trivially", () => {
  const result = verify({ title: "t" }, "", workdir);
  assert.equal(result.passed, true);
});

test("no verify_command and no agent output fails closed", () => {
  // The latent bug this guards: such a step used to be marked done unverified.
  const result = verify({ title: "t", acceptance_criteria: criteria }, "", workdir);
  assert.equal(result.passed, false);
  assert.equal(result.verified_by, "none");
});

test("a missing worktree falls through rather than reporting a pass", () => {
  const result = verify(
    { title: "t", acceptance_criteria: criteria, verify_command: "true" },
    "",
    join(workdir, "does-not-exist"),
  );
  assert.equal(result.passed, false);
  assert.notEqual(result.verified_by, "command");
});

test("a verify_command that hangs fails on timeout", () => {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import planner
planner._verify_timeout = lambda: 10  # floor of the configured clamp
step = {"title": "t", "acceptance_criteria": ["never"], "verify_command": "sleep 30"}
print(json.dumps(planner.verify_step_completion(step, "", cwd=${JSON.stringify(workdir)})))
`;
  const stdout = execFileSync("python3", ["-c", program], {
    env: { ...process.env, MC_HOME: mcHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const result = JSON.parse(stdout);
  assert.equal(result.passed, false);
  assert.match(result.results[0].reason, /timed out/);
});
