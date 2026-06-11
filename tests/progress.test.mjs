import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";

const SILENT = { info() {}, error() {} };

function mockReq({ url, method = "GET", headers = {}, body }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.url = url;
  stream.method = method;
  stream.headers = { host: "localhost", ...headers };
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

async function withHandler(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-progress-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    return await fn(createHandler(db, SILENT), db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("progress upsert merges fields and reports the latest state", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-progress-db-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  try {
    db.initSchema();
    db.seedDefaults();
    const task = db.createTask({ title: "work" });

    const first = db.upsertProgress(task.id, { state: "running", phase: "execute", step_label: "build", step_index: 1, step_total: 3 });
    assert.equal(first.state, "running");
    assert.equal(first.phase, "execute");
    assert.equal(first.step_index, 1);

    // Partial update keeps prior fields, changes state + reason.
    const second = db.upsertProgress(task.id, { state: "blocked", blocked_reason: "missing API key" });
    assert.equal(second.state, "blocked");
    assert.equal(second.blocked_reason, "missing API key");
    assert.equal(second.phase, "execute"); // preserved
    assert.equal(second.step_total, 3); // preserved

    assert.equal(db.getProgress(task.id).state, "blocked");
    db.clearProgress(task.id);
    assert.equal(db.getProgress(task.id), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PUT /tasks/:id/progress validates and persists structured progress", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "endpoint" });

    const put = mockRes();
    await handler(
      mockReq({
        url: `/api/tasks/${task.id}/progress`,
        method: "PUT",
        headers: { "sec-fetch-site": "same-origin" },
        body: { state: "waiting", phase: "verify", blocked_reason: "awaiting child result", bogus: "ignored" },
      }),
      put,
    );
    assert.equal(put.statusCode, 200);
    const saved = JSON.parse(put.body);
    assert.equal(saved.state, "waiting");
    assert.equal(saved.phase, "verify");
    assert.equal(saved.blocked_reason, "awaiting child result");

    const get = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/progress` }), get);
    assert.equal(get.statusCode, 200);
    assert.equal(JSON.parse(get.body).state, "waiting");
  });
});

test("board surfaces per-task progress and a blocked-agent count", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "mc-home-"));
  const prevHome = process.env.MC_HOME;
  process.env.MC_HOME = homeDir;
  try {
    await withHandler(async (handler, db) => {
      const a = db.createTask({ title: "a" });
      const b = db.createTask({ title: "b" });
      db.upsertProgress(a.id, { state: "blocked", blocked_reason: "stuck" });
      db.upsertProgress(b.id, { state: "running", phase: "execute" });

      const res = mockRes();
      await handler(mockReq({ url: "/api/board" }), res);
      assert.equal(res.statusCode, 200);
      const board = JSON.parse(res.body);
      assert.equal(board.summary.blockedAgents, 1);
      const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));
      assert.equal(byId[a.id].progress.state, "blocked");
      assert.equal(byId[b.id].progress.phase, "execute");
    });
  } finally {
    if (prevHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
