import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_JOBS } from "../src/scheduler.ts";

const SETUP_SH = fileURLToPath(new URL("../scripts/setup.sh", import.meta.url));

// The loop this guards: linear-sync writes `done` when a Linear issue is
// completed, cancelled or deleted, and cleanup-worktrees acts on that status by
// stopping the ticket's agent and releasing its checkout. Both halves have to be
// scheduled. cleanup-worktrees existed for a long time with nothing running it,
// which is why a deleted ticket left its agent working and its worktree on disk.

test("the worktree cleanup runs on a schedule, not only by hand", () => {
  const job = DEFAULT_JOBS.find((j) => j.name === "cleanup-worktrees");
  assert.ok(job, "cleanup-worktrees must be a scheduled job");
  assert.deepEqual(job.segments, ["swarm", "cleanup-worktrees.sh"]);
  assert.equal(job.interpreter, "bash");
});

test("cleanup runs no more often than the sync that marks tasks done", () => {
  const sync = DEFAULT_JOBS.find((j) => j.name === "linear-sync");
  const cleanup = DEFAULT_JOBS.find((j) => j.name === "cleanup-worktrees");
  // Cleanup only acts on tasks already marked `done`, and linear-sync is what
  // marks them. Running cleanup more often than the sync buys nothing — it would
  // just re-poll MC for statuses that cannot have changed yet.
  assert.ok(
    cleanup.intervalMs >= sync.intervalMs,
    `cleanup (${cleanup.intervalMs}ms) should trail linear-sync (${sync.intervalMs}ms)`,
  );
});

test("launchd installs the cleanup job alongside the other services", () => {
  // The internal scheduler is opt-in (MISSION_CONTROL_INTERNAL_SCHEDULER=1), so
  // DEFAULT_JOBS alone leaves the job dormant on a normal machine. launchd is the
  // path that actually runs on this host.
  const setup = readFileSync(SETUP_SH, "utf8");
  assert.match(setup, /emit_plist ai\.mission-control\.cleanup-worktrees/,
    "setup.sh must emit a plist for the cleanup job");
  assert.match(setup, /swarm\/cleanup-worktrees\.sh/);
  assert.match(setup, /for s in .*cleanup-worktrees.*; do/,
    "the emitted plist must also be loaded, not just written");
});

test("setup.sh stays syntactically valid after the added job", () => {
  execFileSync("bash", ["-n", SETUP_SH], { stdio: "ignore" });
});
