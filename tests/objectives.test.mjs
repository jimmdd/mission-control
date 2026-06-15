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
    statusCode: 200, headers: {}, body: "",
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(c) { this.statusCode = c; },
    end(b) { this.body = b ?? ""; },
  };
}

async function withHandler(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-objectives-"));
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

test("objective DB layer: create, document, page upsert", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-obj-db-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  try {
    db.initSchema();
    db.seedDefaults();
    const anchor = db.createTask({ title: "wiki", task_type: "investigation", source: "autopilot" });
    const obj = db.createObjective({ goal: "wiki", anchor_task_id: anchor.id });
    assert.equal(obj.status, "scoping");
    assert.equal(obj.anchor_task_id, anchor.id);
    assert.equal(db.getObjectiveByAnchorTask(anchor.id).id, obj.id);

    const updated = db.updateObjective(obj.id, { status: "running", round: 1, proposed_scope: '{"a":1}' });
    assert.equal(updated.status, "running");
    assert.equal(updated.round, 1);

    const doc = db.createDocument({ objective_id: obj.id, title: "Wiki" });
    assert.equal(db.getDocumentByObjective(obj.id).id, doc.id);

    db.upsertPage(doc.id, { slug: "overview", title: "Overview", body_md: "v1", position: 0 });
    db.upsertPage(doc.id, { slug: "overview", title: "Overview", body_md: "v2", position: 0 }); // dedup
    db.upsertPage(doc.id, { slug: "setup", title: "Setup", body_md: "x", position: 1 });
    const pages = db.listPages(doc.id);
    assert.equal(pages.length, 2, "upsert should dedup by slug");
    assert.equal(db.getPage(doc.id, "overview").body_md, "v2");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /objectives creates an objective + anchor task (on_hold)", async () => {
  await withHandler(async (handler, db) => {
    const res = mockRes();
    await handler(mockReq({ url: "/api/objectives", method: "POST", body: { goal: "build a wiki" } }), res);
    assert.equal(res.statusCode, 201);
    const obj = JSON.parse(res.body);
    assert.equal(obj.status, "scoping");
    assert.ok(obj.anchor_task_id);
    const anchor = db.getTask(obj.anchor_task_id);
    assert.equal(anchor.status, "on_hold");
    assert.equal(anchor.source, "autopilot");

    const list = mockRes();
    await handler(mockReq({ url: "/api/objectives" }), list);
    assert.equal(JSON.parse(list.body).length, 1);
  });
});

test("PATCH /objectives persists autopilot loop state", async () => {
  await withHandler(async (handler, db) => {
    const create = mockRes();
    await handler(mockReq({ url: "/api/objectives", method: "POST", body: { goal: "g" } }), create);
    const id = JSON.parse(create.body).id;

    const patch = mockRes();
    await handler(
      mockReq({
        url: `/api/objectives/${id}`,
        method: "PATCH",
        body: { status: "awaiting_approval", proposed_scope: { sub_goals: [{ id: "sg1", title: "Overview", kind: "research" }] } },
      }),
      patch,
    );
    assert.equal(patch.statusCode, 200);
    const obj = db.getObjective(id);
    assert.equal(obj.status, "awaiting_approval");
    assert.match(obj.proposed_scope, /Overview/); // stored as JSON string
  });
});

test("objective document + pages over HTTP", async () => {
  await withHandler(async (handler) => {
    const create = mockRes();
    await handler(mockReq({ url: "/api/objectives", method: "POST", body: { goal: "g" } }), create);
    const id = JSON.parse(create.body).id;

    const docRes = mockRes();
    await handler(mockReq({ url: `/api/objectives/${id}/document`, method: "POST", body: { title: "Wiki" } }), docRes);
    const docId = JSON.parse(docRes.body).id;

    await handler(
      mockReq({ url: `/api/documents/${docId}/pages/overview`, method: "PUT", body: { title: "Overview", body_md: "hello" } }),
      mockRes(),
    );

    const pages = mockRes();
    await handler(mockReq({ url: `/api/objectives/${id}/document` }), pages);
    const payload = JSON.parse(pages.body);
    assert.equal(payload.pages.length, 1);
    assert.equal(payload.pages[0].body_md, "hello");
  });
});

test("objective approve resolves the scope checkpoint and resumes the anchor", async () => {
  await withHandler(async (handler, db) => {
    const create = mockRes();
    await handler(mockReq({ url: "/api/objectives", method: "POST", body: { goal: "g" } }), create);
    const obj = JSON.parse(create.body);

    // Simulate the autopilot raising a scope-approval checkpoint on the anchor.
    await handler(
      mockReq({ url: `/api/tasks/${obj.anchor_task_id}/checkpoints`, method: "POST", body: { kind: "approval", prompt: "scope?" } }),
      mockRes(),
    );
    assert.equal(db.getTask(obj.anchor_task_id).status, "on_hold");

    const approve = mockRes();
    await handler(mockReq({ url: `/api/objectives/${obj.id}/approve`, method: "POST", body: { decision: "approve" } }), approve);
    assert.equal(approve.statusCode, 200);
    assert.equal(JSON.parse(approve.body).success, true);
    // Anchor resumes once the checkpoint is resolved.
    assert.equal(db.getTask(obj.anchor_task_id).status, "inbox");

    // No pending checkpoint left → approving again is a 409.
    const again = mockRes();
    await handler(mockReq({ url: `/api/objectives/${obj.id}/approve`, method: "POST", body: { decision: "approve" } }), again);
    assert.equal(again.statusCode, 409);
  });
});
