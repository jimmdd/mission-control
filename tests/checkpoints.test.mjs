import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";
import { McEventBus } from "../src/events.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "mc-checkpoints-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  const events = new McEventBus();
  try {
    return await fn(createHandler(db, SILENT, events), db, events);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("raising a checkpoint pauses the task and emits awaiting_approval", async () => {
  await withHandler(async (handler, db, events) => {
    const seen = [];
    events.subscribe((e) => seen.push(e));
    const task = db.createTask({ title: "deploy", status: "in_progress" });

    const res = mockRes();
    await handler(
      mockReq({
        url: `/api/tasks/${task.id}/checkpoints`,
        method: "POST",
        body: { kind: "approval", prompt: "Push to production?" },
      }),
      res,
    );
    assert.equal(res.statusCode, 201);
    const payload = JSON.parse(res.body);
    assert.equal(payload.paused, true);
    assert.equal(payload.checkpoint.status, "pending");

    assert.equal(db.getTask(task.id).status, "on_hold");
    assert.equal(db.getProgress(task.id).state, "waiting");
    assert.ok(seen.some((e) => e.type === "awaiting_approval" && e.taskId === task.id));

    // pending inbox lists it
    const inbox = mockRes();
    await handler(mockReq({ url: "/api/checkpoints?status=pending" }), inbox);
    assert.equal(JSON.parse(inbox.body).length, 1);
  });
});

test("a needs_human activity always creates one actionable checkpoint", async () => {
  await withHandler(async (handler, db, events) => {
    const seen = [];
    events.subscribe((e) => seen.push(e));
    const task = db.createTask({ title: "draft decision", status: "review" });
    const body = {
      activity_type: "needs_human",
      message: "Choose the focus-ring treatment",
      options: ["inverse ring", "plain outline", "accept as-is"],
    };

    const first = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/activities`, method: "POST", body }), first);
    assert.equal(first.statusCode, 201);

    const checkpoints = db.listCheckpoints(task.id);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].status, "pending");
    assert.equal(checkpoints[0].kind, "choice");
    assert.deepEqual(JSON.parse(checkpoints[0].options), body.options);
    assert.equal(db.getTask(task.id).status, "review", "a draft-PR decision stays in review");

    const activity = JSON.parse(first.body);
    assert.equal(JSON.parse(activity.metadata).checkpoint_id, checkpoints[0].id);
    assert.ok(seen.some((e) =>
      e.type === "needs_human" && e.checkpointId === checkpoints[0].id));

    // Retrying the same escalation can repeat the notification activity, but must
    // never stack duplicate decisions in the ticket.
    await handler(mockReq({ url: `/api/tasks/${task.id}/activities`, method: "POST", body }), mockRes());
    assert.equal(db.listCheckpoints(task.id).length, 1);
  });
});

test("a blocking needs_human activity pauses active work", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "blocked work", status: "in_progress" });
    await handler(mockReq({
      url: `/api/tasks/${task.id}/activities`,
      method: "POST",
      body: { activity_type: "needs_human", message: "Need an API key" },
    }), mockRes());

    assert.equal(db.getTask(task.id).status, "on_hold");
    assert.equal(db.getProgress(task.id).state, "waiting");
    assert.equal(db.countPendingCheckpoints(task.id), 1);
  });
});

test("approving a checkpoint resumes the task and records the decision", async () => {
  await withHandler(async (handler, db, events) => {
    const seen = [];
    events.subscribe((e) => seen.push(e));
    const task = db.createTask({ title: "deploy", status: "in_progress" });

    const create = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/checkpoints`, method: "POST", body: { prompt: "ok?" } }), create);
    const checkpointId = JSON.parse(create.body).checkpoint.id;

    const resolve = mockRes();
    await handler(
      mockReq({ url: `/api/checkpoints/${checkpointId}/resolve`, method: "POST", body: { decision: "approve", response: "go for it" } }),
      resolve,
    );
    assert.equal(resolve.statusCode, 200);
    assert.equal(JSON.parse(resolve.body).checkpoint.status, "approved");

    // Task resumed (no other pending checkpoints) and progress cleared.
    assert.equal(db.getTask(task.id).status, "inbox");
    assert.equal(db.getProgress(task.id).state, "running");
    assert.ok(seen.some((e) => e.type === "checkpoint_resolved"));
    const acts = db.listActivities(task.id).map((a) => a.activity_type);
    assert.ok(acts.includes("checkpoint_raised"));
    assert.ok(acts.includes("checkpoint_resolved"));
  });
});

test("draft PR checkpoint can move directly to human review", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "draft", status: "on_hold" });
    const checkpoint = db.createCheckpoint({
      task_id: task.id,
      kind: "choice",
      prompt: "A draft PR already exists for this task:\nhttps://github.com/acme/backend/pull/42",
    });

    const res = mockRes();
    await handler(mockReq({
      url: `/api/checkpoints/${checkpoint.id}/resolve`, method: "POST",
      body: { decision: "answer", response: "Move to review (I'll finish the PR myself)" },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "review");
    assert.equal(db.getProgress(task.id).state, "waiting");
  });
});

test("draft PR checkpoint can authorize an agent to reuse the PR", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "draft", status: "on_hold" });
    const checkpoint = db.createCheckpoint({
      task_id: task.id,
      kind: "choice",
      prompt: "A draft PR already exists for this task:\nhttps://github.com/acme/backend/pull/43",
    });

    const res = mockRes();
    await handler(mockReq({
      url: `/api/checkpoints/${checkpoint.id}/resolve`, method: "POST",
      body: { decision: "answer", response: "Let an agent continue on top of this PR" },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "inbox");
    const reuse = db.listActivities(task.id).find((activity) => activity.activity_type === "pr_reuse_requested");
    assert.equal(JSON.parse(reuse.metadata).pr_url, "https://github.com/acme/backend/pull/43");
  });
});

test("a checkpoint cannot be resolved twice", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "t" });
    const create = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/checkpoints`, method: "POST", body: { prompt: "x" } }), create);
    const id = JSON.parse(create.body).checkpoint.id;

    const first = mockRes();
    await handler(mockReq({ url: `/api/checkpoints/${id}/resolve`, method: "POST", body: { decision: "reject" } }), first);
    assert.equal(first.statusCode, 200);

    const second = mockRes();
    await handler(mockReq({ url: `/api/checkpoints/${id}/resolve`, method: "POST", body: { decision: "approve" } }), second);
    assert.equal(second.statusCode, 409);
  });
});

test("task stays paused until ALL its checkpoints are resolved", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "t", status: "in_progress" });
    const c1 = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/checkpoints`, method: "POST", body: { prompt: "a" } }), c1);
    const c2 = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/checkpoints`, method: "POST", body: { prompt: "b" } }), c2);
    const id1 = JSON.parse(c1.body).checkpoint.id;
    const id2 = JSON.parse(c2.body).checkpoint.id;

    await handler(mockReq({ url: `/api/checkpoints/${id1}/resolve`, method: "POST", body: { decision: "approve" } }), mockRes());
    assert.equal(db.getTask(task.id).status, "on_hold"); // still one pending

    await handler(mockReq({ url: `/api/checkpoints/${id2}/resolve`, method: "POST", body: { decision: "approve" } }), mockRes());
    assert.equal(db.getTask(task.id).status, "inbox"); // all resolved -> resume
  });
});

test("completing a task cancels obsolete pending checkpoints", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "already shipped", status: "in_progress" });
    const create = mockRes();
    await handler(mockReq({
      url: `/api/tasks/${task.id}/checkpoints`, method: "POST",
      body: { kind: "question", prompt: "Which release sequence?" },
    }), create);

    const done = mockRes();
    await handler(mockReq({
      url: `/api/tasks/${task.id}`, method: "PATCH", body: { status: "done" },
    }), done);

    assert.equal(done.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "done");
    assert.equal(db.countPendingCheckpoints(task.id), 0);
    const [checkpoint] = db.listCheckpoints(task.id);
    assert.equal(checkpoint.status, "cancelled");
    assert.equal(checkpoint.response, "Cancelled because the task was completed.");
    assert.ok(checkpoint.resolved_at);
  });
});

test("idempotent completion repairs stale checkpoints and completed tasks reject new ones", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "closed elsewhere", status: "done" });
    const stale = db.createCheckpoint({ task_id: task.id, prompt: "Old approval" });

    const done = mockRes();
    await handler(mockReq({
      url: `/api/tasks/${task.id}/done`, method: "POST", body: { reason: "PR closed" },
    }), done);

    assert.equal(done.statusCode, 200);
    assert.equal(JSON.parse(done.body).alreadyDone, true);
    assert.equal(db.getCheckpoint(stale.id).status, "cancelled");
    assert.equal(db.countPendingCheckpoints(task.id), 0);

    const create = mockRes();
    await handler(mockReq({
      url: `/api/tasks/${task.id}/checkpoints`, method: "POST", body: { prompt: "Late approval" },
    }), create);
    assert.equal(create.statusCode, 409);
    assert.match(JSON.parse(create.body).error, /completed tasks/i);
    assert.equal(db.countPendingCheckpoints(task.id), 0);
  });
});

test("board reports awaitingApproval and per-task pending checkpoint counts", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "mc-home-"));
  const prevHome = process.env.MC_HOME;
  process.env.MC_HOME = homeDir;
  try {
    await withHandler(async (handler, db) => {
      const task = db.createTask({ title: "t" });
      await handler(mockReq({ url: `/api/tasks/${task.id}/checkpoints`, method: "POST", body: { prompt: "approve?" } }), mockRes());

      const res = mockRes();
      await handler(mockReq({ url: "/api/board" }), res);
      const board = JSON.parse(res.body);
      assert.equal(board.summary.awaitingApproval, 1);
      const t = board.tasks.find((x) => x.id === task.id);
      assert.equal(t.pending_checkpoints, 1);
    });
  } finally {
    if (prevHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
