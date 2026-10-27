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

// `claude -p` in text mode printed nothing until the run ended, so the watchdog read
// every Claude run longer than its startup window as a hang: MET-833, MET-837 and
// MET-870 each lost three attempts and failed over to codex. The launcher now asks
// for stream-json and renders it, so a working Claude keeps the log growing.
const ev = (o) => `echo '${JSON.stringify(o).replaceAll("'", "'\\''")}'`;
const streamingClaude = (...events) =>
  `cat >/dev/null; for a in "$@"; do :; done\n` +
  `case " $* " in *" --output-format stream-json "*) ;; *) echo "not streaming: $*"; exit 9;; esac\n` +
  events.join("\n");

test("a claude run that streams progress past the startup window is left alone", () => {
  const h = harness("WD-claude-slow");
  stub(h.binDir, "claude", streamingClaude(
    ev({ type: "system", subtype: "init" }),
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Reading the repo" }] } }),
    "sleep 1",
    ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] } }),
    "sleep 1",
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Still working" }] } }),
    "sleep 1",
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Almost there" }] } }),
    "sleep 1",
    ev({ type: "result", subtype: "success", is_error: false, result: "Opened PR #1" }),
  ));

  // 4s of work against a 2s startup window and 3s stall window: text mode would
  // have been silent the whole time and killed at 2s.
  h.run("run-claude.sh", { AGENT_PROFILE: "claude", AGENT_STALL_TIMEOUT_SECONDS: "3" });
  const log = h.log();

  assert.doesNotMatch(log, /WATCHDOG/);
  assert.doesNotMatch(log, /Failing over/);
  assert.match(log, /^\[agent\] Reading the repo$/m);
  assert.match(log, /^\[tool\] Bash: git status$/m);
  assert.match(log, /^Opened PR #1$/m);
  assert.match(log, /Claude Agent completed successfully/);
  assert.equal(h.registry().status, "completed_by_agent");
});

test("a streamed max-turns stop is still not a completion", () => {
  const h = harness("WD-claude-turns");
  stub(h.binDir, "claude", streamingClaude(
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Working" }] } }),
    ev({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 200 }),
  ));

  assert.throws(() => h.run("run-claude.sh", { AGENT_PROFILE: "claude" }));
  const log = h.log();

  assert.match(log, /^Error: Reached max turns \(200\)$/m);
  assert.match(log, /Stopped on the turn limit/);
  assert.doesNotMatch(log, /completed successfully/);
  assert.equal(h.registry().lastError, "exit_code_75");
});

test("an agent that only talks about limits is not classified as limited", () => {
  const h = harness("WD-claude-chatter");
  stub(h.binDir, "claude", streamingClaude(
    ev({ type: "assistant", message: { content: [{ type: "text", text: "The API returns 'rate limit reached' and 'Reached max turns' in tests" }] } }),
    ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "grep -rn 'usage limit reached' src" } }] } }),
    ev({ type: "result", subtype: "success", is_error: false, result: "Done" }),
  ));

  h.run("run-claude.sh", { AGENT_PROFILE: "claude" });
  const log = h.log();

  assert.doesNotMatch(log, /Stopped by the account limit/);
  assert.doesNotMatch(log, /Stopped on the turn limit/);
  assert.match(log, /Claude Agent completed successfully/);
  assert.equal(h.registry().status, "completed_by_agent");
});

test("a streamed account limit is still detected", () => {
  const h = harness("WD-claude-limit");
  stub(h.binDir, "claude", streamingClaude(
    ev({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 3pm" }] } }),
    ev({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 3pm" }),
  ));

  assert.throws(() => h.run("run-claude.sh", { AGENT_PROFILE: "claude" }), (err) => {
    assert.equal(err.status, 75);
    return true;
  });
  const log = h.log();

  assert.match(log, /Stopped by the account limit, not by finishing: You've hit your session limit/);
  assert.equal(h.registry().status, "rate_limited");
});


test("a hard Claude authentication failure stops without blind retries or provider switching", () => {
  const h=harness("WD-auth");
  stub(h.binDir,"claude",'cat >/dev/null; echo "API Error: 401 OAuth token has expired"; exit 1');
  assert.throws(()=>h.run("run-claude.sh",{AGENT_PROFILE:"claude",MAX_AGENT_RETRIES:"3"}));
  assert.equal(h.registry().status,"failed");
  assert.equal(h.registry().lastError,"authentication_required");
  assert.equal(h.registry().retryCount,1);
  assert.doesNotMatch(h.log(),/Retrying in|Failing over/);
});


test("a plain API 401 response is an auth stop rather than a retryable process failure", () => {
  const h=harness("WD-auth-401");
  stub(h.binDir,"claude",'cat >/dev/null; echo "API Error: 401 Unauthorized"; exit 1');
  assert.throws(()=>h.run("run-claude.sh",{AGENT_PROFILE:"claude",MAX_AGENT_RETRIES:"3"}));
  assert.equal(h.registry().lastError,"authentication_required");
  assert.equal(h.registry().retryCount,1);
  assert.doesNotMatch(h.log(),/Retrying in|Failing over/);
});
