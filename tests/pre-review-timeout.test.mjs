// pre-review.sh is a gate the agent must clear before opening a PR, and it had no
// time bound. A brew upgrade re-quarantined the codex binary mid-run and wedged it
// before its first instruction — alive, zero CPU, silent — so the gate did not fail,
// it waited. MET-680 spent ~37 minutes across three attempts on a process that was
// never going to speak, burned its review iterations, and escalated to a human for a
// gate that had never actually run. A review that cannot start must say so quickly.

import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const PRE_REVIEW = fileURLToPath(new URL("../swarm/pre-review.sh", import.meta.url));
function runWithStubCodex(body, { timeoutSeconds = 30, filename = "file.txt", greptileMode = "pass" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-prereview-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, filename), "before"); git("add", "."); git("commit", "-m", "fixture");
    writeFileSync(join(repo, filename), "after"); git("add", "."); git("commit", "-m", "change");
    const head = git("rev-parse", "HEAD").toString().trim();
    const base = git("rev-parse", "HEAD^").toString().trim();
    const greptile = join(dir, "greptile");
    writeFileSync(greptile, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const mode = ${JSON.stringify(greptileMode)};
const args = process.argv.slice(2);
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'auth') { console.error('Not signed in'); process.exit(1); }
else if (args[1] === 'status') {
  console.log(JSON.stringify({status: mode === 'pending' ? 'IN_FLIGHT' : 'COMPLETED', runId: 'fixture-run',
    headSha: mode === 'stale' ? 'old-head' : ${JSON.stringify(head)}, baseSha: ${JSON.stringify(base)},
    commentCount: mode === 'finding' ? 1 : 0}));
} else {
  if (args[args.indexOf('--branch') + 1] !== ${JSON.stringify(base)}) process.exit(9);
  if (mode === 'dirty') fs.writeFileSync('uncommitted.txt', 'changed during review');
  if (mode === 'changed-head') cp.execFileSync('git', ['commit', '--allow-empty', '-m', 'concurrent change']);
  if (mode === 'malformed') console.log('{}');
  else console.log(JSON.stringify({summary:'reviewed', confidence:5,
    comments: mode === 'finding' ? [{path:'file.txt',severity:'P2',body:'Fix the bug'}] : []}));
}
`);
    chmodSync(greptile, 0o755);
    const stub = join(dir, "codex");
    writeFileSync(stub, `#!/bin/bash
touch ${JSON.stringify(join(dir, "codex-called"))}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then result="$2"; shift; fi
  shift
done
{ ${body}; } > "$result"
cat "$result"
`);
    chmodSync(stub, 0o755);
    const r = spawnSync("bash", [PRE_REVIEW, repo, "HEAD^"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        MC_HOME: dir,
        PRE_REVIEW_TIMEOUT_SECONDS: String(timeoutSeconds),
      },
    });
    const receipt = join(dir, "swarm", "pr-review-state", `${head}.json`);
    return { status: r.status, out: `${r.stdout}${r.stderr}`,
      codexCalled: existsSync(join(dir, "codex-called")),
      receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null };
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
  assert.equal(warn.status, 1, "unresolved review warnings need an explicit disposition and re-review");

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

 test("an echoed LGTM or mixed failure cannot authorize delivery", () => {
  assert.equal(runWithStubCodex('cat >/dev/null; echo "LGTM"').status, 1);
  assert.equal(runWithStubCodex('cat >/dev/null; printf "VERDICT: FAIL\\nVERDICT: PASS\\n"').status, 1);
});

test("lockfile-only changes receive independent review instead of an empty success", () => {
  const result=runWithStubCodex('cat >/dev/null; echo "VERDICT: PASS"',{filename:"bun.lock"});
  assert.equal(result.status,0);assert.match(result.out,/VERDICT: PASS/);
});

test("Greptile findings block Codex and the delivery receipt even at confidence 5", () => {
  const result = runWithStubCodex('echo "VERDICT: PASS"', { greptileMode: "finding" });
  assert.equal(result.status, 1);
  assert.match(result.out, /Fix the bug/);
  assert.equal(result.codexCalled, false);
  assert.equal(result.receipt, null);
});

test("missing auth, malformed, pending, stale, and changed-worktree reviews cannot pass", () => {
  for (const greptileMode of ["auth", "malformed", "pending", "stale", "dirty", "changed-head"]) {
    const result = runWithStubCodex('echo "VERDICT: PASS"', { greptileMode });
    assert.equal(result.status, 2, greptileMode);
    assert.equal(result.codexCalled, false, greptileMode);
    assert.equal(result.receipt, null, greptileMode);
  }
});

test("a hung Greptile review is bounded and cannot fall through to Codex", () => {
  const start = Date.now();
  const result = runWithStubCodex('echo "VERDICT: PASS"', { timeoutSeconds: 1, greptileMode: "hang" });
  assert.equal(result.status, 2);
  assert.match(result.out, /exceeded the review timeout/);
  assert.equal(result.codexCalled, false);
  assert.ok(Date.now() - start < 10000);
});

test("a delivery receipt includes completed Greptile evidence for the same commits", () => {
  const result = runWithStubCodex('echo "VERDICT: PASS"');
  assert.equal(result.status, 0);
  assert.equal(result.receipt.greptile.head, result.receipt.head);
  assert.equal(result.receipt.greptile.base, result.receipt.base);
  assert.equal(result.receipt.greptile.status, "COMPLETED");
  assert.deepEqual(result.receipt.greptile.review.comments, []);
});
