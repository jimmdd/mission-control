// pre-review.sh is a gate the agent must clear before opening a PR, and it had no
// time bound. A brew upgrade re-quarantined the codex binary mid-run and wedged it
// before its first instruction — alive, zero CPU, silent — so the gate did not fail,
// it waited. MET-680 spent ~37 minutes across three attempts on a process that was
// never going to speak, burned its review iterations, and escalated to a human for a
// gate that had never actually run. A review that cannot start must say so quickly.

import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const PRE_REVIEW = fileURLToPath(new URL("../swarm/pre-review.sh", import.meta.url));
function runWithStubCodex(body, { timeoutSeconds = 30 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-prereview-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "file.txt"), "before"); git("add", "."); git("commit", "-m", "fixture");
    writeFileSync(join(repo, "file.txt"), "after");
    const stub = join(dir, "codex");
    writeFileSync(stub, `#!/bin/bash\n${body}\n`);
    chmodSync(stub, 0o755);
    const r = spawnSync("bash", [PRE_REVIEW, repo, "HEAD"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        MC_HOME: dir,
        PRE_REVIEW_TIMEOUT_SECONDS: String(timeoutSeconds),
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a reviewer that hangs silently is cut off and reported, not waited on", () => {
  const started = Date.now();
  const { status, out } = runWithStubCodex("sleep 300", { timeoutSeconds: 3 });
  const elapsed = (Date.now() - started) / 1000;

  assert.equal(status, 2, "an unrunnable review must exit 2, not block or pass");
  assert.match(out, /produced no output within 3s/);
  // The operator needs to know it is the runner, not the diff, that is broken.
  assert.match(out, /codex --version/);
  assert.ok(elapsed < 60, `should give up near the bound, took ${elapsed}s`);
});

test("the ordinary verdicts still map to the exit codes the agent loop depends on", () => {
  const pass = runWithStubCodex('cat >/dev/null; echo "Looks good."; echo "VERDICT: PASS"');
  assert.equal(pass.status, 0);
  assert.match(pass.out, /VERDICT: PASS/);

  const fail = runWithStubCodex('cat >/dev/null; echo "Critical bug."; echo "VERDICT: FAIL"');
  assert.equal(fail.status, 1);
  assert.match(fail.out, /VERDICT: FAIL/);

  const warn = runWithStubCodex('cat >/dev/null; echo "VERDICT: WARN"');
  assert.equal(warn.status, 0, "warnings do not block");

  const none = runWithStubCodex('cat >/dev/null; echo "I have opinions but no verdict"');
  assert.equal(none.status, 1, "no parseable verdict still means needs-review");
});

test("a reviewer that crashes keeps reporting its own error, not the timeout message", () => {
  const { status, out } = runWithStubCodex('cat >/dev/null; echo "boom" >&2; exit 7');
  assert.equal(status, 2);
  assert.match(out, /Codex review failed to run/);
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /produced no output within/);
});
