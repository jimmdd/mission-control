import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const swarm = fileURLToPath(new URL("../swarm", import.meta.url));
function python(program) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(swarm)})
import bridge
${program}
`], { encoding: "utf8" }));
}

test("MET-790 approval resumes existing work before triage or planning, including blank approvals", () => {
  const result = python(`
entry = {"status": "paused", "heldAt": "2026-09-22T23:47:49Z"}
bridge._find_agent_registry_entry = lambda _: entry
bridge.mc_request = lambda *a: [{"status": "approved", "prompt": "Retry pre-review?", "response": "", "resolved_at": "2026-09-23T00:17:30Z"}]
bridge._read_planning_job = lambda _: None
calls = []
bridge._relaunch_for_change_request = lambda task, text, source: calls.append([task["id"], text, source]) or True
bridge._run_triage = lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not triage"))
bridge.check_for_answers = lambda *a: (_ for _ in ()).throw(AssertionError("must not plan"))
task = {"id": "met790", "title": "Mobile layout", "status": "inbox"}
bridge.process_task(task)
bridge.fetch_tasks_by_status = lambda _: [{**task, "status": "planning"}]
bridge.process_planning_tasks()
print(json.dumps(calls))
`);
  assert.equal(result.length, 2);
  for (const call of result) {
    assert.equal(call[2], "checkpoint");
    assert.match(call[1], /Retry pre-review/);
    assert.match(call[1], /approved/);
  }
});

test("pending or unavailable checkpoints cannot fall through to planning; stale decisions do not resume", () => {
  const result = python(`
bridge._find_agent_registry_entry = lambda _: {"status": "paused", "heldAt": "2026-09-23T00:00:00Z"}
bridge.mc_set_progress = lambda *a, **k: None
bridge._relaunch_for_change_request = lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not launch"))
task = {"id": "t"}
bridge.mc_request = lambda *a: [{"status": "pending"}]
pending = bridge._resume_checkpoint_work(task)
bridge.mc_request = lambda *a: [{"status": "approved", "resolved_at": "2026-09-22T00:00:00Z"}]
stale = bridge._resume_checkpoint_work(task)
bridge.mc_request = lambda *a: (_ for _ in ()).throw(RuntimeError("offline"))
offline = bridge._resume_checkpoint_work(task)
bridge._find_agent_registry_entry = lambda _: None
fresh = bridge._resume_checkpoint_work(task)
print(json.dumps([pending, stale, offline, fresh]))
`);
  assert.deepEqual(result, [true, false, true, false]);
});

test("checkpoint relaunch preserves the worktree and original instructions without assuming a PR exists", () => {
  const result = python(`
import subprocess
with tempfile.TemporaryDirectory() as root:
    bridge.SWARM_DIR = Path(root)
    work = Path(root) / "existing-work"
    work.mkdir()
    prompts = Path(root) / "prompts"
    prompts.mkdir()
    (prompts / "MET-790.md").write_text("Original task constraints: keep labels unchanged.")
    registry = [{"id": "MET-790", "mcTaskId": "t", "status": "paused", "worktree": str(work), "tmuxSession": "codex-MET-790", "launcher": "codex", "branch": "bugfix/MET-790", "deliveryPending": True, "heldAt": "old"}]
    (Path(root) / "active-tasks.json").write_text(json.dumps(registry))
    commands, updates = [], []
    bridge.subprocess.run = lambda args, **kw: commands.append(args) or subprocess.CompletedProcess(args, 0, "", "")
    bridge.mc_update_task = lambda tid, patch: updates.append(patch)
    bridge.mc_set_progress = lambda *a, **k: None
    bridge.mc_log_activity = lambda *a, **k: None
    for name in ["_design_prompt_section", "_video_prompt_section", "_supercut_prompt_section", "_attachment_prompt_section"]:
        setattr(bridge, name, lambda _: (_ for _ in ()).throw(AssertionError("must reuse original context")))
    ok = bridge._relaunch_for_change_request({"id": "t"}, "approved: retry pre-review", source="checkpoint")
    prompt = (prompts / "MET-790-change-request.md").read_text()
    saved = json.loads((Path(root) / "active-tasks.json").read_text())[0]
    print(json.dumps({"ok": ok, "prompt": prompt, "saved": saved, "commands": commands, "updates": updates}))
`);
  assert.equal(result.ok, true);
  assert.match(result.prompt, /keep labels unchanged/);
  assert.match(result.prompt, /approved: retry pre-review/);
  assert.match(result.prompt, /Do not restart triage or planning/);
  assert.doesNotMatch(result.prompt, /The reviewer has requested changes on your PR/);
  assert.equal(result.saved.status, "running");
  assert.equal(result.saved.deliveryPending, false);
  assert.equal(result.saved.branch, "bugfix/MET-790");
  assert.deepEqual(result.updates, [{ status: "in_progress" }]);
});

test("failed resume and a still-running legacy planner never fall through to a fresh plan", () => {
  const result = python(`
bridge._find_agent_registry_entry = lambda _: {"status": "paused", "heldAt": "2026-09-23T00:00:00Z"}
bridge.mc_request = lambda *a: [{"status": "answered", "prompt": "scope?", "response": "finish existing work", "resolved_at": "2026-09-23T01:00:00Z"}]
calls = []
bridge.mc_set_progress = lambda *a, **k: calls.append(k)
bridge._read_planning_job = lambda _: {"state": "running", "pid": 123}
bridge._pid_alive = lambda _: True
bridge._relaunch_for_change_request = lambda *a, **k: (_ for _ in ()).throw(AssertionError("planner still live"))
waiting = bridge._resume_checkpoint_work({"id": "t"})
bridge._read_planning_job = lambda _: None
bridge._relaunch_for_change_request = lambda *a, **k: False
failed = bridge._resume_checkpoint_work({"id": "t"})
bridge._find_agent_registry_entry = lambda _: {"status": "running", "heldAt": "2026-09-23T00:00:00Z"}
running = bridge._resume_checkpoint_work({"id": "t"})
print(json.dumps({"waiting": waiting, "failed": failed, "running": running, "progress": calls}))
`);
  assert.equal(result.waiting, true);
  assert.equal(result.failed, true);
  assert.equal(result.running, false);
  assert.equal(result.progress.length, 1);
  assert.equal(result.progress[0].state, "blocked");
});
