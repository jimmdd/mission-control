// Lifecycle boundaries must be evidence-based. An agent process saying "done" is
// not the same thing as an implementation being reviewable, and redispatch must
// never erase commits or dirty files from an interrupted attempt.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function python(program, input) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
${program}
`], {
    input: JSON.stringify(input),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  }));
}

test("implementation completion requires a PR unless no-PR mode was explicit", () => {
  const result = python(`
from completion_policy import completion_action
print(json.dumps({
    "missing": completion_action("implementation", False, ""),
    "with_pr": completion_action("implementation", False, "https://github.com/o/r/pull/1"),
    "no_pr": completion_action("implementation", True, ""),
    "investigation": completion_action("investigation", False, ""),
}))
`, null);
  assert.deepEqual(result, {
    missing: "resume",
    with_pr: "review",
    no_pr: "review",
    investigation: "review",
  });
});

test("only the latest triage reset may reuse its recorded PR", () => {
  const result = python(`
import bridge
bridge.fetch_task_activities = lambda _: [
    {"activity_type": "triage_reset", "created_at": "2026-08-21T10:00:00Z",
     "metadata": json.dumps({"pr_url": "https://github.com/acme/backend/pull/1",
                              "pr_disposition": "reuse_if_same_repo"})},
    {"activity_type": "triage_reset", "created_at": "2026-08-21T11:00:00Z", "metadata": None},
]
print(json.dumps({
    "url": bridge._latest_reset_pr("task"),
    "same_repo": bridge._pr_matches_repos("https://github.com/acme/backend/pull/1",
                                            [{"project": "GitProjects", "repo": "backend"}]),
    "other_repo": bridge._pr_matches_repos("https://github.com/acme/backend/pull/1",
                                             [{"project": "GitProjects", "repo": "dashboard"}]),
}))
`, null);
  assert.deepEqual(result, { url: "", same_repo: true, other_repo: false });
});

test("an explicit checkpoint decision authorizes reuse of its draft PR", () => {
  const result = python(`
import bridge
bridge.fetch_task_activities = lambda _: [
    {"activity_type": "pr_reuse_requested", "created_at": "2026-08-21T11:00:00Z",
     "metadata": json.dumps({"pr_url": "https://github.com/acme/backend/pull/42",
                              "pr_disposition": "reuse_if_same_repo"})},
]
print(json.dumps({"url": bridge._latest_reset_pr("task")}))
`, null);
  assert.equal(result.url, "https://github.com/acme/backend/pull/42");
});

test("a ticket PR URL resolves an open designer handoff with exact repo and branches", () => {
  const result = python(`
import bridge
from pathlib import Path
from types import SimpleNamespace
bridge.discover_local_repos = lambda: [{
    "project": "GitProjects", "repo": "backend", "path": Path("/tmp/backend"),
}]
bridge._origin_url = lambda _: "git@github.com:acme/backend.git"
def run(args, **kwargs):
    return SimpleNamespace(returncode=0, stdout=json.dumps({
        "url": "https://github.com/acme/backend/pull/77",
        "isDraft": True, "state": "OPEN", "number": 77,
        "title": "Designer handoff", "headRefName": "design/account-page",
        "baseRefName": "master", "headRepository": {"nameWithOwner": "acme/backend"},
        "headRepositoryOwner": {"login": "acme"}, "isCrossRepository": False,
    }), stderr="")
bridge.subprocess.run = run
task = {"title": "MET-777 Continue design", "description": "Continue existing PR https://github.com/acme/backend/pull/77"}
print(json.dumps(bridge._existing_pr_handoff(task, refresh=True)))
`, null);
  assert.equal(result.url, "https://github.com/acme/backend/pull/77");
  assert.equal(result.is_draft, true);
  assert.equal(result.branch, "design/account-page");
  assert.equal(result.base_branch, "master");
  assert.deepEqual(result.local_repo, { project: "GitProjects", repo: "backend" });
});

test("an explicit open PR handoff needs human approval before it dispatches", () => {
  // The handoff still bypasses the *ordinary* PR interception (that guard must not
  // even run), but a live PR is someone's work: finding its URL in the ticket text
  // is not consent. Unapproved it parks with a checkpoint; approved it dispatches.
  const result = python(`
import bridge
calls = []
base = {
    "url": "https://github.com/acme/backend/pull/77", "repo": "acme/backend",
    "number": 77, "title": "Designer handoff", "state": "OPEN",
    "branch": "design/account-page", "base_branch": "master",
    "head_repo": "acme/backend", "is_cross_repository": False,
    "local_repo": {"project": "GitProjects", "repo": "backend"},
}
bridge._local_repo_for_handoff = lambda _: {"project": "GitProjects", "repo": "backend"}
bridge._fetch_handoff_head = lambda _: True
bridge._gh_handoff_pr = lambda _: {**base, "is_draft": current_draft}
bridge._find_existing_pr = lambda *_: (_ for _ in ()).throw(RuntimeError("ordinary PR guard must not run"))
bridge.mc_request = lambda method, path, body=None: calls.append([method, path, body])
repos = [{"project": "GitProjects", "repo": "backend"}]

# No prior approval on record.
bridge._latest_reset_pr = lambda _: ""
unapproved = []
for current_draft in (True, False):
    task = {"id": "aaaaaaaa-0000", "title": "MET-777 Continue", "description": base["url"],
            "triage_state": {"existing_pr_handoff": {**base, "is_draft": current_draft}}}
    unapproved.append(bridge._pr_guard(task, repos))

# The human answered "Let an agent continue on top of this PR" on this exact PR.
bridge._latest_reset_pr = lambda _: base["url"]
approved = []
for current_draft in (True, False):
    task = {"id": "aaaaaaaa-0000", "title": "MET-777 Continue", "description": base["url"],
            "triage_state": {"existing_pr_handoff": {**base, "is_draft": current_draft}}}
    approved.append(bridge._pr_guard(task, repos))

checkpoints = [c for c in calls if c[0] == "POST" and str(c[1]).endswith("/checkpoints")]
print(json.dumps({
    "unapproved": unapproved,
    "approved": approved,
    "checkpoints": checkpoints,
    "calls": calls,
}))
`, null);
  // [draft, ready]. A draft is parked work handed over for an agent to continue,
  // so it needs no permission; only a ready PR costs a question.
  assert.deepEqual(result.unapproved, [true, false], "a draft continues freely; an unapproved ready PR must not dispatch");
  assert.deepEqual(result.approved, [true, true], "an approved ready PR dispatches without re-asking");
  assert.ok(result.calls.some(([, path]) => path.endsWith("/triage-state")));

  // The checkpoint must offer the exact strings routes.ts keys the reuse decision
  // off; different wording would record an answer that never unblocks the task.
  assert.equal(result.checkpoints.length, 1, "only the ready PR raises a checkpoint");
  const [, , body] = result.checkpoints[0];
  assert.match(body.prompt, /https:\/\/github\.com\/acme\/backend\/pull\/77/);
  assert.ok(body.options.includes("Let an agent continue on top of this PR"));
  assert.ok(body.options.includes("Move to review (I'll finish the PR myself)"));
  assert.equal(body.pause, true);
});

test("a PR linked in Linear resolves even though the ticket carries no github URL", () => {
  // Linear renders a linked PR as a <pull-request> element whose visible text is
  // `owner/repo#N`, and the tag is stripped before the description reaches MC — so
  // these tickets arrive with no github.com URL at all. Without the shorthand
  // fallback they resolve to no handoff and the agent invents its own branch
  // instead of continuing the PR the ticket is about (MET-657, MET-660).
  const result = python(`
import bridge, json

linked = {"id": "aaaaaaaa-0000", "title": "Review focus-ring polish",
          "description": "Review the treatment in metaDAOproject/backend#713."}

# A stated URL must win outright. This ticket names #710 as its target and only
# mentions #709 as prose ("stacked on"); reading both would look like two PRs and
# block a ticket that named its target plainly (MET-658).
mixed = {"id": "aaaaaaaa-0001", "title": "Harden trade surface",
         "description": ("Finish https://github.com/metaDAOproject/backend/pull/710 . "
                         "It is stacked on metaDAOproject/backend#709.")}

# Source paths and line/step anchors are not PR references.
noise = {"id": "aaaaaaaa-0002", "title": "Polish",
         "description": "edit apps/new-ui/src/app.css, see foo.ts#L20 and docs/guide#step2"}

# Two shorthands and no URL is genuinely ambiguous and must stay blocking.
ambiguous = {"id": "aaaaaaaa-0003", "title": "Reconcile",
             "description": "Reconcile metaDAOproject/backend#709 with metaDAOproject/backend#708."}

print(json.dumps({
    "linked": bridge._ticket_pr_urls(linked),
    "mixed": bridge._ticket_pr_urls(mixed),
    "noise": bridge._ticket_pr_urls(noise),
    "ambiguous": len(bridge._ticket_pr_urls(ambiguous)),
}))
`, null);

  assert.deepEqual(result.linked, ["https://github.com/metaDAOproject/backend/pull/713"],
    "the Linear shorthand must resolve when no URL is present");
  assert.deepEqual(result.mixed, ["https://github.com/metaDAOproject/backend/pull/710"],
    "a stated URL wins; a neighbouring PR mentioned in prose must not join it");
  assert.deepEqual(result.noise, [], "paths and anchors are not PR references");
  assert.equal(result.ambiguous, 2, "two shorthands and no URL stays ambiguous, so the guard still blocks");
});

test("closed or ambiguous PR handoffs stop dispatch with a Linear-visible triage question", () => {
  const result = python(`
import bridge
paused = []
bridge._pause_for_pr_handoff = lambda task, handoff: paused.append(handoff)
bridge._local_repo_for_handoff = lambda _: {"project": "GitProjects", "repo": "backend"}
closed = {
    "url": "https://github.com/acme/backend/pull/77", "repo": "acme/backend",
    "number": 77, "state": "CLOSED", "branch": "design/account-page",
    "base_branch": "master", "head_repo": "acme/backend", "is_cross_repository": False,
}
bridge._gh_handoff_pr = lambda _: closed
task = {"id": "aaaaaaaa-0000", "title": "MET-777 Continue", "description": closed["url"]}
closed_result = bridge._pr_guard(task, [{"project": "GitProjects", "repo": "backend"}])
ambiguous = bridge._existing_pr_handoff({
    "title": "MET-778", "description": "Use https://github.com/acme/backend/pull/1 and https://github.com/acme/backend/pull/2"
})
print(json.dumps({"closed_result": closed_result, "paused": paused, "ambiguous": ambiguous}))
`, null);
  assert.equal(result.closed_result, false);
  assert.match(result.paused[0].error, /closed/i);
  assert.match(result.ambiguous.error, /more than one/i);
});

test("a Linear answer can select the corrected PR without editing the stale ticket description", () => {
  const result = python(`
import bridge
task = {
    "title": "MET-779 Continue",
    "description": "Wrong link https://github.com/acme/backend/pull/1",
    "triage_state": {
        "existing_pr_handoff": {"url": "https://github.com/acme/backend/pull/1", "error": "closed"},
        "questions": [{"id": "existing_pr_handoff", "answer": "Use https://github.com/acme/backend/pull/2 instead"}],
    },
}
print(json.dumps({"urls": bridge._ticket_pr_urls(task)}))
`, null);
  assert.deepEqual(result.urls, ["https://github.com/acme/backend/pull/2"]);
});

test("existing PR spawn checks out the PR head but reviews against its base", () => {
  const result = python(`
import bridge, tempfile
from pathlib import Path
from types import SimpleNamespace
root = Path(tempfile.mkdtemp(prefix="mc-pr-handoff-"))
bridge.SWARM_DIR = root
calls = []
def run(args, **kwargs):
    calls.append({"args": [str(v) for v in args], "env": kwargs.get("env", {})})
    return SimpleNamespace(returncode=0, stdout="", stderr="")
bridge.subprocess.run = run
bridge._resolve_spawn_failure_checkpoints = lambda *_: None
meta = {"url": "https://github.com/acme/backend/pull/77", "branch": "design/account-page", "base_branch": "master"}
ok = bridge.spawn_agent("task", "MET-777-backend", Path("/tmp/backend"), "Implement the ticket.",
    mc_task_id="task", task_title="MET-777 Continue", base_branch="origin/master",
    existing_pr_url=meta["url"], existing_pr_meta=meta)
prompt = (root / "prompts" / "MET-777-backend.md").read_text()
generated = bridge.generate_prompt({
    "id": "task", "title": "MET-777 Continue", "description": "Continue the design",
    "triage_state": {"existing_pr_handoff": meta},
}, "repo context", "GitProjects", "backend", plan_ready=True)
call = calls[0]
print(json.dumps({"ok": ok, "args": call["args"],
                  "env": {k: call["env"].get(k) for k in ("BASE_BRANCH", "WORKTREE_BASE_REF", "PR_BASE_BRANCH", "MC_EXISTING_PR_URL")},
                  "prompt": prompt, "generated": generated}))
`, null);
  assert.equal(result.ok, true);
  assert.equal(result.args[3], "design/account-page");
  assert.equal(result.args[4], "codex", "implementation spawns default to the Codex profile");
  assert.deepEqual(result.env, {
    BASE_BRANCH: "origin/master",
    WORKTREE_BASE_REF: "origin/design/account-page",
    PR_BASE_BRANCH: "master",
    MC_EXISTING_PR_URL: "https://github.com/acme/backend/pull/77",
  });
  assert.match(result.prompt, /update it, do not replace it/i);
  assert.match(result.prompt, /Do not run `gh pr create`/);
  assert.match(result.generated, /Update the existing PR/);
  assert.doesNotMatch(result.generated, /Create a PR with `gh pr create`/);
});

test("dispatch reopens the reset PR instead of creating an orphan replacement", () => {
  const result = python(`
import bridge
from types import SimpleNamespace
calls = []
def run(args, **kwargs):
    calls.append(args)
    if args[2] == "view":
        return SimpleNamespace(returncode=0, stdout=json.dumps({
            "url": "https://github.com/acme/backend/pull/42", "isDraft": True,
            "state": "CLOSED", "number": 42, "headRefName": "bugfix/MET-42-backend",
        }), stderr="")
    return SimpleNamespace(returncode=0, stdout="", stderr="")
bridge.subprocess.run = run
pr = bridge._reopen_reset_pr("https://github.com/acme/backend/pull/42")
print(json.dumps({"pr": pr, "calls": calls}))
`, null);
  assert.equal(result.pr.url, "https://github.com/acme/backend/pull/42");
  assert.equal(result.pr.branch, "bugfix/MET-42-backend");
  assert.equal(result.calls[0][2], "view");
  assert.equal(result.calls[1][2], "reopen");
  assert.ok(result.calls.every(args => !args.includes("create")));
});

test("redispatch reuses a worktree that contains partial commits and dirty files", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-lifecycle-"));
  const repo = join(root, "repo");
  const first = join(root, "worktrees", "MET-643-backend");
  const requestedAgain = join(root, "worktrees", "replacement-path");
  try {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.invalid");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "app.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");

    const create = python(`
from worktree_prepare import prepare_worktree
repo, desired = json.loads(sys.stdin.read())
print(json.dumps(prepare_worktree(repo, desired, "feature/MET-643-backend", "main")))
`, [repo, first]);
    assert.equal(create.reused, false);
    assert.equal(create.path, realpathSync(first));

    writeFileSync(join(first, "app.txt"), "committed partial work\n");
    git(first, "add", "app.txt");
    git(first, "commit", "-qm", "partial implementation");
    writeFileSync(join(first, "unfinished.txt"), "still working\n");

    const resumed = python(`
from worktree_prepare import prepare_worktree
repo, desired = json.loads(sys.stdin.read())
print(json.dumps(prepare_worktree(repo, desired, "feature/MET-643-backend", "main")))
`, [repo, requestedAgain]);

    assert.equal(resumed.reused, true);
    assert.equal(resumed.path, realpathSync(first), "the branch holder is the recoverable source of truth");
    assert.equal(git(first, "rev-list", "--count", "main..HEAD"), "1");
    assert.equal(readFileSync(join(first, "unfinished.txt"), "utf8"), "still working\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a done ticket releases its clean managed worktree but retains the branch", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cleanup-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktrees", "MET-700-repo");
  const registry = join(root, "state", "active-tasks.json");
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.invalid");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "app.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "feature/MET-700-repo", worktree, "main");
    mkdirSync(join(worktree, "node_modules", "package"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "package", "cache"), "generated\n");
    writeFileSync(registry, JSON.stringify([{
      id: "MET-700-repo",
      mcTaskId: "aaaaaaaa-0000-0000-0000-000000000000",
      status: "running",
      repo,
      worktree,
      branch: "feature/MET-700-repo",
      tmuxSession: "agent-MET-700-repo",
    }]));

    const result = python(`
from pathlib import Path
from worktree_cleanup import cleanup_completed_worktrees
registry, state_tool = json.loads(sys.stdin.read())
stopped = []
rows = cleanup_completed_worktrees(
    Path(registry), Path(state_tool), "http://mc.invalid",
    status_lookup=lambda *_: "done",
    is_session_active=lambda _: True,
    stop_active_session=lambda session: stopped.append(session) is None,
    activity_poster=lambda *_: None,
)
print(json.dumps({"rows": rows, "stopped": stopped}))
`, [registry, join(SWARM, "swarm-state.py")]);

    assert.deepEqual(result.rows, [{ task: "MET-700-repo", result: "removed", reason: "ticket_done" }]);
    assert.deepEqual(result.stopped, ["agent-MET-700-repo"]);
    assert.equal(readFileSync(registry, "utf8").trim(), "[]");
    assert.equal(git(repo, "show-ref", "--verify", "--quiet", "refs/heads/feature/MET-700-repo"), "");
    assert.throws(() => realpathSync(worktree));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a done ticket stops retrying but preserves a dirty worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cleanup-dirty-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktrees", "MET-701-repo");
  const registry = join(root, "state", "active-tasks.json");
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.invalid");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "app.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "feature/MET-701-repo", worktree, "main");
    writeFileSync(join(worktree, "unfinished.txt"), "preserve me\n");
    writeFileSync(registry, JSON.stringify([{
      id: "MET-701-repo",
      mcTaskId: "bbbbbbbb-0000-0000-0000-000000000000",
      status: "running",
      repo,
      worktree,
      branch: "feature/MET-701-repo",
      tmuxSession: "agent-MET-701-repo",
    }]));

    const result = python(`
from pathlib import Path
from worktree_cleanup import cleanup_completed_worktrees
registry, state_tool = json.loads(sys.stdin.read())
rows = cleanup_completed_worktrees(
    Path(registry), Path(state_tool), "http://mc.invalid",
    status_lookup=lambda *_: "done",
    is_session_active=lambda _: False,
    activity_poster=lambda *_: None,
)
print(json.dumps(rows))
`, [registry, join(SWARM, "swarm-state.py")]);

    assert.deepEqual(result, [{ task: "MET-701-repo", result: "preserved", reason: "dirty_worktree" }]);
    assert.equal(readFileSync(join(worktree, "unfinished.txt"), "utf8"), "preserve me\n");
    const saved = JSON.parse(readFileSync(registry, "utf8"))[0];
    assert.equal(saved.status, "done", "a closed ticket must never respawn");
    assert.equal(saved.cleanupBlocked, "dirty_worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a done ticket with an unmanaged path is terminalized and never deleted", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cleanup-unmanaged-"));
  const repo = join(root, "repo");
  const registry = join(root, "state", "active-tasks.json");
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.invalid");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "keep.txt"), "main checkout\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    writeFileSync(registry, JSON.stringify([{
      id: "MET-702-repo",
      mcTaskId: "cccccccc-0000-0000-0000-000000000000",
      status: "running",
      repo,
      worktree: repo,
      branch: "main",
      tmuxSession: "agent-MET-702-repo",
    }]));

    const result = python(`
from pathlib import Path
from worktree_cleanup import cleanup_completed_worktrees
registry, state_tool = json.loads(sys.stdin.read())
stopped = []
rows = cleanup_completed_worktrees(
    Path(registry), Path(state_tool), "http://mc.invalid",
    status_lookup=lambda *_: "done",
    is_session_active=lambda _: True,
    stop_active_session=lambda session: stopped.append(session) is None,
    activity_poster=lambda *_: None,
)
print(json.dumps({"rows": rows, "stopped": stopped}))
`, [registry, join(SWARM, "swarm-state.py")]);

    assert.deepEqual(result.rows, [{ task: "MET-702-repo", result: "preserved", reason: "unmanaged_path" }]);
    assert.deepEqual(result.stopped, ["agent-MET-702-repo"]);
    assert.equal(readFileSync(join(repo, "keep.txt"), "utf8"), "main checkout\n");
    const saved = JSON.parse(readFileSync(registry, "utf8"))[0];
    assert.equal(saved.status, "done");
    assert.equal(saved.cleanupBlocked, "unmanaged_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted ticket is terminalized, stopped, and does not post to the missing task", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cleanup-deleted-"));
  const registry = join(root, "active-tasks.json");
  try {
    writeFileSync(registry, JSON.stringify([{
      id: "MET-703-repo",
      mcTaskId: "dddddddd-0000-0000-0000-000000000000",
      status: "running",
      repo: "",
      worktree: "",
      tmuxSession: "agent-MET-703-repo",
    }]));
    const result = python(`
from pathlib import Path
from worktree_cleanup import cleanup_completed_worktrees
registry, state_tool = json.loads(sys.stdin.read())
stopped, activities = [], []
rows = cleanup_completed_worktrees(
    Path(registry), Path(state_tool), "http://mc.invalid",
    status_lookup=lambda *_: "deleted",
    is_session_active=lambda _: True,
    stop_active_session=lambda session: stopped.append(session) is None,
    activity_poster=lambda *args: activities.append(args),
)
saved = json.loads(Path(registry).read_text())[0]
print(json.dumps({"rows": rows, "stopped": stopped, "activities": activities, "status": saved["status"]}))
`, [registry, join(SWARM, "swarm-state.py")]);
    assert.deepEqual(result.rows, [{ task: "MET-703-repo", result: "preserved", reason: "missing_paths" }]);
    assert.deepEqual(result.stopped, ["agent-MET-703-repo"]);
    assert.deepEqual(result.activities, []);
    assert.equal(result.status, "deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged cleanup blocker produces no registry or activity noise", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cleanup-quiet-"));
  const registry = join(root, "active-tasks.json");
  try {
    writeFileSync(registry, JSON.stringify([{
      id: "MET-704-repo",
      mcTaskId: "eeeeeeee-0000-0000-0000-000000000000",
      status: "done",
      cleanupBlocked: "missing_paths",
      repo: "",
      worktree: "",
      tmuxSession: "",
    }]));
    const result = python(`
from pathlib import Path
import worktree_cleanup
registry, state_tool = json.loads(sys.stdin.read())
updates, activities = [], []
worktree_cleanup.update_state = lambda *args: updates.append(args) or True
rows = worktree_cleanup.cleanup_completed_worktrees(
    Path(registry), Path(state_tool), "http://mc.invalid",
    status_lookup=lambda *_: "done",
    is_session_active=lambda _: False,
    activity_poster=lambda *args: activities.append(args),
)
print(json.dumps({"rows": rows, "updates": len(updates), "activities": len(activities)}))
`, [registry, join(SWARM, "swarm-state.py")]);
    assert.deepEqual(result.rows, [{ task: "MET-704-repo", result: "preserved", reason: "missing_paths" }]);
    assert.deepEqual({ updates: result.updates, activities: result.activities }, { updates: 0, activities: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the monitor runs completed-ticket cleanup before its running-agent loop", () => {
  const source = readFileSync(join(SWARM, "check-agents.sh"), "utf8");
  assert.match(source, /cleanup-worktrees\.sh/);
  assert.ok(source.indexOf('"$CLEANUP_TOOL"') < source.indexOf("RUNNING_IDS="));
});

test("snapshot creation enforces bounded retention itself", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-snapshots-"));
  try {
    const registry = join(root, "active-tasks.json");
    const snapshots = join(root, "snapshots");
    writeFileSync(registry, "[]");
    mkdirSync(snapshots);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(snapshots, `snapshot-20260820T00000${i}Z.json`), "{}");
    }
    execFileSync("python3", [
      join(SWARM, "swarm-state.py"),
      "--registry", registry,
      "--snapshot-dir", snapshots,
      "snapshot-create",
    ], { env: { ...process.env, SWARM_SNAPSHOT_KEEP_COUNT: "3" }, stdio: "ignore" });
    const remaining = execFileSync("find", [snapshots, "-name", "snapshot-*.json"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    assert.equal(remaining.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped API clients choose read, write, admin, and webhook credentials", () => {
  const env = {
    ...process.env,
    MISSION_CONTROL_AUTH_MODE: "scoped",
    MISSION_CONTROL_READ_TOKEN: "read-token",
    MISSION_CONTROL_WRITE_TOKEN: "write-token",
    MISSION_CONTROL_ADMIN_TOKEN: "admin-token",
    MISSION_CONTROL_WEBHOOK_SECRET: "webhook-token",
  };
  const shell = execFileSync("bash", ["-c", `
source ${JSON.stringify(join(SWARM, "mc-api.sh"))}
printf '%s\\n' "$(mc_token_for GET /api/tasks)" "$(mc_token_for PATCH /api/tasks/1)" "$(mc_token_for DELETE /api/tasks/1)" "$(mc_token_for POST /api/webhooks/agent-completion)"
`], { env, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(shell, ["read-token", "write-token", "admin-token", "webhook-token"]);

  const py = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
from mc_api import token_for
print(json.dumps([
    token_for("GET", "/api/tasks"),
    token_for("PATCH", "/api/tasks/1"),
    token_for("DELETE", "/api/tasks/1"),
    token_for("POST", "/api/webhooks/agent-completion"),
]))
`], { env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(py), shell);
});

test("review automation never preempts an unfinished human change-request run", () => {
  const source = readFileSync(join(SWARM, "check-agents.sh"), "utf8");
  const runningLoop = source.indexOf('echo "$RUNNING_IDS"');
  const guard = source.indexOf("CHANGE_REQUEST_AT=", runningLoop);
  const prLookup = source.indexOf("PR_NUM=", guard);

  assert.ok(guard > runningLoop, "the guard belongs to the running-agent loop");
  assert.match(
    source.slice(guard, prLookup),
    /\[ -n "\$CHANGE_REQUEST_AT" \] && \[ -z "\$COMPLETION_SYNCED_AT" \]/,
    "only an unreconciled change request defers automation",
  );
  assert.match(source.slice(guard, prLookup), /deferring CI\/review automation/);
  assert.ok(guard < prLookup, "human feedback is protected before PR review starts");
});

test("session-limit escalation describes preserved repository state", () => {
  const source = readFileSync(join(SWARM, "run-claude.sh"), "utf8");
  assert.doesNotMatch(source, /No code was written/);
  assert.match(source, /Partial work is preserved/);
  assert.match(source, /git status --porcelain/);
  assert.match(source, /status:\"rate_limited\"/);
  assert.match(source, /activity_type:\"updated\"/,
    "a recoverable account limit is status, not a human escalation");
});

test("account-limit retries double, cap, and stop at twelve hours", () => {
  const result = python(`
from rate_limit_policy import next_retry
first = 1_000_000
rows = [next_retry(first, first, n, initial_seconds=300, max_seconds=7200, window_seconds=43200)
        for n in range(7)]
expired = next_retry(first + 43_200_000, first, 7,
                     initial_seconds=300, max_seconds=7200, window_seconds=43200)
print(json.dumps({"delays": [r["delaySeconds"] for r in rows], "expired": expired}))
`, null);
  assert.deepEqual(result.delays, [300, 600, 1200, 2400, 4800, 7200, 7200]);
  assert.equal(result.expired.exhausted, true);
  assert.equal(result.expired.nextRetryAt, null);
});

test("the monitor relaunches due rate-limited agents without occupying a slot meanwhile", () => {
  const source = readFileSync(join(SWARM, "check-agents.sh"), "utf8");
  assert.match(source, /select\(\.status == "rate_limited"\)/);
  assert.match(source, /nextRateLimitRetryAt/);
  assert.match(source, /rate-limit-retry/);
  assert.match(source, /preserved worktree/);
  assert.match(source, /status.*in_progress/,
    "the ticket must reflect that its preserved agent is executing again");
});

test("the execution target is resolved before the confirmation gate", () => {
  const source = readFileSync(join(SWARM, "bridge.py"), "utf8");
  const processStart = source.indexOf("def process_planning_tasks():");
  const processEnd = source.indexOf("\ndef _find_agent_registry_entry", processStart);
  const process = source.slice(processStart, processEnd);
  assert.ok(process.indexOf("repos = identify_repos") < process.indexOf('if not (state or {}).get("confirmed")'));
  assert.match(process, /posted a repo-selection follow-up before confirmation/i);
});

test("starting the detached planner moves the ticket out of inbox", () => {
  const result = python(`
import bridge, pathlib, tempfile
updates = []
bridge._build_triage_context = lambda task_id: ""
bridge._supercut_prompt_section = lambda task: ""
bridge._attachment_prompt_section = lambda task: ""
bridge._ticket_plan_mode = lambda task_id: ""
bridge._task_questions = lambda task_id: []
bridge.mc_update_task = lambda task_id, patch: updates.append(patch)
bridge.mc_set_progress = lambda *args, **kwargs: None
bridge.mc_log_activity = lambda *args, **kwargs: None
class Process:
    pid = 43210
bridge.subprocess.Popen = lambda *args, **kwargs: Process()
with tempfile.TemporaryDirectory() as td:
    job = pathlib.Path(td) / "task.job.json"
    bridge._start_planning_job({"id": "task", "title": "MET-650"}, pathlib.Path(td), job)
print(json.dumps(updates))
`, null);
  assert.deepEqual(result, [{ status: "planning" }]);
});

test("an explicit human repo answer replaces triage's earlier guesses", () => {
  const result = python(`
import bridge
bridge.discover_local_repos = lambda: [
    {"project": "GitProjects", "repo": "backend", "label": "GitProjects/backend"},
    {"project": "GitProjects", "repo": "staging-dashboard", "label": "GitProjects/staging-dashboard"},
    {"project": "external", "repo": "mission-control", "label": "external/mission-control"},
]
questions = [
    {"category": "scope", "question": "In which repository is this implemented?",
     "answer": "this is in backend new-ui"},
    {"category": "technical", "question": "Is ink defined in staging-dashboard?",
     "answer": "you are checking the wrong repo, it's backend master apps/new-ui"},
]
print(json.dumps(bridge._repos_named_by_answers(questions)))
`, null);
  assert.deepEqual(result, [{ project: "GitProjects", repo: "backend" }]);
});

test("repository choices put backend first but never silently select among several", () => {
  const result = python(`
import bridge
bridge.discover_local_repos = lambda: [
    {"project": "external", "repo": "mission-control", "label": "external/mission-control"},
    {"project": "GitProjects", "repo": "backend", "label": "GitProjects/backend"},
]
print(json.dumps({
    "options": bridge._available_repo_options(),
    "ambiguous": bridge._single_repo([
        {"project": "external", "repo": "mission-control"},
        {"project": "GitProjects", "repo": "backend"},
    ]),
}))
`, null);
  assert.equal(result.options[0], "GitProjects/backend");
  assert.deepEqual(result.ambiguous, []);
});

test("triage selects the sole authorized repo and removes obsolete repo-routing questions", () => {
  const result = python(`
import bridge
bridge.discover_local_repos = lambda: [
    {"project": "GitProjects", "repo": "backend", "label": "GitProjects/backend"},
]
bridge._repo_for_named_apps = lambda description: []
bridge.identify_repos = lambda title, description, manifest: []
bridge._design_context = lambda *args: ""
bridge._video_context = lambda *args: ""
bridge._supercut_context = lambda *args: ""
bridge._fetch_task = lambda task_id: {"id": task_id, "description": ""}
bridge._attachment_triage_context = lambda task: ""

responses = iter([
    {
        "ready": False,
        "repos": [],
        "questions": [
            {"id": "repo", "category": "scope", "summary": "frontend location",
             "question": "The only available repository is backend. Please specify the correct frontend repository."},
            {"id": "app", "category": "technical", "summary": "frontend application",
             "question": "Which existing application should these UI/UX changes be applied to?"},
            {"id": "design", "category": "design", "summary": "empty state",
             "question": "Should the empty state keep the current illustration?"},
        ],
    },
    {
        "ready": False,
        "repos": [],
        "questions": [
            {"id": "repo", "category": "repo", "summary": "target repo",
             "question": "Which single repository should this ticket use?"},
        ],
    },
])
bridge.triage_task = lambda *args, **kwargs: next(responses)
with_design, with_design_repos = bridge._run_triage("MET-650", "Fix selector", "", task_id="task")
repo_only, repo_only_repos = bridge._run_triage("MET-650", "Fix selector", "", task_id="task")
print(json.dumps({
    "with_design": with_design,
    "with_design_repos": with_design_repos,
    "repo_only": repo_only,
    "repo_only_repos": repo_only_repos,
}))
`, null);
  assert.deepEqual(result.with_design_repos, [{ project: "GitProjects", repo: "backend" }]);
  assert.deepEqual(result.with_design.questions.map(q => q.id), ["design"]);
  assert.equal(result.with_design.ready, false);
  assert.deepEqual(result.repo_only_repos, [{ project: "GitProjects", repo: "backend" }]);
  assert.deepEqual(result.repo_only.questions, []);
  assert.equal(result.repo_only.ready, true);
});

test("backend monorepo misconceptions become an actionable chat decision", () => {
  const result = python(`
import bridge
bridge.discover_local_repos = lambda: [
    {"project": "GitProjects", "repo": "backend", "label": "GitProjects/backend"},
]
bridge._repo_for_named_apps = lambda description: [
    {"project": "GitProjects", "repo": "backend"},
]
bridge._build_codebase_context = lambda *args: ""
bridge.recall_knowledge = lambda *args: {
    "developer_notes": "", "skills": "", "past_learnings": "", "recalled_ids": [],
}
bridge._design_context = lambda *args: ""
bridge._video_context = lambda *args: ""
bridge._supercut_context = lambda *args: ""
bridge._fetch_task = lambda task_id: {"id": task_id, "description": ""}
bridge._attachment_triage_context = lambda task: ""
bridge.triage_task = lambda *args, **kwargs: {
    "ready": False,
    "repos": [{"project": "GitProjects", "repo": "backend"}],
    "questions": [],
    "reasoning": (
        "GitProjects/backend is a backend service, so the correct frontend "
        "codebase is required before UI work can begin."
    ),
}
triage, repos = bridge._run_triage(
    "MET-650", "Polish the homepage UI", "- GitProjects/backend", task_id="task"
)
print(json.dumps({"triage": triage, "repos": repos}))
`, null);

  assert.deepEqual(result.repos, [{ project: "GitProjects", repo: "backend" }]);
  assert.equal(result.triage.ready, false);
  assert.doesNotMatch(result.triage.reasoning, /backend service/i);
  assert.match(result.triage.reasoning, /monorepo/i);
  assert.equal(result.triage.questions.length, 1);
  assert.equal(result.triage.questions[0].question_type, "multiple_choice");
  assert.equal(result.triage.questions[0].options.at(-1), "Other (please specify)");
});

test("an apps/new-ui target resolves to the one repository that contains it", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-repo-routing-"));
  const backend = join(root, "backend");
  const other = join(root, "staging-dashboard");
  try {
    mkdirSync(join(backend, "apps", "new-ui"), { recursive: true });
    mkdirSync(other, { recursive: true });
    const result = python(`
import bridge
backend, other = json.loads(sys.stdin.read())
bridge.discover_local_repos = lambda: [
    {"project": "GitProjects", "repo": "backend", "label": "GitProjects/backend", "path": backend},
    {"project": "GitProjects", "repo": "staging-dashboard", "label": "GitProjects/staging-dashboard", "path": other},
]
print(json.dumps(bridge._repo_for_named_apps("Target app: apps/new-ui")))
`, [backend, other]);
    assert.deepEqual(result, [{ project: "GitProjects", repo: "backend" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named apps resolve from the base branch even when absent in the checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-base-ref-routing-"));
  const backend = join(root, "backend");
  try {
    mkdirSync(join(backend, "apps", "new-ui"), { recursive: true });
    git(backend, "init", "-q", "-b", "master");
    git(backend, "config", "user.email", "t@example.invalid");
    git(backend, "config", "user.name", "t");
    writeFileSync(join(backend, "apps", "new-ui", "package.json"), "{}\n");
    git(backend, "add", "-A");
    git(backend, "commit", "-qm", "add frontend app");
    git(backend, "update-ref", "refs/remotes/origin/master", "HEAD");
    rmSync(join(backend, "apps", "new-ui"), { recursive: true, force: true });

    const result = python(`
import bridge
backend = json.loads(sys.stdin.read())
bridge.discover_local_repos = lambda: [
    {"project": "GitProjects", "repo": "backend", "label": "GitProjects/backend", "path": backend},
]
print(json.dumps(bridge._repo_for_named_apps("Target app: apps/new-ui")))
`, backend);
    assert.deepEqual(result, [{ project: "GitProjects", repo: "backend" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-internal lookup questions are filtered before they reach the human", () => {
  const result = python(`
import bridge
saved = {}
bridge.mc_log_activity = lambda *args, **kwargs: None
def request(method, path, data=None):
    if method == "GET":
        return {}
    saved.update(data or {})
    return data
bridge.mc_request = request
bridge.post_planning_questions("task", [
    {"id": "bad", "question": "Please specify the exact file path or component name where cards are rendered."},
    {"id": "app", "question": "Which existing application should these UI/UX changes be applied to?"},
    {"id": "good", "question": "Should the carousel loop continuously?"},
], {"repos": [{"project": "GitProjects", "repo": "backend"}]})
print(json.dumps(saved))
`, null);
  assert.deepEqual(result.questions.map(q => q.id), ["good"]);
  assert.deepEqual(result.triage_repos, [{ project: "GitProjects", repo: "backend" }]);
});

test("the confirmation target names repo, base, work branch, and app", () => {
  const result = python(`
from pathlib import Path
import bridge
bridge.find_repo_path = lambda project, repo: Path("/repo")
bridge._resolve_base_branch = lambda task, path: "origin/master"
target = bridge._execution_target(
    {"id": "task", "title": "[MET-645] Replace arrows", "description": ""},
    [{"project": "GitProjects", "repo": "backend"}],
    [{"answer": "backend master apps/new-ui"}],
)
print(json.dumps(target))
`, null);
  assert.deepEqual(result.apps, ["apps/new-ui"]);
  assert.deepEqual(result.repos[0], {
    project: "GitProjects",
    repo: "backend",
    label: "GitProjects/backend",
    base_branch: "origin/master",
    branch: "feature/MET-645-backend",
  });
});

test("an app named by a triage question survives execution-target reconciliation", () => {
  const result = python(`
from pathlib import Path
import bridge
bridge.find_repo_path = lambda project, repo: Path("/repo")
bridge._resolve_base_branch = lambda task, path: "origin/master"
target = bridge._execution_target(
    {"id": "task", "title": "[MET-650] Polish homepage", "description": ""},
    [{"project": "GitProjects", "repo": "backend"}],
    [{
        "question": "Should the design-system patterns be applied within apps/new-ui?",
        "answer": "Apply them manually",
    }],
)
print(json.dumps(target))
`, null);
  assert.deepEqual(result.apps, ["apps/new-ui"]);
});

test("both triage surfaces show the execution target before confirmation", () => {
  const dashboard = readFileSync(join(SWARM, "..", "public", "app.js"), "utf8");
  const ticket = readFileSync(join(SWARM, "..", "public", "ticket.html"), "utf8");
  assert.match(dashboard, /Execution target — confirm this before starting/);
  assert.match(dashboard, /execution_target/);
  assert.match(ticket, /execution target/);
  assert.match(ticket, /base_branch/);
  assert.match(ticket, /\.branch/);
});

test("the bridge answers each pending ticket chat message with durable reply linkage", () => {
  const result = python(`
import bridge
posts = []
pending = {
    "id": "message-1", "task_id": "task-1", "task_title": "MET-642",
    "task_description": "focus rings", "task_status": "in_progress",
    "message": "is this still running?",
}
def request(method, path, body=None):
    if method == "GET" and path.startswith("/api/tasks/pending-chat"):
        return [pending]
    if method == "GET" and path.endswith("/activities"):
        return [{"activity_type": "updated", "message": pending["message"],
                 "metadata": json.dumps({"source": "human"}), "created_at": "1"}]
    if method == "POST" and path.endswith("/activities"):
        posts.append(body)
        return body
    raise AssertionError((method, path, body))
bridge.mc_request = request
bridge.call_gemini = lambda *a, **k: "It is still in progress."
bridge.process_ticket_chat()
print(json.dumps(posts))
`, null);

  assert.equal(result.length, 1);
  assert.equal(result[0].activity_type, "agent_reply");
  assert.equal(result[0].reply_to_activity_id, "message-1");
  assert.equal(JSON.parse(result[0].metadata).reply_to_activity_id, "message-1");
});

test("human review feedback becomes a staged ticket conversation", () => {
  const result = python(`
import bridge, tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as root:
    bridge.SWARM_DIR = Path(root)
    marker = "2026-08-21T19:03:57+00:00"
    (bridge.SWARM_DIR / "active-tasks.json").write_text(json.dumps([{
        "id": "MET-646-backend", "mcTaskId": "task-646", "status": "ready",
        "changeRequestSource": "dashboard", "changeRequestAt": marker,
        "completionSyncedAt": "2026-08-21 12:20:00",
    }]))
    posts = []
    def request(method, path, body=None):
        if method == "GET" and path == "/api/tasks/task-646":
            return {"id": "task-646", "status": "review"}
        if method == "POST" and path.endswith("/activities"):
            posts.append(body)
            return body
        raise AssertionError((method, path, body))
    bridge.mc_request = request
    bridge.fetch_task_activities = lambda _: posts
    bridge.process_followup_lifecycle()
    bridge.process_followup_lifecycle()
    print(json.dumps(posts))
`, null);

  assert.equal(result.length, 2, "missing stages are recovered once per change-request run");
  assert.deepEqual(result.map(row => JSON.parse(row.metadata).stage), ["started", "completed"]);
  assert.equal(result[1].activity_type, "agent_reply");
  assert.match(result[1].message, /moved to Review/);
  assert.deepEqual(JSON.parse(result[1].metadata), {
    source: "mission-control",
    via: "follow-up-lifecycle",
    stage: "completed",
    change_request_at: "2026-08-21T19:03:57+00:00",
  });

  const source = readFileSync(join(SWARM, "bridge.py"), "utf8");
  const relaunch = source.slice(source.indexOf("def _relaunch_for_change_request"),
    source.indexOf("def process_followup_lifecycle"));
  assert.match(relaunch, /Moved to Building/);
  assert.match(relaunch, /stage="started"/);
  const runOnce = source.slice(source.indexOf("def run_once"), source.indexOf("def run_daemon"));
  assert.ok(runOnce.indexOf("process_ticket_chat()") < runOnce.indexOf("process_review_tasks()"),
    "the acknowledgement lands before the started update");
});

test("a fourth automated review-comment fix round holds the ticket and alerts a human", () => {
  const result = python(`
import bridge, tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as root:
    bridge.SWARM_DIR = Path(root)
    bridge._REVIEW_MONITOR_FILE = bridge.SWARM_DIR / "review-monitor.json"
    bridge._REVIEW_MONITOR_FILE.write_text(json.dumps({
        "task-709": {
            "autoCount": 3,
            "reviewCommentRounds": 3,
            "lastCommentId": 100,
            "lastMentionId": 0,
        }
    }))
    calls = []
    bridge.mc_request = lambda method, path, body=None: (
        [{"deliverable_type": "pr", "path": "https://github.com/acme/backend/pull/709"}]
        if method == "GET" and path.endswith("/deliverables") else None
    )
    bridge._gh_pr_meta = lambda _: {
        "state": "OPEN", "headRefOid": "new-head", "mergeable": "MERGEABLE",
        "statusCheckRollup": [], "_repo": "acme/backend", "_num": "709",
    }
    bridge._pr_comment_signals = lambda _: {"ext": 101, "mention": 0}
    bridge.mc_update_task = lambda task_id, body: calls.append(["patch", task_id, body])
    bridge.mc_log_activity = lambda task_id, kind, message: calls.append(["activity", task_id, kind, message])
    bridge._relaunch_for_change_request = lambda *_a, **_kw: calls.append(["relaunch"])

    triggered = bridge._auto_review_monitor({"id": "task-709", "task_type": "implementation"})
    state = json.loads(bridge._REVIEW_MONITOR_FILE.read_text())["task-709"]
    print(json.dumps({"triggered": triggered, "calls": calls, "state": state}))
`, null);

  assert.equal(result.triggered, true);
  assert.deepEqual(result.calls[0], ["patch", "task-709", { status: "on_hold" }]);
  assert.equal(result.calls[1][0], "activity");
  assert.equal(result.calls[1][2], "needs_human", "needs_human is routed to Telegram/action alerts");
  assert.match(result.calls[1][3], /after 3 automated fix rounds/);
  assert.match(result.calls[1][3], /\/unhold/);
  assert.equal(result.calls.some(call => call[0] === "relaunch"), false, "the fourth round must not relaunch again");
  assert.equal(result.state.reviewCommentRounds, 4);
  assert.equal(result.state.lastCommentId, 101, "the triggering comment is consumed so it cannot alert twice");
});

test("a pre-existing PR conflict is repaired on first observation and from legacy baseline state", () => {
  const result = python(`
import bridge, tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as root:
    bridge.SWARM_DIR = Path(root)
    bridge._REVIEW_MONITOR_FILE = bridge.SWARM_DIR / "review-monitor.json"
    calls = []
    bridge.mc_request = lambda method, path, body=None: (
        [{"deliverable_type": "pr", "path": "https://github.com/acme/backend/pull/694"}]
        if method == "GET" and path.endswith("/deliverables") else None
    )
    bridge._gh_pr_meta = lambda _: {
        "state": "OPEN", "headRefOid": "conflicted-head", "mergeable": "CONFLICTING",
        "statusCheckRollup": [], "_repo": "acme/backend", "_num": "694",
    }
    bridge._pr_comment_signals = lambda _: {"ext": 55, "mention": 0}
    bridge.mc_log_activity = lambda task_id, kind, message: calls.append(["activity", task_id, kind])
    bridge._relaunch_for_change_request = lambda task, prompt, source: calls.append(
        ["relaunch", task["id"], source]
    )

    first = bridge._auto_review_monitor({"id": "task-646", "task_type": "implementation"})
    first_state = json.loads(bridge._REVIEW_MONITOR_FILE.read_text())["task-646"]

    bridge._REVIEW_MONITOR_FILE.write_text(json.dumps({
        "task-legacy": {
            "autoCount": 0,
            "reviewCommentRounds": 0,
            "lastCommentId": 55,
            "lastMentionId": 0,
            "conflictHead": "conflicted-head",
        }
    }))
    legacy = bridge._auto_review_monitor({"id": "task-legacy", "task_type": "implementation"})
    legacy_state = json.loads(bridge._REVIEW_MONITOR_FILE.read_text())["task-legacy"]
    print(json.dumps({
        "first": first, "legacy": legacy, "calls": calls,
        "firstState": first_state, "legacyState": legacy_state,
    }))
`, null);

  assert.equal(result.first, true);
  assert.equal(result.legacy, true);
  assert.deepEqual(result.calls.filter(call => call[0] === "relaunch"), [
    ["relaunch", "task-646", "auto-monitor"],
    ["relaunch", "task-legacy", "auto-monitor"],
  ]);
  assert.equal(result.firstState.autoCount, 1);
  assert.equal(result.legacyState.autoCount, 1);
  assert.equal(result.firstState.lastCommentId, 55, "existing comments remain baselined");
});

test("merged and externally closed PRs complete tickets through the canonical endpoint", () => {
  const result = python(`
import bridge

calls = []
def request(method, path, body=None):
    if method == "GET" and path.endswith("/deliverables"):
        return [{"deliverable_type": "pr", "path": "https://github.com/acme/backend/pull/709"}]
    if method == "GET" and path == "/api/tasks/task-709":
        return {"id": "task-709", "status": "review"}
    calls.append([method, path, body])
bridge.mc_request = request
bridge._gh_pr_closed_for_reset = lambda _url: False
task = {"id": "task-709", "status": "review"}

outcomes = []
for state in ("MERGED", "CLOSED", "OPEN"):
    bridge._gh_pr_state = lambda _url, current=state: current
    outcomes.append(bridge._check_pr_status_for_task(task))

print(json.dumps({"outcomes": outcomes, "calls": calls}))
`, null);

  assert.deepEqual(result.outcomes, [true, true, false]);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.calls.map(call => call.slice(0, 2)), [
    ["POST", "/api/tasks/task-709/done"],
    ["POST", "/api/tasks/task-709/done"],
  ]);
  assert.match(result.calls[0][2].reason, /merged/i);
  assert.match(result.calls[1][2].reason, /closed outside Mission Control/i);
});

test("a PR closed by Mission Control reset never completes the ticket", () => {
  const result = python(`
import bridge

calls = []
def request(method, path, body=None):
    if method == "GET" and path.endswith("/deliverables"):
        return [{"deliverable_type": "pr", "path": "https://github.com/acme/backend/pull/709"}]
    if method == "GET" and path == "/api/tasks/task-709":
        return {"id": "task-709", "status": "review"}
    calls.append([method, path, body])
bridge.mc_request = request
bridge._gh_pr_state = lambda _url: "CLOSED"
bridge._gh_pr_closed_for_reset = lambda _url: True

closed = bridge._check_pr_status_for_task({"id": "task-709", "status": "review"})
print(json.dumps({"closed": closed, "calls": calls}))
`, null);

  assert.equal(result.closed, false);
  assert.deepEqual(result.calls, []);
});

test("reset-close detection only matches the reset comment tied to the latest closure", () => {
  const result = python(`
import bridge
from types import SimpleNamespace

def observed(closed_at, comment_at):
    bridge.subprocess.run = lambda *_a, **_kw: SimpleNamespace(
        returncode=0,
        stdout=json.dumps({
            "closedAt": closed_at,
            "comments": [{
                "body": bridge._TRIAGE_RESET_COMMENT,
                "createdAt": comment_at,
            }],
        }),
        stderr="",
    )
    return bridge._gh_pr_closed_for_reset("https://github.com/acme/backend/pull/709")

print(json.dumps({
    "same_close": observed("2026-08-24T19:12:57Z", "2026-08-24T19:12:55Z"),
    "later_external_close": observed("2026-08-25T19:12:57Z", "2026-08-24T19:12:55Z"),
}))
`, null);

  assert.deepEqual(result, { same_close: true, later_external_close: false });
});

test("review automation respects checkpoints while held tickets still reconcile terminal PRs", () => {
  const result = python(`
import bridge

tasks = {
    "review": [{"id": "active", "title": "Active", "status": "review"}],
    "testing": [],
    "on_hold": [{"id": "held", "title": "Held", "status": "on_hold"}],
}
events = []
bridge.fetch_tasks_by_status = lambda status: tasks[status]
bridge._capture_pr_for_task = lambda task: events.append(["capture", task["id"]])
bridge._check_pr_status_for_task = lambda task: task["id"] == "held"
bridge._has_pending_checkpoint = lambda task_id: task_id == "active"
bridge._collect_dashboard_feedback = lambda _task_id: "fix this"
bridge._relaunch_for_change_request = lambda task, *_a, **_kw: events.append(["relaunch", task["id"]])
bridge._auto_review_monitor = lambda task: events.append(["monitor", task["id"]])

bridge.process_review_tasks()
print(json.dumps(events))
`, null);

  assert.deepEqual(result, [["capture", "active"], ["capture", "held"]]);
});

test("the completion reconciler resumes implementations that have no deliverable", () => {
  const source = readFileSync(join(SWARM, "check-agents.sh"), "utf8");
  assert.match(source, /completion_policy\.py/);
  assert.match(source, /completed_without_pr/);
  assert.match(source, /completionRetryCount/);
  assert.match(source, /completion retries exhausted/);
  assert.match(source, /status.*running/);
  assert.match(source, /deliverable_type.*pr/);
  assert.match(source, /in_progress\|assigned\|planning/,
    "a stale planning alert must not hide an implementation PR");
});

test("a successful retry closes only stale spawn-failure checkpoints", () => {
  const result = python(`
import json, tempfile
from pathlib import Path
from types import SimpleNamespace
import bridge

calls = []
bridge.SWARM_DIR = Path(tempfile.mkdtemp())
bridge.mc_request = lambda method, path, body=None: (
    [
        {"id": "spawn", "status": "pending", "prompt": "Couldn't spawn an agent for GitProjects/backend. Task returned to planning."},
        {"id": "other", "status": "pending", "prompt": "Approve the deployment?"},
        {"id": "old", "status": "approved", "prompt": "Couldn't spawn an agent for another repo."},
    ] if method == "GET" else calls.append((method, path, body))
)
bridge.subprocess.run = lambda *a, **k: SimpleNamespace(returncode=0, stdout="started", stderr="")

ok = bridge.spawn_agent(
    "task-642", "MET-642-backend", Path("/tmp/backend"), "prompt",
    mc_task_id="task-642", base_branch="origin/master",
)
print(json.dumps({"ok": ok, "calls": calls}))
`, null);

  assert.equal(result.ok, true);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0][1], "/api/checkpoints/spawn/resolve");
  assert.equal(result.calls[0][2].decision, "approve");
  assert.match(result.calls[0][2].response, /spawn succeeded/i);
});
