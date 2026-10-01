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
    const handler = createHandler(db, SILENT, events, { checkPrReadiness: async () => ({ status: "pass", reason: "fixture current-head gates passed" }) });
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
    const handler = createHandler(db, SILENT, events, { checkPrReadiness: async () => ({ status: "pass", reason: "fixture current-head gates passed" }) });

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

// ─────────── completion requires its deliverable ───────────

test("implementation completion is rejected until a PR is supplied", async () => {
  await withDb(async (db) => {
    const events = new McEventBus();
    const seen = [];
    events.subscribe((e) => { if (e.type === "task_completed") seen.push(e); });
    const handler = createHandler(db, SILENT, events, { checkPrReadiness: async () => ({ status: "pass", reason: "fixture current-head gates passed" }) });
    const ws = db.listWorkspaces?.()?.[0];
    const task = db.createTask({
      title: "ship the implementation",
      workspace_id: ws?.id ?? undefined,
      status: "in_progress",
      task_type: "implementation",
    });

    const missing = mockRes();
    await handler(mockReq({
      url: "/api/webhooks/agent-completion",
      method: "POST",
      body: { task_id: task.id, status: "review", summary: "done" },
    }), missing);
    assert.equal(missing.statusCode, 409);
    assert.equal(db.getTask(task.id).status, "in_progress");
    assert.equal(seen.length, 0);

    const supplied = mockRes();
    const prUrl = "https://github.com/acme/app/pull/42";
    await handler(mockReq({
      url: "/api/webhooks/agent-completion",
      method: "POST",
      body: { task_id: task.id, status: "review", summary: "done", pr_url: prUrl },
    }), supplied);
    assert.equal(supplied.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "review");
    assert.ok(db.listDeliverables(task.id).some((d) => d.deliverable_type === "pr" && d.path === prUrl));
  });
});

test("holding and deleting a task transition its runtime before mutating the board", async () => {
  await withDb(async (db) => {
    const calls = [];
    const handler = createHandler(db, SILENT, new McEventBus(), {
      transitionTaskRuntime: async (taskId, transition) => {
        calls.push([taskId, transition, db.getTask(taskId)?.status ?? "missing"]);
        return { matched: 1, stopped: 1 };
      },
    });
    const held = db.createTask({ title: "pause me", status: "in_progress" });
    const holdRes = mockRes();
    await handler(mockReq({
      url: `/api/tasks/${held.id}`,
      method: "PATCH",
      body: { status: "on_hold" },
    }), holdRes);
    assert.equal(holdRes.statusCode, 200);
    assert.equal(db.getTask(held.id).status, "on_hold");

    const deleted = db.createTask({ title: "remove me", status: "in_progress" });
    const deleteRes = mockRes();
    await handler(mockReq({ url: `/api/tasks/${deleted.id}`, method: "DELETE" }), deleteRes);
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(db.getTask(deleted.id), undefined);
    assert.deepEqual(calls, [
      [held.id, "hold", "in_progress"],
      [deleted.id, "delete", "in_progress"],
    ]);
  });
});

test("an agent completion callback cannot take a held task out of hold", async () => {
  await withDb(async (db) => {
    const handler = createHandler(db, SILENT, new McEventBus());
    const task = db.createTask({ title: "awaiting a person", status: "on_hold", task_type: "implementation" });
    const res = mockRes();
    await handler(mockReq({
      url: "/api/webhooks/agent-completion",
      method: "POST",
      body: {
        task_id: task.id,
        status: "review",
        pr_url: "https://github.com/acme/app/pull/77",
      },
    }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.getTask(task.id).status, "on_hold");
    assert.equal(db.listDeliverables(task.id).length, 0);
  });
});

test("an explicitly no-PR implementation may complete without a deliverable", async () => {
  await withDb(async (db) => {
    const handler = createHandler(db, SILENT, new McEventBus());
    const ws = db.listWorkspaces?.()?.[0];
    const task = db.createTask({
      title: "local-only migration",
      workspace_id: ws?.id ?? undefined,
      status: "in_progress",
      task_type: "implementation",
    });
    const res = mockRes();
    await handler(mockReq({
      url: "/api/webhooks/agent-completion",
      method: "POST",
      body: { task_id: task.id, summary: "done locally", no_pr: true },
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "review");
  });
});

// ─────────── terminal completion is announced once ───────────
// Returning an agent run to review is not the same as closing the ticket. MET-640
// went through several automated review/fix cycles, and every cycle used to emit
// `task_completed`, producing a misleading Telegram "done" alert each time.

test("review cycles stay quiet and a true done transition is announced once", async () => {
  await withDb(async (db) => {
    const events = new McEventBus();
    const seen = [];
    events.subscribe((e) => { if (e.type === "task_completed") seen.push(e); });
    const handler = createHandler(db, SILENT, events, { checkPrReadiness: async () => ({ status: "pass", reason: "fixture current-head gates passed" }) });

    const ws = db.listWorkspaces?.()?.[0];
    const task = db.createTask({
      title: "navbar",
      workspace_id: ws?.id ?? undefined,
      status: "in_progress",
    });

    const post = async (status = "review") => {
      const res = mockRes();
      await handler(mockReq({
        url: "/api/webhooks/agent-completion",
        method: "POST",
        body: {
          task_id: task.id,
          status,
          summary: "done",
          pr_url: "https://github.com/acme/app/pull/43",
        },
      }), res);
      return res;
    };

    const first = await post();
    assert.ok(first.statusCode < 400, `first call failed: ${first.statusCode} ${first.body}`);
    assert.equal(seen.length, 0, "returning to review must not announce the ticket as done");
    assert.equal(db.getTask(task.id).status, "review");
    assert.deepEqual(db.listEvents(10).map((event) => event.type), ["agent_run_completed"]);

    const done = await post("done");
    assert.ok(done.statusCode < 400, `done call failed: ${done.statusCode} ${done.body}`);
    assert.equal(db.getTask(task.id).status, "done");
    assert.equal(seen.length, 1, "the true terminal transition is announced");
    assert.equal(seen[0].status, "done");
    assert.ok(db.listEvents(10).some((event) => event.type === "task_completed"));

    // Retrying either webhook cannot announce another terminal completion.
    await post();
    await post("done");
    assert.equal(seen.length, 1, "repeat calls must not re-announce");
    assert.equal(db.getTask(task.id).status, "done", "and must not regress the status");
  });
});

test("marking a reviewed task done emits the terminal notification once", async () => {
  await withDb(async (db) => {
    const events = new McEventBus();
    const seen = [];
    events.subscribe((e) => { if (e.type === "task_completed") seen.push(e); });
    const handler = createHandler(db, SILENT, events, { checkPrReadiness: async () => ({ status: "pass", reason: "fixture current-head gates passed" }) });
    const task = db.createTask({ title: "reviewed ticket", status: "review" });

    const done = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/done`, method: "POST", body: {} }), done);
    assert.equal(done.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, "done");

    const retry = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/done`, method: "POST", body: {} }), retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(seen.length, 1, "an idempotent done request stays quiet");
  });
});

test("an unknown progress state is rejected, not silently dropped", async () => {
  await withDb(async (db) => {
    const handler = createHandler(db, SILENT, new McEventBus());
    const ws = db.listWorkspaces?.()?.[0];
    const task = db.createTask({ title: "t", workspace_id: ws?.id ?? undefined, status: "in_progress" });

    const post = async (bodyIn) => {
      const res = mockRes();
      await handler(mockReq({ url: `/api/tasks/${task.id}/progress`, method: "POST", body: bodyIn }), res);
      return res;
    };

    await post({ state: "blocked", blocked_reason: "waiting on a human" });
    assert.equal(db.getProgress(task.id).state, "blocked");

    // "planning" is a task status, not a progress state. Dropping it left the task
    // blocked while the write reported success — which cost a debugging cycle.
    const bad = await post({ state: "planning", phase: "planning" });
    assert.equal(bad.statusCode, 400, "an unknown state must be refused");
    assert.match(bad.body, /Unknown progress state: planning/);
    assert.equal(db.getProgress(task.id).state, "blocked", "and must not be written");

    const good = await post({ state: "running", phase: "planning" });
    assert.ok(good.statusCode < 400);
    assert.equal(db.getProgress(task.id).state, "running");
  });
});

for (const gate of ["ci_failed", "pending", "unknown", "review_required", "review_blocked"]) {
  test(`completion stays in Testing when PR readiness is ${gate}`, async () => {
    await withDb(async (db) => {
      const task = db.createTask({ title: "PR gate", status: "in_progress", task_type: "implementation" });
      const handler = createHandler(db, SILENT, new McEventBus(), {
        checkPrReadiness: async () => ({status: gate, reason: "fixture blocker"}),
      });
      const res = mockRes();
      await handler(mockReq({url:"/api/webhooks/agent-completion",method:"POST",body:{task_id:task.id,status:"done",pr_url:"https://github.com/acme/app/pull/1"}}),res);
      assert.equal(res.statusCode,409);
      assert.equal(db.getTask(task.id).status,"testing");
      assert.equal(db.listDeliverables(task.id).length,1);
      assert.equal(db.listEvents(10).some(e=>e.type === "task_completed"),false);
    });
  });
}
test("hold during readiness lookup wins over an agent completion", async () => {
  await withDb(async (db) => {
    const task = db.createTask({title:"hold race",status:"in_progress",task_type:"implementation"});
    const handler = createHandler(db,SILENT,new McEventBus(),{checkPrReadiness:async()=>{
      db.updateTask(task.id,{status:"on_hold"});return {status:"pass",reason:"fixture"};
    }});
    const res=mockRes();
    await handler(mockReq({url:"/api/webhooks/agent-completion",method:"POST",body:{task_id:task.id,pr_url:"https://github.com/acme/app/pull/1"}}),res);
    assert.equal(res.statusCode,409);assert.equal(db.getTask(task.id).status,"on_hold");
  });
});

test("a task completed during readiness lookup cannot be reopened", async () => {
  await withDb(async (db) => {
    const task = db.createTask({title:"done race",status:"in_progress",task_type:"implementation"});
    const handler = createHandler(db,SILENT,new McEventBus(),{checkPrReadiness:async()=>{
      db.updateTask(task.id,{status:"done"});return {status:"pass",reason:"fixture"};
    }});
    const res=mockRes();
    await handler(mockReq({url:"/api/webhooks/agent-completion",method:"POST",body:{task_id:task.id,pr_url:"https://github.com/acme/app/pull/1"}}),res);
    assert.equal(res.statusCode,200);assert.equal(db.getTask(task.id).status,"done");
    assert.equal(JSON.parse(res.body).new_status,"done");
  });
});
