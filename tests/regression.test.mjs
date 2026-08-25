import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";
import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";

async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-regression-"));
  const dbPath = join(dir, "mc.db");
  const db = new MissionControlDB(dbPath);
  db.initSchema();
  db.seedDefaults();
  try {
    return await fn(db, dbPath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body ?? "";
      this.ended = true;
    },
  };
}

// Regression guard for P1: the board summary used to count over a 100-row page,
// so totals silently undercounted once the table grew past 100 tasks.
test("task counts are exact beyond the 100-row page limit", async () => {
  await withDb((db) => {
    for (let i = 0; i < 120; i += 1) db.createTask({ title: `inbox-${i}`, status: "inbox" });
    for (let i = 0; i < 35; i += 1) db.createTask({ title: `done-${i}`, status: "done" });

    assert.equal(db.countTasks(), 155);

    const counts = db.getStatusCounts();
    assert.equal(counts.inbox, 120);
    assert.equal(counts.done, 35);

    const summed = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(summed, 155);

    // The default page is still capped at 100 — which is exactly why counting
    // over the page (the old behavior) was wrong.
    assert.equal(db.listTasks({}).length, 100);
  });
});

// Regression guard for P2: every write path must produce ISO-8601 timestamps so
// `since`-based polling orders rows consistently.
test("new rows use ISO-8601 timestamps across all tables", async () => {
  await withDb((db) => {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    const task = db.createTask({ title: "timestamps" });
    assert.match(task.created_at, iso);
    assert.match(task.updated_at, iso);

    const activity = db.createActivity({ task_id: task.id, activity_type: "note", message: "m" });
    assert.match(activity.created_at, iso);

    const event = db.createEvent({ type: "test", message: "m" });
    assert.match(event.created_at, iso);

    const deliverable = db.createDeliverable({ task_id: task.id, deliverable_type: "artifact", title: "t" });
    assert.match(deliverable.created_at, iso);
  });
});

test("recording the same pull request through multiple observers stays idempotent", async () => {
  await withDb((db) => {
    const task = db.createTask({ title: "one PR" });
    const url = "https://github.com/acme/app/pull/687";
    const bridge = db.createDeliverable({
      task_id: task.id, deliverable_type: "pull_request", title: "Pull Request #687", path: url,
    });
    const monitor = db.createDeliverable({
      task_id: task.id, deliverable_type: "pr", title: "Pull request", path: url,
    });

    assert.equal(monitor.id, bridge.id);
    assert.equal(db.listDeliverables(task.id).length, 1);
  });
});

test("ticket chat pending messages are bounded and settle through one linked reply", async () => {
  await withDb((db) => {
    const task = db.createTask({ title: "chat", status: "in_progress" });
    const human = db.createActivity({
      task_id: task.id,
      activity_type: "updated",
      message: "what is happening?",
      metadata: JSON.stringify({ source: "human", via: "ticket-page" }),
      expects_reply: true,
    });

    const pending = db.listPendingChatMessages(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, human.id);
    assert.equal(pending[0].task_status, "in_progress");

    db.createActivity({
      task_id: task.id,
      activity_type: "agent_reply",
      message: "The task is still running.",
      reply_to_activity_id: human.id,
    });
    assert.deepEqual(db.listPendingChatMessages(10), []);
    assert.throws(() => db.createActivity({
      task_id: task.id,
      activity_type: "agent_reply",
      message: "duplicate",
      reply_to_activity_id: human.id,
    }), /UNIQUE constraint failed/);
  });
});

// Regression guard for P2 migration: legacy "YYYY-MM-DD HH:MM:SS" rows must be
// rewritten to ISO on startup.
test("legacy space-separated timestamps are normalized on init", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-tsmigrate-"));
  const dbPath = join(dir, "mc.db");
  try {
    const first = new MissionControlDB(dbPath);
    first.initSchema();
    first.seedDefaults();
    const task = first.createTask({ title: "legacy" });
    first.close();

    // Simulate a row written by the old DB-default timestamp format.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run(
      "2026-06-01 12:00:00",
      "2026-06-01 12:00:00",
      task.id,
    );
    raw.close();

    const second = new MissionControlDB(dbPath);
    second.initSchema(); // runs migrateTimestampFormat
    const migrated = second.getTask(task.id);
    second.close();

    assert.equal(migrated.created_at, "2026-06-01T12:00:00Z");
    assert.equal(migrated.updated_at, "2026-06-01T12:00:00Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Real behavioral coverage of the auth gate (the text-grep tests never exercised it).
test("API rejects requests without the configured access token", async () => {
  await withDb(async (db) => {
    process.env.MISSION_CONTROL_ACCESS_TOKEN = "secret-token";
    try {
      const handler = createHandler(db);

      const denied = mockRes();
      await handler({ url: "/api/meta", method: "GET", headers: {} }, denied);
      assert.equal(denied.statusCode, 401);

      const allowed = mockRes();
      await handler(
        { url: "/api/meta", method: "GET", headers: { authorization: "Bearer secret-token" } },
        allowed,
      );
      assert.equal(allowed.statusCode, 200);

      const wrong = mockRes();
      await handler(
        { url: "/api/meta", method: "GET", headers: { authorization: "Bearer nope" } },
        wrong,
      );
      assert.equal(wrong.statusCode, 401);
    } finally {
      delete process.env.MISSION_CONTROL_ACCESS_TOKEN;
    }
  });
});
