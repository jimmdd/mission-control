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

async function withHandler(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-delegation-"));
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

test("delegate creates a dispatchable child linked to the parent", async () => {
  await withHandler(async (handler, db) => {
    const parent = db.createTask({ title: "ship feature", priority: "high" });

    const res = mockRes();
    await handler(
      mockReq({
        url: `/api/tasks/${parent.id}/delegate`,
        method: "POST",
        body: { title: "investigate flaky dep", reason: "blocked on an unknown failure", wait: true },
      }),
      res,
    );
    assert.equal(res.statusCode, 201);
    const payload = JSON.parse(res.body);
    assert.equal(payload.parent_waiting, true);

    const child = payload.child;
    assert.equal(child.parent_task_id, parent.id);
    assert.equal(child.status, "inbox"); // ready for the bridge to claim
    assert.equal(child.source, "delegation");
    assert.equal(child.task_type, "investigation");
    assert.equal(child.priority, "high"); // inherited

    // Parent is paused and shows a waiting progress state.
    assert.equal(db.getTask(parent.id).status, "on_hold");
    assert.equal(db.getProgress(parent.id).state, "waiting");

    // children endpoint lists it
    const childrenRes = mockRes();
    await handler(mockReq({ url: `/api/tasks/${parent.id}/children` }), childrenRes);
    const children = JSON.parse(childrenRes.body);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, child.id);
  });
});

test("a waiting parent resumes when all delegated children finish", async () => {
  await withHandler(async (handler, db) => {
    const parent = db.createTask({ title: "parent" });

    // Two delegated children, parent waits.
    const d1 = mockRes();
    await handler(mockReq({ url: `/api/tasks/${parent.id}/delegate`, method: "POST", body: { title: "sub A", wait: true } }), d1);
    const childA = JSON.parse(d1.body).child;
    const d2 = mockRes();
    await handler(mockReq({ url: `/api/tasks/${parent.id}/delegate`, method: "POST", body: { title: "sub B", wait: true } }), d2);
    const childB = JSON.parse(d2.body).child;

    assert.equal(db.getTask(parent.id).status, "on_hold");

    // First child completes -> parent still waiting (B open).
    const done1 = mockRes();
    await handler(mockReq({ url: `/api/tasks/${childA.id}/done`, method: "POST", body: {} }), done1);
    assert.equal(db.getTask(parent.id).status, "on_hold");

    // Second child completes -> parent resumes to inbox.
    const done2 = mockRes();
    await handler(mockReq({ url: `/api/tasks/${childB.id}/done`, method: "POST", body: {} }), done2);
    const resumed = db.getTask(parent.id);
    assert.equal(resumed.status, "inbox");
    assert.equal(db.getProgress(parent.id).state, "running");

    // Parent has an activity trail of the delegation + completions + resume.
    const acts = db.listActivities(parent.id).map((a) => a.activity_type);
    assert.ok(acts.includes("delegated"));
    assert.ok(acts.includes("subtask_completed"));
  });
});

test("non-waiting delegation records the result but does not pause the parent", async () => {
  await withHandler(async (handler, db) => {
    const parent = db.createTask({ title: "parent", status: "in_progress" });
    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${parent.id}/delegate`, method: "POST", body: { title: "side quest" } }), res);
    const child = JSON.parse(res.body).child;
    assert.equal(db.getTask(parent.id).status, "in_progress"); // not paused

    await handler(mockReq({ url: `/api/tasks/${child.id}/done`, method: "POST", body: {} }), mockRes());
    // Parent stays as-is (not auto-resumed because it was never on_hold).
    assert.equal(db.getTask(parent.id).status, "in_progress");
    assert.ok(db.listActivities(parent.id).some((a) => a.activity_type === "subtask_completed"));
  });
});
