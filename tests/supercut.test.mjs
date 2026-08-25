import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";


const repoRoot = new URL("..", import.meta.url).pathname;

function python(code, input) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: repoRoot,
    input: input == null ? undefined : JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("Supercut link extraction accepts only canonical share URLs", () => {
  const links = python(`
import json, sys
sys.path.insert(0, "swarm")
import supercut
print(json.dumps(supercut.extract_links(json.load(sys.stdin)["text"])))
`, {
    text: [
      "https://supercut.ai/share/team/good123).",
      "https://supercut.ai/share/short123",
      "https://supercut.ai.evil.test/share/team/bad",
      "https://evil.test/https://supercut.ai/share/team/embedded",
      "https://supercut.ai/share/team/too/deep",
      "https://supercut.ai/share/team/good123",
    ].join(" "),
  });
  assert.deepEqual(links, [
    "https://supercut.ai/share/team/good123",
    "https://supercut.ai/share/short123",
  ]);
});

test("Mission Control prefers Codex for read-only Supercut MCP context and reuses it in agent prompts", () => {
  const result = python(`
import json, sys
from types import SimpleNamespace
sys.path.insert(0, "swarm")
import bridge

link = "https://supercut.ai/share/team/abc123"
bridge._gather_supercut_links = lambda task_id, description: [link]
calls = []
def fake_run(argv, **kwargs):
    calls.append({"argv": argv, "kwargs": kwargs})
    return SimpleNamespace(stdout="SUPERCUT_OK\\nThe recording asks for a clearer mobile empty state.", stderr="", returncode=0)
bridge.subprocess.run = fake_run

context = bridge._supercut_context("task-1", link)
section = bridge._supercut_prompt_section({"id": "task-1", "description": link})
print(json.dumps({"section": section, "context": context, "calls": calls}))
`);

  assert.match(result.section, /Use the `supercut` MCP/);
  assert.match(result.section, /clearer mobile empty state/);
  assert.match(result.section, /get-recording/);
  assert.match(result.section, /get-transcript/);
  assert.match(result.section, /list-comments/);
  assert.doesNotMatch(result.section, /API token|decoded the recording|native HTTP/i);
  assert.match(result.context, /read through the Supercut MCP/);
  assert.match(result.context, /clearer mobile empty state/);
  assert.equal(result.calls.length, 1, "the successful MCP summary is cached for later prompts");
  const call = result.calls[0];
  assert.match(call.argv[0], /(?:^|\/)codex$/);
  assert.deepEqual(call.argv.slice(1, 4), ["exec", "--sandbox", "read-only"]);
  assert.ok(call.argv.includes("--ephemeral"));
  assert.ok(call.argv.includes("--skip-git-repo-check"));
  assert.match(call.argv.join(" "), /mcp_servers\.supercut\.enabled_tools/);
  assert.match(call.argv.at(-1), /Use only the available Supercut MCP tools/);
  assert.equal(call.kwargs.stdin, -3, "the MCP reader stays non-interactive");
});

test("Mission Control falls back to Claude with Supercut's hyphenated read-only tool names", () => {
  const result = python(`
import json, sys
from types import SimpleNamespace
sys.path.insert(0, "swarm")
import bridge

link = "https://supercut.ai/share/team/abc123"
bridge._gather_supercut_links = lambda task_id, description: [link]
calls = []
def fake_run(argv, **kwargs):
    calls.append({"argv": argv, "kwargs": kwargs})
    if argv[0].endswith("codex"):
        return SimpleNamespace(stdout="", stderr="Supercut OAuth unavailable", returncode=1)
    if argv[1:3] == ["mcp", "list"]:
        return SimpleNamespace(stdout="supercut: https://mcp.supercut.ai/mcp (HTTP) - ✔ Connected\\n", stderr="", returncode=0)
    return SimpleNamespace(stdout="SUPERCUT_OK\\nThe recording shows the save button overlapping the footer.", stderr="", returncode=0)
bridge.subprocess.run = fake_run

context = bridge._supercut_context("task-1", link)
print(json.dumps({"context": context, "calls": calls}))
`);

  assert.match(result.context, /save button overlapping the footer/);
  assert.match(result.calls[0].argv[0], /(?:^|\/)codex$/, "Codex is attempted before Claude");
  const claude = result.calls.find((call) => call.argv[0].endsWith("claude") && call.argv[1] === "-p");
  assert.ok(claude, "Claude is used only after Codex fails");
  assert.match(claude.argv[3], /mcp__supercut__get-recording/);
  assert.match(claude.argv[3], /mcp__supercut__get-transcript/);
  assert.doesNotMatch(claude.argv[3], /get_recording|add-playlist-recording/);
  assert.equal(claude.kwargs.stdin, -3, "the fallback stays non-interactive");
});

test("bridge injects MCP-backed Supercut context across triage, planning, and agents", () => {
  const source = readFileSync(new URL("../swarm/bridge.py", import.meta.url), "utf8");
  assert.match(source, /codebase_context \+= _supercut_context\(task_id, description\)/);
  assert.match(source, /return prompt \+ _supercut_prompt_section\(task\)/);
  assert.match(source, /supercut_section, supercut_provider, has_supercut = _supercut_planning_section\(task\)/);
  assert.match(source, /"provider": supercut_provider/);
  assert.ok((source.match(/_supercut_prompt_section\(task\)/g) || []).length >= 3);
  assert.doesNotMatch(source, /supercut\.load_share|SUPERCUT_API_TOKEN/);
});

test("a Supercut planning job uses the MCP runtime that successfully read the recording", () => {
  const result = python(`
import json, pathlib, sys, tempfile
from types import SimpleNamespace
sys.path.insert(0, "swarm")
import bridge

link = "https://supercut.ai/share/team/abc123"
bridge._SUPERCUT_SUMMARY_CACHE.clear()
bridge._gather_supercut_links = lambda task_id, description: [link]
bridge._build_triage_context = lambda task_id: ""
bridge._attachment_prompt_section = lambda task: ""
bridge._ticket_plan_mode = lambda task_id: ""
bridge._task_questions = lambda task_id: []
bridge.mc_update_task = lambda *args, **kwargs: None
bridge.mc_set_progress = lambda *args, **kwargs: None
bridge.mc_log_activity = lambda *args, **kwargs: None
bridge.subprocess.run = lambda argv, **kwargs: SimpleNamespace(
    stdout="SUPERCUT_OK\\nThe recording asks for a clearer mobile empty state.",
    stderr="", returncode=0)
class Process:
    pid = 43210
bridge.subprocess.Popen = lambda *args, **kwargs: Process()

with tempfile.TemporaryDirectory() as td:
    job = pathlib.Path(td) / "task.job.json"
    bridge._start_planning_job(
        {"id": "task-1", "title": "Recorded feedback", "description": link},
        pathlib.Path(td), job)
    payload = json.loads(job.read_text())
print(json.dumps({"provider": payload.get("provider"),
                  "supercut_mcp": payload.get("supercut_mcp"),
                  "context": payload.get("context", "")}))
`);

  assert.equal(result.provider, "codex");
  assert.equal(result.supercut_mcp, true);
  assert.match(result.context, /MCP-fetched summary/);
});

test("triage asks for and persists a task/issues/solution brief", () => {
  const result = python(`
import json, sys
sys.path.insert(0, "swarm")
import bridge

captured = {}
def fake_gemini(prompt, **kwargs):
    captured["prompt"] = prompt
    return json.dumps({
        "ready": True,
        "repos": [{"project": "GitProjects", "repo": "backend"}],
        "questions": [],
        "reasoning": "The recording and target app make the work clear.",
        "brief": {
            "task": "Apply the recorded company-page feedback.",
            "issues": "Typography, tabs, and badge placement differ from the recording.",
            "solution": "Update the scoped styles and components to match the demonstrated states.",
        },
    })
bridge.call_gemini = fake_gemini
triage = bridge.triage_task("Company page feedback", "Supercut context", "GitProjects/backend")

saved = {}
def fake_request(method, path, data=None):
    if method == "GET":
        return {}
    saved.update(data or {})
    return data
bridge.mc_request = fake_request
bridge.post_planning_questions("task-1", [], triage_result=triage)
print(json.dumps({"prompt": captured["prompt"], "saved": saved}))
`);

  assert.match(result.prompt, /"brief"/);
  assert.match(result.prompt, /requested work, observed issues, and proposed implementation approach/i);
  assert.deepEqual(result.saved.triage_brief, {
    task: "Apply the recorded company-page feedback.",
    issues: "Typography, tabs, and badge placement differ from the recording.",
    solution: "Update the scoped styles and components to match the demonstrated states.",
  });
});
