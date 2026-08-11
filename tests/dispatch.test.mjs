// Two limits on what may run at once:
//
//   parallel_groups — the planner's statement about which steps may touch the repo
//   simultaneously. Dependencies alone don't capture file overlap.
//
//   max_concurrent_agents — a ceiling on running agent sessions across every
//   profile. Each session is a worktree plus a CLI process, so this is machine
//   memory, and steps over the line are deferred rather than failed.
//
// planner.py is Python, so each case drives it through a short python3 program.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
const TASK_ID = "t-dispatch";

let mcHome;

test.before(() => {
  mcHome = mkdtempSync(join(tmpdir(), "mc-dispatch-home-"));
  mkdirSync(join(mcHome, "bridge", "progress"), { recursive: true });
  mkdirSync(join(mcHome, "swarm"), { recursive: true });
});

test.after(() => {
  if (mcHome) rmSync(mcHome, { recursive: true, force: true });
});

function python(program, env = {}) {
  const stdout = execFileSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)})\n${program}`], {
    env: { ...process.env, MC_HOME: mcHome, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

/** Write a progress file whose steps carry the given statuses, then ask for next steps. */
function nextSteps(plan, statuses) {
  const progress = {
    task_id: TASK_ID,
    status: "in_progress",
    steps: Object.fromEntries(
      plan.steps.map(s => [String(s.step), { status: statuses[s.step] ?? "pending" }]),
    ),
  };
  writeFileSync(join(mcHome, "bridge", "progress", `${TASK_ID}.json`), JSON.stringify(progress));
  return python(`
import json
from planner import get_next_steps
plan = json.loads(${JSON.stringify(JSON.stringify(plan))})
print(json.dumps([s["step"] for s in get_next_steps(${JSON.stringify(TASK_ID)}, plan)]))
`);
}

// Steps 2 and 3 have no declared dependency on 1 — only the grouping separates them.
const GROUPED = {
  steps: [{ step: 1 }, { step: 2 }, { step: 3 }, { step: 4 }],
  parallel_groups: [[1], [2, 3], [4]],
};

test("only the current parallel group is offered", () => {
  assert.deepEqual(nextSteps(GROUPED, {}), [1]);
});

test("a group opens once every step in the previous one has settled", () => {
  assert.deepEqual(nextSteps(GROUPED, { 1: "completed" }), [2, 3]);
});

test("a failed step still settles its group, so the plan is not stuck", () => {
  assert.deepEqual(nextSteps(GROUPED, { 1: "failed" }), [2, 3]);
});

test("an in-progress step holds its group closed", () => {
  assert.deepEqual(nextSteps(GROUPED, { 1: "completed", 2: "in_progress" }), [3]);
});

test("a grouping that misses a step is ignored rather than stalling it", () => {
  // Step 3 belongs to no group. Withholding it silently would look like a hang,
  // so the whole grouping is dropped and dependency order alone applies.
  const partial = { steps: [{ step: 1 }, { step: 2 }, { step: 3 }], parallel_groups: [[1], [2]] };
  assert.deepEqual(nextSteps(partial, {}), [1, 2, 3]);
});

test("a plan with no groups falls back to dependency order", () => {
  const ungrouped = { steps: [{ step: 1 }, { step: 2, depends_on: [1] }] };
  assert.deepEqual(nextSteps(ungrouped, {}), [1]);
  assert.deepEqual(nextSteps(ungrouped, { 1: "completed" }), [2]);
});

/** Free agent slots given a registry, under a cap supplied by env. */
function slotsFree(registry, cap) {
  writeFileSync(join(mcHome, "swarm", "active-tasks.json"), JSON.stringify(registry));
  return python(`
import json, bridge
print(json.dumps(bridge._agent_slots_free(bridge._load_active_tasks())))
`, cap === undefined ? {} : { MC_MAX_CONCURRENT_AGENTS: String(cap) });
}

const REGISTRY = [
  { id: "a", status: "running" },
  { id: "b", status: "running" },
  { id: "c", status: "completed" },
];

test("no cap configured means no ceiling", () => {
  assert.equal(slotsFree(REGISTRY, 0), null);
});

test("free slots count every running agent, not just this task's", () => {
  assert.equal(slotsFree(REGISTRY, 3), 1);
});

test("a full machine reports zero slots rather than a negative number", () => {
  assert.equal(slotsFree(REGISTRY, 1), 0);
});

test("spawn-agent.sh refuses to start an agent over the global ceiling", () => {
  const registry = join(mcHome, "swarm", "active-tasks.json");
  writeFileSync(registry, JSON.stringify(REGISTRY));
  let code = 0;
  try {
    execFileSync(join(SWARM, "spawn-agent.sh"), ["lbl", mcHome, "feat/lbl", "claude", "d"], {
      env: { ...process.env, MC_HOME: mcHome, MC_MAX_CONCURRENT_AGENTS: "2" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    code = e.status;
  }
  // Exit 3 is "full, retry later" — distinct from exit 2, "this spawn is broken".
  assert.equal(code, 3);
});
