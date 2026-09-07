// A launcher that CRASHES rides the retry ladder. A launcher that HANGS used to sit
// there forever: MET-680 spent 99 minutes with `codex exec` blocked at `_dyld_start`,
// printing nothing, never exiting, so the ladder never engaged and the ticket never
// moved. These tests pin the two behaviours that fix it — the watchdog kills a silent
// agent, and an agent that hangs every attempt is handed to the sibling profile —
// plus the exit-code bug that made a crashed `claude` read as a completed one.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

const CONFIG = {
  agents: {
    defaultProfile: "claude",
    profiles: {
      claude: { launcher: "claude", model: "opus", maxAgents: 5, fallbackProfile: "codex", env: {} },
      codex: { launcher: "codex", model: "gpt-5.6-sol", effort: "high", maxAgents: 8, fallbackProfile: "claude", env: {} },
    },
  },
  claude: { model: "opus" },
  codex: { model: "gpt-5.6-sol", effort: "high" },
};

// A stub agent CLI. `body` is bash run in place of the real binary.
function stub(binDir, name, body) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function harness(taskName) {
  const home = mkdtempSync(join(tmpdir(), "mc-watchdog-"));
  const swarmDir = join(home, "swarm");
  const binDir = join(home, "bin");
  mkdirSync(join(swarmDir, "logs"), { recursive: true });
  mkdirSync(join(swarmDir, "prompts"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  for (const script of ["run-codex.sh", "run-claude.sh", "swarm-state.py"]) {
    symlinkSync(join(SWARM, script), join(swarmDir, script));
  }
  writeFileSync(join(swarmDir, "swarm-config.json"), JSON.stringify(CONFIG));
  writeFileSync(join(swarmDir, "prompts", `${taskName}.md`), "do the thing");
  // No mcTaskId: the launchers then skip every Mission Control HTTP call, so the
  // test never talks to a real server.
  writeFileSync(
    join(swarmDir, "active-tasks.json"),
    JSON.stringify([{ id: taskName, status: "running", agent: "codex", agentProfile: "codex" }]),
  );

  const run = (script, env = {}) =>
    execFileSync("bash", [join(swarmDir, script), taskName], {
      encoding: "utf8",
      // The ladder's own backoff is 30s per retry, so a single attempt keeps these
      // tests fast; the retry path is the same code either way.
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        MC_HOME: home,
        MISSION_CONTROL_URL: "http://127.0.0.1:1",
        MAX_AGENT_RETRIES: "1",
        AGENT_STARTUP_TIMEOUT_SECONDS: "2",
        AGENT_STALL_TIMEOUT_SECONDS: "2",
        AGENT_WATCHDOG_POLL_SECONDS: "1",
        AGENT_WATCHDOG_TERM_GRACE_SECONDS: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

  return {
    binDir,
    run,
    log: () => readFileSync(join(swarmDir, "logs", `agent-${taskName}.log`), "utf8"),
    registry: () => JSON.parse(readFileSync(join(swarmDir, "active-tasks.json"), "utf8"))[0],
  };
}

test("a codex agent that never prints anything is killed and handed to claude", () => {
  const h = harness("WD-hang");
  // Exactly the MET-680 shape: starts, emits nothing, never exits.
  stub(h.binDir, "codex", "sleep 300");
  stub(h.binDir, "claude", 'cat >/dev/null; echo "FAKE CLAUDE DID THE WORK"');

  h.run("run-codex.sh");
  const log = h.log();

  assert.match(log, /WATCHDOG: codex exec produced no output at all for 2s/);
  assert.match(log, /Killed by the watchdog/);
  assert.match(log, /Failing over: 'codex' hung on every attempt; handing WD-hang to 'claude'/);
  assert.match(log, /FAKE CLAUDE DID THE WORK/);
  assert.match(log, /Claude Agent completed successfully/);
  assert.equal(h.registry().status, "completed_by_agent");
});

test("failover does not ping-pong back when the fallback hangs too", () => {
  const h = harness("WD-both");
  stub(h.binDir, "codex", "sleep 300");
  stub(h.binDir, "claude", "cat >/dev/null; sleep 300");

  assert.throws(() => h.run("run-codex.sh"), (err) => {
    const log = h.log();
    // codex hands off to claude once; claude hangs too but must stop there rather
    // than bouncing the task back to the CLI that already failed.
    assert.match(log, /handing WD-both to 'claude'/);
    assert.match(log, /WATCHDOG: claude -p produced no output at all/);
    assert.match(log, /Already failed over once; not handing off again/);
    assert.equal((log.match(/Failing over:/g) || []).length, 1);
    return true;
  });
  assert.equal(h.registry().status, "failed");
});

test("an agent that keeps printing is left alone", () => {
  const h = harness("WD-busy");
  // Quiet for longer than the stall budget would allow if it were silent, but it
  // keeps writing, so the watchdog must not touch it.
  stub(h.binDir, "codex", 'for i in 1 2 3 4 5 6; do echo "working $i"; sleep 1; done');

  h.run("run-codex.sh");
  const log = h.log();

  assert.doesNotMatch(log, /WATCHDOG/);
  assert.doesNotMatch(log, /Failing over/);
  assert.match(log, /working 6/);
  assert.match(log, /Codex Agent completed successfully/);
});

test("a claude run that exits non-zero is not reported as a completion", () => {
  const h = harness("WD-exit");
  // The prompt feeder always succeeds, so reading PIPESTATUS[0] used to report this
  // crashed run as exit 0 — marking the task complete on an empty worktree.
  stub(h.binDir, "claude", 'cat >/dev/null; echo "boom"; exit 3');

  assert.throws(() => h.run("run-claude.sh", { AGENT_PROFILE: "claude" }), (err) => {
    assert.equal(err.status, 3);
    return true;
  });
  const log = h.log();

  assert.match(log, /Claude Agent failed \(exit 3\)/);
  assert.doesNotMatch(log, /completed successfully/);
  assert.equal(h.registry().status, "failed");
});
