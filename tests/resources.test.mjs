// Agent concurrency was capped by a count. A count is a guess about memory dressed
// up as a policy — and it was computed from registry entries, so three agents that
// had died without being reaped held three of four slots while the machine sat
// idle. The ceiling is memory, so memory is what gets measured.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

function python(program, extraEnv = {}) {
  const stdout = execFileSync("python3", ["-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)})\n${program}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: Object.assign({}, process.env, extraEnv),
  });
  return JSON.parse(stdout);
}

test("this machine's memory is readable and sane", () => {
  const r = python(`
import json, resources
print(json.dumps({"used": resources.memory_used_fraction(), "can_start": resources.can_start_agent()}))
`);
  assert.ok(r.used > 0 && r.used < 1, `implausible reading: ${r.used}`);
  assert.equal(typeof r.can_start, "boolean");
});

test("a machine at the ceiling stops taking agents; below it, no limit", () => {
  const r = python(`
import json, resources
out = {}
for used in (0.5, 0.89, 0.90, 0.99):
    resources.memory_used_fraction = (lambda u: lambda: u)(used)
    out[str(used)] = resources.can_start_agent()
print(json.dumps(out))
`);
  assert.equal(r["0.5"], true);
  assert.equal(r["0.89"], true);
  assert.equal(r["0.9"], false, "at the ceiling is full");
  assert.equal(r["0.99"], false);
});

test("memory that cannot be read does not halt the machine", () => {
  // A monitoring gap is not a capacity problem.
  const r = python(`
import json, resources
resources.memory_used_fraction = lambda: None
print(json.dumps({"can_start": resources.can_start_agent(), "says": resources.describe()}))
`);
  assert.equal(r.can_start, true);
  assert.match(r.says, /not limiting/);
});

test("the ceiling is configurable, and a typo does not brick spawning", () => {
  const ceiling = (value) =>
    python(`import json, resources; print(json.dumps(resources.memory_ceiling()))`,
      { MC_MEMORY_CEILING: value });

  assert.equal(ceiling("0.75"), 0.75);
  // "80" plainly means 80%, not 8000%. Treating it as out of range would mark the
  // machine permanently full.
  assert.equal(ceiling("80"), 0.8);
  assert.equal(ceiling("nonsense"), 0.9);
  assert.equal(ceiling("0"), 0.9);
});

test("with memory free and no count cap, concurrency is unlimited", () => {
  const r = python(`
import json, bridge
bridge.can_start_agent = lambda: True
bridge._max_concurrent_agents = lambda: 0
print(json.dumps({"free": bridge._agent_slots_free([{"status": "running"}] * 50)}))
`);
  // Fifty stale entries used to mean zero slots. Now they mean nothing at all.
  assert.equal(r.free, null);
});

test("memory pressure stops spawning regardless of the count", () => {
  const r = python(`
import json, bridge
bridge.can_start_agent = lambda: False
bridge._max_concurrent_agents = lambda: 0
print(json.dumps({"free": bridge._agent_slots_free([])}))
`);
  assert.equal(r.free, 0);
});

// ─────────── reaping ───────────

test("an agent with no tmux session and a cold heartbeat is reaped", () => {
  const r = python(`
import json, bridge
from datetime import datetime, timezone, timedelta
old = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()
bridge._load_active_tasks = lambda: [
    {"id": "ghost", "status": "running", "tmuxSession": "codex-ghost",
     "lastHeartbeatAt": old, "mcTaskId": "t1", "agentProfile": "codex"}]
bridge._tmux_session_alive = lambda s: False
removed, metrics = [], []
bridge.subprocess.run = lambda *a, **k: removed.append(a[0]) or type("R", (), {"returncode": 0})()
bridge.record_step_attempt = lambda tid, n, rec: metrics.append(rec["outcome"])
n = bridge.reap_dead_agents()
print(json.dumps({"reaped": n, "metrics": metrics}))
`);
  assert.equal(r.reaped, 1);
  // Recorded, never silent: a reaped agent must not read as one that finished.
  assert.deepEqual(r.metrics, ["agent_reaped"]);
});

test("a live agent is never reaped, however old its heartbeat looks", () => {
  const r = python(`
import json, bridge
bridge._load_active_tasks = lambda: [
    {"id": "alive", "status": "running", "tmuxSession": "claude-alive",
     "lastHeartbeatAt": "2000-01-01T00:00:00+00:00"}]
bridge._tmux_session_alive = lambda s: True
print(json.dumps({"reaped": bridge.reap_dead_agents()}))
`);
  assert.equal(r.reaped, 0);
});

test("a just-spawned agent is given time to report before being reaped", () => {
  const r = python(`
import json, bridge
from datetime import datetime, timezone
bridge._load_active_tasks = lambda: [
    {"id": "new", "status": "running", "tmuxSession": "claude-new",
     "startedAt": datetime.now(timezone.utc).isoformat()}]
bridge._tmux_session_alive = lambda s: False
print(json.dumps({"reaped": bridge.reap_dead_agents()}))
`);
  // Its worktree may still be installing deps; reaping it would lose real work.
  assert.equal(r.reaped, 0);
});

test("a wedged tmux is not read as a dead agent", () => {
  const r = python(`
import json, bridge
def boom(*a, **k):
    raise OSError("tmux is not answering")
bridge.subprocess.run = boom
print(json.dumps({"alive": bridge._tmux_session_alive("some-session")}))
`);
  assert.equal(r.alive, true, "tmux failing is not evidence the agent died");
});
