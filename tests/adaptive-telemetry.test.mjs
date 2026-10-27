import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";
import { McEventBus } from "../src/events.ts";
import { startNotifier } from "../src/notifier.ts";

test("existing APIs persist routing/stage evidence and notify an actionable blocked question", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-adaptive-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  const events = new McEventBus();
  const sent = [];
  const stop = startNotifier(events, { sinks: [n => sent.push(n)] });
  try {
    db.initSchema(); db.seedDefaults();
    const handler = createHandler(db, { info() {}, error() {} }, events);
    const task = db.createTask({ title: "bounded mapping fix" });
    async function call(path, method, body) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { url: `/api/tasks/${task.id}/${path}`, method,
        headers: { host: "localhost", "sec-fetch-site": "same-origin" } });
      const res = { statusCode: 200, body: "", setHeader() {},
        writeHead(code) { this.statusCode=code; }, end(data) { this.body=data || ""; } };
      await handler(req,res);
      assert.ok(res.statusCode < 300, res.body);
      return JSON.parse(res.body);
    }
    const workflow = { workflow: "light", policy_version: "adaptive-bounded-v1",
      source: "jev", why: ["bounded backend mapping"] };
    await call("triage-state", "PATCH", { workflow });
    assert.deepEqual((await call("triage-state","GET")).workflow, workflow);
    for (const stage of ["trace", "plan", "implement", "checks", "review", "fix_findings", "draft_pr"]) {
      const metadata = { workflow_stage: stage, policy_version: workflow.policy_version };
      await call("activities", "POST", { activity_type:"updated", message:`workflow_stage: ${stage}`, metadata:JSON.stringify(metadata) });
      await call("progress", "PUT", { state:"running", phase:stage, step_label:`light:${stage}`, detail:`policy_version=${workflow.policy_version}` });
    }
    const progress = await call("progress", "GET");
    assert.equal(progress.step_label, "light:draft_pr");
    const activities = await call("activities", "GET");
    assert.equal(activities.filter(a => a.metadata && JSON.parse(a.metadata).workflow_stage).length, 7);
    const prompt = "Missing auth requirement: should expired sessions be rejected? Needed to verify the requested login behavior.";
    // pause:false exercises the decision+notification seam without controlling any runtime.
    const { checkpoint } = await call("checkpoints", "POST", { kind:"question", prompt, pause:false });
    assert.equal(checkpoint.status, "pending");
    const note = sent.find(n => n.type === "awaiting_approval");
    assert.ok(note);
    assert.equal(note.event.checkpointId, checkpoint.id);
    assert.equal(note.message, prompt);
  } finally {
    stop(); db.close(); rmSync(dir, { recursive:true, force:true });
  }
});
