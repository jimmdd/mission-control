// check-agents.sh decides whether an agent is alive by looking at its tmux pane.
// It probed with `capture-pane -p -l 5`, but capture-pane has no -l flag: the call
// failed every time, its stderr went to /dev/null, and the captured text was always
// empty. Every agent read `pane=idle` forever and `lastOutput` was always "" — the
// two signals the stall warning is built on. It called MET-680 idle while codex was
// genuinely wedged, and called it idle again while a healthy agent wrote ~500KB in
// fifteen minutes. A liveness probe that always says "idle" detects nothing.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CHECK_AGENTS = fileURLToPath(new URL("../swarm/check-agents.sh", import.meta.url));
const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

// The probe exactly as check-agents.sh runs it.
const probe = (session) =>
  execFileSync("bash", ["-c", `
    last_lines=$( (tmux capture-pane -t "$1" -p -S -5 2>/dev/null || true) \
      | grep -v '^[[:space:]]*$' | tr '\\n' '|' | tail -c 300 || true)
    [ -n "$last_lines" ] && echo active || echo idle
  `, "_", session], { encoding: "utf8" }).trim();

test("the script does not reach for a capture-pane flag that does not exist", () => {
  const src = readFileSync(CHECK_AGENTS, "utf8");
  const captures = src.match(/tmux capture-pane[^\n|]*/g) ?? [];
  assert.ok(captures.length > 0, "expected check-agents.sh to probe the pane");
  for (const call of captures) {
    assert.doesNotMatch(call, /\s-l\s/, `capture-pane has no -l flag: ${call.trim()}`);
    assert.match(call, /-S\s+-\d+/, `expected -S -N history capture: ${call.trim()}`);
  }
});

test("tmux really does reject -l, so the old probe could only ever fail", { skip: !haveTmux }, () => {
  const r = spawnSync("tmux", ["capture-pane", "-t", "no-such-session", "-p", "-l", "5"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}`, /unknown flag -l/);
});

test("a pane with output reads active, an empty one reads idle", { skip: !haveTmux }, () => {
  const busy = `mc-probe-busy-${process.pid}`;
  const quiet = `mc-probe-quiet-${process.pid}`;
  const kill = (s) => spawnSync("tmux", ["kill-session", "-t", `=${s}`], { stdio: "ignore" });
  try {
    // A pane that has printed something, and one that has printed nothing at all.
    execFileSync("tmux", ["new-session", "-d", "-s", busy, "sh -c 'echo AGENT_IS_WORKING; sleep 30'"]);
    execFileSync("tmux", ["new-session", "-d", "-s", quiet, "sleep 30"]);
    // Give tmux a moment to paint the pane before probing it.
    execFileSync("bash", ["-c", "sleep 1"]);

    assert.equal(probe(busy), "active");
    assert.equal(probe(quiet), "idle");
    assert.equal(probe(`no-such-session-${process.pid}`), "idle", "a dead session is not active");
  } finally {
    kill(busy);
    kill(quiet);
  }
});
