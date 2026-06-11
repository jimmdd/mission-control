import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";
import { McEventBus } from "../src/events.ts";
import { startLivenessReaper } from "../src/reaper.ts";

const SILENT = { info() {}, error() {} };

function mockReq({ url, method = "GET", headers = {}, body }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.url = url;
  stream.method = method;
  stream.headers = { host: "localhost", "sec-fetch-site": "same-origin", ...headers };
  return stream;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(c) { this.statusCode = c; },
    end(b) { this.body = b ?? ""; },
  };
}

async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-reactive-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("progress and delegation updates emit events on the bus", async () => {
  await withDb(async (db) => {
    const events = new McEventBus();
    const seen = [];
    events.subscribe((e) => seen.push(e.type));
    const handler = createHandler(db, SILENT, events);
    const task = db.createTask({ title: "t" });

    await handler(
      mockReq({ url: `/api/tasks/${task.id}/progress`, method: "PUT", body: { state: "blocked", blocked_reason: "x" } }),
      mockRes(),
    );
    await handler(
      mockReq({ url: `/api/tasks/${task.id}/delegate`, method: "POST", body: { title: "child" } }),
      mockRes(),
    );

    assert.ok(seen.includes("progress"), "expected a progress event");
    assert.ok(seen.includes("delegated"), "expected a delegated event");
  });
});

test("SSE stream sends a ready frame and pushes subsequent events", async () => {
  await withDb(async (db) => {
    const events = new McEventBus();
    const handler = createHandler(db, SILENT, events);

    const chunks = [];
    let closeHandler = null;
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
      write(s) { chunks.push(s); return true; },
      end() {},
      on() {},
    };
    const req = { url: "/api/stream", method: "GET", headers: { host: "localhost" }, on(ev, cb) { if (ev === "close") closeHandler = cb; } };

    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["Content-Type"], /text\/event-stream/);
    assert.ok(chunks.join("").includes("event: ready"));

    const task = db.createTask({ title: "t" });
    await handler(
      mockReq({ url: `/api/tasks/${task.id}/progress`, method: "PUT", body: { state: "running" } }),
      mockRes(),
    );

    const streamed = chunks.join("");
    assert.ok(streamed.includes('"type":"progress"'), "progress event should be pushed to the stream");
    if (closeHandler) closeHandler(); // clean up interval/subscription
  });
});

test("liveness reaper flags an exited agent once and emits an event", async () => {
  await withDb(async (db) => {
    const events = new McEventBus();
    const fired = [];
    events.subscribe((e) => fired.push(e));
    const task = db.createTask({ title: "running task" });

    // Simulate the swarm status map: tmux gone while registry said running.
    let statusMap = { [task.id]: { liveStatus: "completed_by_agent" } };
    const stop = startLivenessReaper(db, events, {
      getStatusMap: async () => statusMap,
      intervalMs: 10,
    });

    // Wait for a couple of ticks.
    await new Promise((r) => setTimeout(r, 60));
    stop();

    const exited = fired.filter((e) => e.type === "agent_exited" && e.taskId === task.id);
    assert.equal(exited.length, 1, "should emit exactly once per transition, not every tick");
    // Reaper marks the task's progress blocked and logs an activity.
    assert.equal(db.getProgress(task.id).state, "blocked");
    assert.ok(db.listActivities(task.id).some((a) => a.activity_type === "liveness"));
  });
});
