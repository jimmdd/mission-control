import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const LINEAR_SYNC = fileURLToPath(new URL("../integrations/linear/linear-sync.py", import.meta.url));

function runPython(program) {
  return JSON.parse(execFileSync("python3", ["-c", `
import importlib.util
import json
import sys
import types

# The sync module's completion path does not use Context Fabrica or embeddings,
# but those optional runtime integrations are imported at module load time.
context_fabrica = types.ModuleType("context_fabrica_config")
context_fabrica.context_fabrica_dsn = lambda: ""
context_fabrica.make_context_fabrica_adapter = lambda *args, **kwargs: None
sys.modules["context_fabrica_config"] = context_fabrica
sys.modules["embeddings"] = types.ModuleType("embeddings")

spec = importlib.util.spec_from_file_location("linear_sync_under_test", ${JSON.stringify(LINEAR_SYNC)})
linear_sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linear_sync)

${program}
`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}

test("marking an MC task done moves its linked Linear issue to Done exactly once", () => {
  const result = runPython(`
calls = []

def fake_linear_query(query, variables=None):
    if "workflowStates" in query:
        return {"workflowStates": {"nodes": [
            {"id": "completed-state", "name": "Completed", "type": "completed"},
            {"id": "done-state", "name": "Done", "type": "completed"},
        ]}}
    calls.append({"query": query, "variables": variables})
    if "issueUpdate" in query:
        return {"issueUpdate": {"success": True}}
    return {"commentCreate": {"success": True}}

linear_sync.linear_query = fake_linear_query
linear_sync.fetch_issue_comments = lambda issue_id: []
linear_sync._COMPLETED_STATE_CACHE.clear()

issue = {
    "id": "linear-issue-id",
    "identifier": "MET-999",
    "state": {"name": "In Review", "type": "started"},
    "team": {"key": "MET"},
}
task = {"id": "mc-task-id", "status": "done"}
state = {}

linear_sync.sync_status_back(task, issue, state)
linear_sync.sync_status_back(task, issue, state)

print(json.dumps({"calls": calls, "state": state}))
`);

  const updates = result.calls.filter(({ query }) => query.includes("issueUpdate"));
  const comments = result.calls.filter(({ query }) => query.includes("commentCreate"));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].variables, {
    id: "linear-issue-id",
    stateId: "done-state",
  });
  assert.equal(comments.length, 1);
  assert.equal(result.state.completion_state_synced["linear-issue-id"], true);
  assert.equal(result.state.completion_posted["linear-issue-id"], true);
});

test("a non-done MC task never changes Linear", () => {
  const result = runPython(`
calls = []
linear_sync.linear_query = lambda query, variables=None: calls.append(query) or {}
linear_sync.fetch_issue_comments = lambda issue_id: []
linear_sync.sync_status_back(
    {"id": "mc-task-id", "status": "review"},
    {"id": "linear-issue-id", "state": {"type": "started"}, "team": {"key": "MET"}},
    {},
)
print(json.dumps(calls))
`);
  assert.deepEqual(result, []);
});

test("an MC-closed task moves its linked Linear issue to Canceled without a completion comment", () => {
  const result = runPython(`
calls = []

def fake_linear_query(query, variables=None):
    if "workflowStates" in query:
        return {"workflowStates": {"nodes": [
            {"id": "wont-do", "name": "Won't Do", "type": "canceled"},
            {"id": "closed-state", "name": "Closed", "type": "canceled"},
        ]}}
    calls.append({"query": query, "variables": variables})
    return {"issueUpdate": {"success": True}}

linear_sync.linear_query = fake_linear_query
linear_sync._CANCELED_STATE_CACHE.clear()
issue = {
    "id": "linear-issue-id",
    "identifier": "MET-998",
    "state": {"name": "In Review", "type": "started"},
    "team": {"key": "MET"},
}
state = {}
linear_sync.sync_status_back({"id": "mc-task-id", "status": "closed"}, issue, state)
linear_sync.sync_status_back({"id": "mc-task-id", "status": "closed"}, issue, state)
print(json.dumps({"calls": calls, "state": state}))
`);

  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0].query, /issueUpdate/);
  assert.deepEqual(result.calls[0].variables, {
    id: "linear-issue-id",
    stateId: "closed-state",
  });
  assert.equal(result.state.closure_state_synced["linear-issue-id"], true);
  assert.equal(result.state.completion_posted, undefined);
});

/**
 * Drive sync()'s reconcile pass in isolation: the main loop is fed no issues, so
 * every existing MC task falls through to the reconciliation that decides what to
 * do about a task whose Linear issue is no longer in the fetch.
 */
function runReconcile(issueResponse) {
  return runPython(`
mc_calls = []

def fake_linear_query(query, variables=None):
    if "archivedAt" in query:
        return json.loads(${JSON.stringify(JSON.stringify(issueResponse))})
    return {}

def fake_mc_request(method, path, body=None):
    mc_calls.append({"method": method, "path": path, "body": body})
    return {}

linear_sync.setup_logging = lambda: None
linear_sync.load_env = lambda: None
linear_sync._apply_linear_env_overrides = lambda: None
linear_sync.verify_workspace = lambda: True
linear_sync.load_state = lambda: {"synced_issues": {}}
linear_sync.save_state = lambda state: None
linear_sync._check_research_results = lambda state: None
linear_sync.fetch_labeled_issues = lambda: []
linear_sync.get_existing_mc_tasks = lambda: {
    "linear-uuid": {"id": "mc-task-id", "status": "planning", "external_id": "linear-uuid"},
}
linear_sync.linear_query = fake_linear_query
linear_sync.mc_request = fake_mc_request

linear_sync.sync()
print(json.dumps({"mc_calls": mc_calls}))
`);
}

test("a ticket deleted in Linear closes its MC task", () => {
  // Linear's "delete" archives the issue: it keeps the workflow state it had, so a
  // ticket deleted out of Backlog still reports `backlog` and no state-type check
  // can see it. archivedAt is the only signal.
  const { mc_calls } = runReconcile({
    issue: { archivedAt: "2026-08-21T19:36:46.061Z", state: { type: "backlog", name: "Backlog" } },
  });

  const patch = mc_calls.find(c => c.method === "PATCH");
  assert.ok(patch, "the MC task must be closed, not left running against a deleted ticket");
  assert.equal(patch.path, "/api/tasks/mc-task-id");
  assert.deepEqual(patch.body, { status: "closed" });

  const activity = mc_calls.find(c => c.method === "POST" && c.path.endsWith("/activities"));
  assert.ok(activity, "closing a task silently gives no way to find out why later");
  assert.match(activity.body.message, /deleted \(archived\)/);
  assert.match(activity.body.message, /syncing to closed/);
});

test("a canceled Linear issue closes its MC task while a completed issue marks it done", () => {
  const canceled = runReconcile({
    issue: { archivedAt: null, state: { type: "canceled", name: "Canceled" } },
  });
  assert.deepEqual(canceled.mc_calls.find(c => c.method === "PATCH").body, { status: "closed" });

  const completed = runReconcile({
    issue: { archivedAt: null, state: { type: "completed", name: "Done" } },
  });
  assert.deepEqual(completed.mc_calls.find(c => c.method === "PATCH").body, { status: "done" });
});

test("an issue that merely fell out of the fetch filter is left running", () => {
  // The regression that matters in the other direction: reassigning a ticket away
  // from a watched user also removes it from the fetch, and that must not read as
  // a deletion and kill live work.
  const { mc_calls } = runReconcile({
    issue: { archivedAt: null, state: { type: "started", name: "In Progress" } },
  });
  assert.deepEqual(mc_calls, []);
});

test("an issue Linear will not resolve is reported, not closed", () => {
  // A null issue and an issue hidden by a permissions change are indistinguishable
  // from here, so this reports rather than ending work on a guess.
  const { mc_calls } = runReconcile({ issue: null });
  assert.deepEqual(mc_calls, []);
});

test("triage questions are posted once and only deduped after Linear confirms the write", () => {
  const result = runPython(`
linear_sync.os.environ["LINEAR_API_KEY"] = "test-key"
linear_sync.os.environ["LINEAR_INTERACTION"] = "updates"
calls = []

def fake_linear_query(query, variables=None):
    calls.append({"query": query, "variables": variables})
    return {"commentCreate": {"success": True}}

linear_sync.linear_query = fake_linear_query
triage = {"questions": [
    {"id": "q1", "question": "Which repository?", "options": ["backend", "frontend"]},
    {"id": "q2", "question": "Which base branch?", "options": []},
]}
state = {}

linear_sync._post_initial_triage_questions("issue-1", "task-1", triage, state, False)
linear_sync._post_initial_triage_questions("issue-1", "task-1", triage, state, False)

failed_state = {}
linear_sync.linear_query = lambda query, variables=None: {}
linear_sync._post_initial_triage_questions("issue-2", "task-2", triage, failed_state, False)

print(json.dumps({"calls": calls, "state": state, "failed_state": failed_state}))
`);

  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0].variables.body, /Which repository\?/);
  assert.equal(result.state.initial_questions_posted["issue-1"], "q1,q2");
  assert.deepEqual(result.failed_state.initial_questions_posted, {});
});

test("a Linear reply can answer an MC triage question", () => {
  const result = runPython(`
linear_sync.os.environ["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-key"
linear_sync._call_gemini = lambda prompt, api_key: json.dumps([
    {"id": "q1", "answer": "Use the backend repository"}
])
calls = []

def fake_mc_request(method, path, body=None):
    calls.append({"method": method, "path": path, "body": body})
    return {}

linear_sync.mc_request = fake_mc_request
count = linear_sync._try_auto_answer_triage(
    "task-1",
    {"questions": [{"id": "q1", "question": "Which repository?", "answer": None}]},
    {"id": "comment-1", "body": "Please use backend"},
)
print(json.dumps({"count": count, "calls": calls}))
`);

  assert.equal(result.count, 1);
  assert.deepEqual(result.calls, [{
    method: "PATCH",
    path: "/api/tasks/task-1/triage-state",
    body: { questionId: "q1", answer: "Use the backend repository" },
  }]);
});

test("triage consolidation preserves unrelated MC bot replies and runs once", () => {
  const result = runPython(`
linear_sync.os.environ["LINEAR_API_KEY"] = "test-key"
linear_sync.os.environ["LINEAR_INTERACTION"] = "updates"
calls = []
linear_sync.fetch_issue_comments = lambda issue_id: [
    {"id": "triage-comment", "body": linear_sync.BOT_REPLY_PREFIX + ": I need a few answers before I can start"},
    {"id": "research-comment", "body": linear_sync.BOT_REPLY_PREFIX + " (research): keep this answer"},
    {"id": "human-comment", "body": "backend please"},
]

def fake_linear_query(query, variables=None):
    calls.append({"query": query, "variables": variables})
    if "commentDelete" in query:
        return {"commentDelete": {"success": True}}
    return {"commentCreate": {"success": True}}

linear_sync.linear_query = fake_linear_query
triage = {"questions": [{"id": "q1", "question": "Which repo?", "answer": "backend"}]}
task = {"id": "task-1", "status": "in_progress"}
state = {}
linear_sync._finalize_triage_comments("issue-1", task, triage, state)
linear_sync._finalize_triage_comments("issue-1", task, triage, state)
print(json.dumps({"calls": calls, "state": state}))
`);

  const creates = result.calls.filter(({ query }) => query.includes("commentCreate"));
  const deletes = result.calls.filter(({ query }) => query.includes("commentDelete"));
  assert.equal(creates.length, 1);
  assert.deepEqual(deletes.map(({ variables }) => variables.id), ["triage-comment"]);
  assert.equal(result.state.triage_finalized["issue-1"], true);
});

test("deleted Linear comment IDs stay removed from sync state", () => {
  const result = runPython(`
linear_sync.fetch_issue_comments = lambda issue_id: [{
    "id": "live-comment",
    "body": linear_sync.BOT_REPLY_PREFIX + ": still live",
    "user": None,
    "botActor": {"name": "Mission Control", "type": "application"},
}]
linear_sync._fetch_triage_state = lambda task_id: None
state = {
    "synced_comments": {"issue-1": ["live-comment", "deleted-comment"]},
    "answered_comments": {"issue-1": ["deleted-answer"]},
}
linear_sync.sync_comments_to_mc(
    {"id": "issue-1", "title": "Ticket"},
    {"id": "task-1", "status": "review"},
    state,
)
print(json.dumps(state))
`);

  assert.deepEqual(result.synced_comments["issue-1"], ["live-comment"]);
  assert.deepEqual(result.answered_comments["issue-1"], []);
});

test("Linear issue creation is deterministic and a retry resolves the same issue", () => {
  const result = runPython(`
linear_sync.os.environ["LINEAR_INTERACTION"] = "updates"
issue = {
    "id": "",
    "identifier": "MET-700",
    "title": "Fix payout totals",
    "description": "Totals are stale",
    "url": "https://linear.app/issue/MET-700",
    "priority": 0,
    "team": {"id": "team-id", "key": "MET", "name": "MetaDAO"},
    "assignee": {"id": "user-id", "name": "Jinglun", "email": "jinglun@metadao.fi"},
}
stored = {}
calls = []

def fake_linear_query(query, variables=None):
    calls.append({"query": query, "variables": variables})
    if "issue(id:$id)" in query:
        return {"issue": stored.get(variables["id"])}
    if "teams(first:2" in query:
        return {"teams": {"nodes": [{"id": "team-id", "key": "MET", "name": "MetaDAO"}]}}
    if "users(first:250)" in query:
        return {"users": {"nodes": [{"id": "user-id", "name": "Jinglun", "email": "jinglun@metadao.fi", "active": True}]}}
    if "issueCreate" in query:
        created = dict(issue)
        created["id"] = variables["input"]["id"]
        stored[created["id"]] = created
        return {"issueCreate": {"success": True, "issue": created}}
    raise RuntimeError("unexpected query")

linear_sync.linear_query = fake_linear_query
first = linear_sync.create_linear_issue(
    "Fix payout totals", "Totals are stale", "telegram:555:991", "MET", "jinglun@metadao.fi"
)
second = linear_sync.create_linear_issue(
    "Fix payout totals", "Totals are stale", "telegram:555:991", "MET", "jinglun@metadao.fi"
)
creates = [call for call in calls if "issueCreate" in call["query"]]
print(json.dumps({"first": first, "second": second, "creates": creates}))
`);

  assert.equal(result.first.created, true);
  assert.equal(result.second.created, false);
  assert.equal(result.first.issue.id, result.second.issue.id);
  assert.equal(result.creates.length, 1);
  assert.equal(result.creates[0].variables.input.teamId, "team-id");
  assert.equal(result.creates[0].variables.input.assigneeId, "user-id");
});
