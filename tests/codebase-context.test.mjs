// Triage and planning describe the codebase to the model. They used to read the
// working tree — whatever branch happened to be checked out — while agents get
// worktrees cut from the task's pinned base branch. In a monorepo whose target app
// lives only on a feature branch, that means the planner writes tasks against a
// codebase the agent will never see.
//
// These build a throwaway git repo where a directory exists on one branch only.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

let mcHome;
let repo;

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });

test.before(() => {
  mcHome = mkdtempSync(join(tmpdir(), "mc-ctx-home-"));
  repo = mkdtempSync(join(tmpdir(), "mc-ctx-repo-"));

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");

  // main: one app.
  mkdirSync(join(repo, "apps", "legacy", "src"), { recursive: true });
  writeFileSync(join(repo, "apps", "legacy", "src", "index.ts"), "export const legacy = 1;\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "monorepo" }));
  git("add", "-A");
  git("commit", "-qm", "main");

  // feature branch: adds an app that main has never seen.
  git("checkout", "-q", "-b", "feature/new-ui");
  mkdirSync(join(repo, "apps", "new-ui", "src"), { recursive: true });
  writeFileSync(join(repo, "apps", "new-ui", "src", "routes.ts"), "export const routes = [];\n");
  git("add", "-A");
  git("commit", "-qm", "add new-ui");

  // Leave the checkout on main, the way a developer's tree usually sits.
  git("checkout", "-q", "main");
});

test.after(() => {
  for (const dir of [mcHome, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

function python(program) {
  const stdout = execFileSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)})\n${program}`], {
    env: { ...process.env, MC_HOME: mcHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

function contextAt(ref) {
  return python(`
import json, pathlib, bridge
ctx = bridge.read_key_source_files_at_ref(pathlib.Path(${JSON.stringify(repo)}), ${JSON.stringify(ref)})
print(json.dumps(ctx))
`);
}

test("reading a ref sees what that ref contains, not the checkout", () => {
  assert.ok(contextAt("feature/new-ui").includes("new-ui"));
});

test("reading a ref does not leak content the ref lacks", () => {
  assert.ok(!contextAt("main").includes("new-ui"));
});

test("the checkout alone cannot see a feature branch's app", () => {
  const fromCheckout = python(`
import json, pathlib, bridge
print(json.dumps(bridge.read_key_source_files(pathlib.Path(${JSON.stringify(repo)}))))
`);
  // This is the bug the ref reader exists to fix — kept as the contrast case.
  assert.ok(!fromCheckout.includes("new-ui"));
});

test("an unreadable ref falls back to the checkout instead of returning nothing", () => {
  assert.equal(contextAt("origin/does-not-exist"), "");
  const built = python(`
import json, bridge
bridge.find_repo_path = lambda project, repo: __import__("pathlib").Path(${JSON.stringify(repo)})
print(json.dumps(bridge._build_codebase_context([{"project": "p", "repo": "r"}], "origin/does-not-exist")))
`);
  assert.ok(built.includes("legacy"), "should still describe the checkout");
});

test("a task's pinned base branch is read out of description or triage state", () => {
  const pins = python(`
import json, bridge
print(json.dumps({
    "description": bridge._base_branch_override({"description": "Base branch: coda/new-ui\\n\\nrest"}),
    "hyphenated": bridge._base_branch_override({"description": "base-branch: staging"}),
    "triage_state": bridge._base_branch_override({"triage_state": json.dumps({"base_branch": "origin/foo"})}),
    "none": bridge._base_branch_override({"description": "no pin here"}),
}))
`);
  assert.equal(pins.description, "origin/coda/new-ui");
  assert.equal(pins.hyphenated, "origin/staging");
  assert.equal(pins.triage_state, "origin/foo");
  // No pin must stay empty: it is what tells triage to read the checkout.
  assert.equal(pins.none, "");
});

test("the directory listing fills by depth, so every top-level app survives the cap", () => {
  // A flat cap over sorted paths spends its budget inside the first directory.
  const lines = python(`
import json, bridge
paths = [f"apps/aaa/src/deep/f{i}.ts" for i in range(400)] + ["apps/zzz-last/src/index.ts"]
print(json.dumps(bridge._tree_from_paths(paths)))
`);
  assert.ok(lines.some(l => l.includes("zzz-last")), "the last app must not be truncated away");
});
