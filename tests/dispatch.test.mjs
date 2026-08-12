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

test("concurrent step updates do not overwrite each other", () => {
  // The progress file holds every step, so an unlocked read-modify-write loses
  // whatever another step wrote in between. Twenty processes, one step each.
  const STEPS = 20;
  const plan = { steps: Array.from({ length: STEPS }, (_, i) => ({ step: i + 1, title: `s${i + 1}` })) };
  const result = python(`
import json, os
from planner import init_progress, load_progress, update_step_progress

plan = json.loads(${JSON.stringify(JSON.stringify(plan))})
task = "t-race"
init_progress(task, plan)

children = []
for n in range(1, ${STEPS} + 1):
    pid = os.fork()
    if pid == 0:
        update_step_progress(task, n, {"status": "completed", "outcome": "s%d" % n})
        os._exit(0)
    children.append(pid)
for pid in children:
    os.waitpid(pid, 0)

steps = load_progress(task)["steps"]
print(json.dumps(sorted(int(k) for k, v in steps.items() if v["status"] != "completed")))
`);
  assert.deepEqual(result, [], "every step's update must survive");
});

/** Run spawn-agent.sh directly and return its exit code. */
function spawnExitCode(env) {
  writeFileSync(join(mcHome, "swarm", "active-tasks.json"), JSON.stringify(REGISTRY));
  try {
    execFileSync(join(SWARM, "spawn-agent.sh"), ["lbl", mcHome, "feat/lbl", "claude", "d"], {
      env: { ...process.env, MC_HOME: mcHome, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    return e.status;
  }
}

test("spawn-agent.sh refuses to start an agent when memory is at the ceiling", () => {
  // Exit 3 is "full, retry later" — distinct from exit 2, "this spawn is broken".
  // The ceiling is memory now, not a count: four small agents and four each holding
  // a large repo in context are not the same load.
  assert.equal(spawnExitCode({ MC_MEMORY_CEILING: "0.001" }), 3);
  assert.notEqual(spawnExitCode({ MC_MEMORY_CEILING: "0.999" }), 3);
});

test("registry entries whose agent is gone do not hold a slot", () => {
  // The registry fixture is all dead entries — no tmux sessions behind them. Under
  // the old count they filled the ceiling and the machine refused to work while
  // nothing at all was running.
  assert.notEqual(spawnExitCode({ MC_MAX_CONCURRENT_AGENTS: "2", MC_MEMORY_CEILING: "0.999" }), 3);
});

test("a full machine is a wait, not a spawn failure", () => {
  // Conflating the two would raise a checkpoint asking a human to check that the
  // agent CLI is logged in, and burn one of three attempts, because the box was busy.
  const result = python(`
import json, bridge

calls = []
bridge.mc_update_task = lambda task_id, updates: calls.append(("update", updates))
bridge.mc_log_activity = lambda task_id, kind, msg, agent_id=None: calls.append(("log", msg))
bridge.mc_request = lambda *a, **k: []
bridge.fetch_task_activities = lambda task_id: []

bridge._handle_spawn_refusal("task", bridge.AT_CAPACITY, "repo")
capacity = list(calls)
calls.clear()
bridge._handle_spawn_refusal("task", False, "repo")
print(json.dumps({"capacity": capacity, "broken": calls}))
`);
  const messages = result.capacity.filter(([kind]) => kind === "log").map(([, m]) => m);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Waiting for a free agent slot/);
  // The retry counter keys off this phrase, so waiting must never spend an attempt.
  assert.doesNotMatch(messages[0], /Agent spawn failed/);

  const broken = result.broken.filter(([kind]) => kind === "log").map(([, m]) => m);
  assert.match(broken.join("\n"), /Agent spawn failed/);
});

test("a step blocked by an unusable gate is not offered for dispatch", () => {
  // Blocked means a human has to fix the gate; re-offering it would spend agents
  // proving what the base commit already proves. It still settles its group so the
  // rest of the plan keeps moving.
  assert.deepEqual(nextSteps(GROUPED, { 1: "blocked" }), [2, 3]);
  assert.deepEqual(nextSteps(GROUPED, { 1: "completed", 2: "blocked" }), [3]);
  assert.deepEqual(nextSteps(GROUPED, { 1: "completed", 2: "blocked", 3: "blocked" }), [4]);
});
