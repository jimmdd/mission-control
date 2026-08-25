import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { prunePreviews, startPreviewReaper } from "../src/preview.ts";

const MINUTE = 60_000;

/** An isolated MC_HOME so a test never touches the real previews registry. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-reaper-"));
  mkdirSync(join(root, "swarm"), { recursive: true });
  const previous = process.env.MC_HOME;
  process.env.MC_HOME = root;
  return {
    root,
    write(previews) {
      writeFileSync(join(root, "swarm", "previews.json"), JSON.stringify(previews, null, 2));
    },
    read() {
      return JSON.parse(readFileSync(join(root, "swarm", "previews.json"), "utf-8"));
    },
    cleanup() {
      if (previous === undefined) delete process.env.MC_HOME;
      else process.env.MC_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function entry(taskId, overrides = {}) {
  return {
    taskId,
    ticket: `MET-${taskId}`,
    port: 5173,
    session: `mc-preview-test-${taskId}`,
    app: "apps/new-ui",
    url: "http://127.0.0.1:5173",
    worktree: "/tmp/nowhere",
    startedAt: Date.now(),
    ...overrides,
  };
}

/** A real detached tmux session, so "still alive" is not merely asserted. */
function tmuxSession() {
  const name = `mc-preview-test-${randomBytes(4).toString("hex")}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", name, "sleep", "120"], { stdio: "ignore" });
  } catch {
    return null; // tmux unavailable — the caller skips.
  }
  return {
    name,
    kill() {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    },
  };
}

test("a preview whose tmux session is gone is dropped from the registry", () => {
  const fx = fixture();
  try {
    // No such tmux session exists, so this is the leftover-record case: the
    // registry outlived the process it was tracking.
    fx.write({ "1": entry("1") });

    const { live, reaped } = prunePreviews();

    assert.deepEqual(Object.keys(live), []);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].reason, "dead");
    assert.deepEqual(fx.read(), {}, "the pruned registry is persisted, not just returned");
  } finally {
    fx.cleanup();
  }
});

test("a live preview past its TTL is killed; one inside it is left alone", (t) => {
  const fresh = tmuxSession();
  if (fresh === null) return t.skip("tmux unavailable");
  const old = tmuxSession();
  if (old === null) {
    fresh.kill();
    return t.skip("tmux unavailable");
  }

  const fx = fixture();
  try {
    fx.write({
      fresh: entry("fresh", { session: fresh.name, startedAt: Date.now() }),
      // Well past the 10-minute default, without depending on its exact value.
      old: entry("old", { session: old.name, startedAt: Date.now() - 240 * MINUTE }),
    });

    const { live, reaped } = prunePreviews();

    assert.deepEqual(Object.keys(live), ["fresh"], "an in-TTL preview survives the sweep");
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].taskId, "old");
    // `expired` vs `dead` is the distinction that matters in the log: one is a
    // preview someone was using, the other is bookkeeping.
    assert.equal(reaped[0].reason, "expired");
    assert.ok(reaped[0].ageMs > 200 * MINUTE);

    // The point of expiry is that the process actually stops, not that the
    // record disappears while the dev server keeps running.
    assert.throws(
      () => execFileSync("tmux", ["has-session", "-t", `=${old.name}`], { stdio: "ignore" }),
      "the expired preview's tmux session is killed",
    );
    execFileSync("tmux", ["has-session", "-t", `=${fresh.name}`], { stdio: "ignore" });
  } finally {
    fresh.kill();
    old.kill();
    fx.cleanup();
  }
});

test("the reaper sweeps on its own timer and reports what it closed", async () => {
  const fx = fixture();
  try {
    fx.write({ "7": entry("7") });

    const reaped = [];
    // A short interval only to keep the test quick — the mechanism under test is
    // that a sweep happens with no request and nobody watching, which is the
    // whole reason this exists.
    const stop = startPreviewReaper({ intervalMs: 10, onReap: (r) => reaped.push(r) });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      stop();
    }

    assert.equal(reaped.length, 1, "swept once without any caller touching getPreviews()");
    assert.equal(reaped[0].taskId, "7");
    assert.deepEqual(fx.read(), {});

    // After stopping, no further sweeps run — a stale timer would keep killing
    // previews started by a later server instance.
    fx.write({ "8": entry("8") });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(Object.keys(fx.read()), ["8"], "the returned stop function actually stops it");
  } finally {
    fx.cleanup();
  }
});
