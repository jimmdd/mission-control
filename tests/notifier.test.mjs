import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";
import { McEventBus } from "../src/events.ts";
import { startNotifier } from "../src/notifier.ts";

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

test("notifier pushes human-relevant events and ignores routine ones", () => {
  const events = new McEventBus();
  const sent = [];
  const stop = startNotifier(events, { sinks: [(n) => sent.push(n)] });

  events.emit("progress", { taskId: "t1" }); // routine, ignored
  events.emit("needs_human", { taskId: "t1", message: "need an API key" });
  events.emit("awaiting_approval", { taskId: "t2", prompt: "open the PR?" });
  events.emit("agent_exited", { taskId: "t3", reason: "tmux gone" });
  stop();

  const types = sent.map((n) => n.type);
  assert.deepEqual(types.sort(), ["agent_exited", "awaiting_approval", "needs_human"]);
  const needsHuman = sent.find((n) => n.type === "needs_human");
  assert.match(needsHuman.title, /needs you/i);
  assert.equal(needsHuman.message, "need an API key");
  assert.equal(needsHuman.taskId, "t1");
});

test("notifier rate-limits repeated events for the same task", () => {
  const events = new McEventBus();
  const sent = [];
  const stop = startNotifier(events, { sinks: [(n) => sent.push(n)], cooldownMs: 60_000 });

  events.emit("agent_stalled", { taskId: "t1", reason: "no heartbeat for 300s" });
  events.emit("agent_stalled", { taskId: "t1", reason: "no heartbeat for 360s" }); // within cooldown -> dropped
  events.emit("agent_stalled", { taskId: "t2", reason: "no heartbeat for 300s" }); // different task -> sent
  stop();

  assert.equal(sent.filter((n) => n.taskId === "t1").length, 1);
  assert.equal(sent.filter((n) => n.taskId === "t2").length, 1);
});

test("a needs_human activity emits a notifiable event end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-notify-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  try {
    db.initSchema();
    db.seedDefaults();
    const events = new McEventBus();
    const sent = [];
    const stop = startNotifier(events, { sinks: [(n) => sent.push(n)] });
    const handler = createHandler(db, SILENT, events);

    const task = db.createTask({ title: "blocked task" });
    await handler(
      mockReq({
        url: `/api/tasks/${task.id}/activities`,
        method: "POST",
        body: { activity_type: "needs_human", message: "which auth flow should I use?" },
      }),
      mockRes(),
    );
    stop();

    const note = sent.find((n) => n.type === "needs_human" && n.taskId === task.id);
    assert.ok(note, "needs_human activity should produce a notification");
    assert.equal(note.message, "which auth flow should I use?");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
