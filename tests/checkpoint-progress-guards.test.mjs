import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";
import { McEventBus } from "../src/events.ts";

async function fixture(fn, dependencies = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-checkpoint-guards-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  const events = new McEventBus();
  const seen = [];
  events.subscribe(event => seen.push(event));
  const handler = createHandler(db, { info() {}, error() {} }, events, dependencies);
  const request = async (url, method, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url, method, headers: { host: "localhost" } });
    const res = { statusCode: 200, body: "", setHeader() {}, writeHead(status) { this.statusCode = status; }, end(body) { this.body = body ?? ""; } };
    await handler(req, res);
    return res;
  };
  try { await fn({ db, seen, request }); }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("agent progress cannot erase an unanswered question or mark it done", async () => {
  await fixture(async ({ db, request }) => {
    const task = db.createTask({ title: "Need canonical slug", status: "in_progress" });
    const checkpoint = db.createCheckpoint({ task_id: task.id, kind: "question", prompt: "Confirm the real organization slug" });
    db.upsertProgress(task.id, { state: "waiting", blocked_reason: checkpoint.prompt });
    for (const state of ["done", "running", "delegating"]) {
      const res = await request(`/api/tasks/${task.id}/progress`, "PUT", { state, blocked_reason: "" });
      assert.equal(res.statusCode, 409);
      assert.equal(JSON.parse(res.body).checkpoint_id, checkpoint.id);
      assert.equal(db.getProgress(task.id).state, "waiting");
      assert.equal(db.getProgress(task.id).blocked_reason, checkpoint.prompt);
      assert.equal(db.getCheckpoint(checkpoint.id).status, "pending");
    }
    const metadata = await request(`/api/tasks/${task.id}/progress`, "PATCH", { phase: "verify", blocked_reason: "" });
    assert.equal(metadata.statusCode, 200);
    assert.equal(db.getProgress(task.id).state, "waiting");
    assert.equal(db.getProgress(task.id).blocked_reason, checkpoint.prompt);
    db.resolveCheckpoint(checkpoint.id, "answered", "slug: confirmed-record");
    const completed = await request(`/api/tasks/${task.id}/progress`, "PUT", { state: "done" });
    assert.equal(completed.statusCode, 200);
    assert.equal(db.getProgress(task.id).state, "done");
  });
});

test("status updates cannot resume a task before its checkpoint is resolved", async () => {
  await fixture(async ({ db, request }) => {
    const task = db.createTask({ title: "Paused decision", status: "on_hold" });
    const checkpoint = db.createCheckpoint({ task_id: task.id, prompt: "Choose the delivery handoff" });
    for (const status of ["inbox", "planning", "assigned", "in_progress", "testing", "review"]) {
      const res = await request(`/api/tasks/${task.id}`, "PATCH", { status });
      assert.equal(res.statusCode, 409);
      assert.equal(db.getTask(task.id).status, "on_hold");
    }
    assert.equal(db.getCheckpoint(checkpoint.id).status, "pending");
    db.resolveCheckpoint(checkpoint.id, "answered", "Continue the approved handoff");
    const res = await request(`/api/tasks/${task.id}`, "PATCH", { status: "in_progress" });
    assert.equal(res.statusCode, 200);
  });
});

test("a completion callback cannot complete an active task with an unanswered question", async () => {
  await fixture(async ({ db, seen, request }) => {
    const task = db.createTask({ title: "Implementation", status: "in_progress", task_type: "implementation" });
    const checkpoint = db.createCheckpoint({ task_id: task.id, prompt: "Confirm identity" });
    db.upsertProgress(task.id, { state: "blocked", blocked_reason: checkpoint.prompt });
    const res = await request("/api/webhooks/agent-completion", "POST", { task_id: task.id, status: "done", no_pr: true });
    assert.equal(res.statusCode, 409);
    assert.equal(db.getTask(task.id).status, "in_progress");
    assert.equal(db.getProgress(task.id).state, "blocked");
    assert.equal(db.getCheckpoint(checkpoint.id).status, "pending");
    assert.equal(seen.some(event => event.type === "task_completed"), false);
  });
});

test("a checkpoint raised during PR verification wins over a completion claim", async () => {
  let dbForGate;
  await fixture(async ({ db, request }) => {
    dbForGate = db;
    const task = db.createTask({ title: "Concurrent question", status: "in_progress", task_type: "implementation" });
    const res = await request("/api/webhooks/agent-completion", "POST", { task_id: task.id, status: "done", pr_url: "https://github.com/acme/app/pull/1" });
    assert.equal(res.statusCode, 409);
    assert.equal(db.getTask(task.id).status, "in_progress");
    assert.equal(db.listCheckpoints(task.id)[0].status, "pending");
  }, { checkPrReadiness: async () => {
    const task = dbForGate.listTasks()[0];
    dbForGate.createCheckpoint({ task_id: task.id, prompt: "New decision during verification" });
    return { status: "pass", reason: "fixture checks pass" };
  } });
});

test("automated merged-PR completion preserves a newly raised checkpoint", async () => {
  await fixture(async ({ db, request }) => {
    const task = db.createTask({ title: "Merged delivery with a question", status: "review" });
    const checkpoint = db.createCheckpoint({ task_id: task.id, prompt: "Confirm release acceptance" });
    const res = await request(`/api/tasks/${task.id}/done`, "POST", { automated: true, reason: "Linked PR merged" });
    assert.equal(res.statusCode, 409);
    assert.equal(db.getTask(task.id).status, "review");
    assert.equal(db.getCheckpoint(checkpoint.id).status, "pending");
  });
});

test("legacy session completion cannot erase a non-pausing question", async () => {
  await fixture(async ({ db, request }) => {
    const agent = db.createAgent({ name: "Fixture agent", role: "engineer", status: "working" });
    db.createSession({ agent_id: agent.id, session_id: "fixture-active-session" });
    const task = db.createTask({ title: "Question on an active task", status: "in_progress", assigned_agent_id: agent.id });
    const checkpoint = db.createCheckpoint({ task_id: task.id, prompt: "Confirm identity before delivery" });
    const res = await request("/api/webhooks/agent-completion", "POST", { session_id: "fixture-active-session", message: "TASK_COMPLETE: Assets prepared" });
    assert.equal(res.statusCode, 409);
    assert.equal(db.getTask(task.id).status, "in_progress");
    assert.equal(db.getCheckpoint(checkpoint.id).status, "pending");
    assert.equal(db.getAgent(agent.id).status, "working");
    assert.equal(db.listEvents(10).length, 0);
  });
});
