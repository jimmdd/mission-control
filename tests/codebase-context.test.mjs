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

// A handoff zip is the ticket's provided implementation. The size cap used to abort
// on the first member that overflowed it, in raw archive order — so a couple of large
// videos near the front consumed the budget and the spec and source never extracted,
// while the agent was still told "use the provided implementation, don't reinvent".

test("zip extraction takes source and docs before media", () => {
  const zipDir = mkdtempSync(join(tmpdir(), "mc-zip-"));
  const out = join(zipDir, "out");
  // Two files whose names sort media-first, so only the ordering can save the doc.
  const big = join(zipDir, "aaa-video.mp4");
  const small = join(zipDir, "zzz-SPEC.md");
  writeFileSync(big, Buffer.alloc(24 * 1024 * 1024));
  writeFileSync(small, "# the spec that matters\n");
  execFileSync("zip", ["-q", "-j", join(zipDir, "h.zip"), big, small]);

  const names = python(`
import json, pathlib, bridge
paths = bridge._safe_extract_zip(pathlib.Path(${JSON.stringify(join(zipDir, "h.zip"))}),
                                 pathlib.Path(${JSON.stringify(out)}))
print(json.dumps(sorted(p.name for p in paths)))
`);
  assert.ok(names.includes("zzz-SPEC.md"), "the doc must survive a media-heavy archive");
  rmSync(zipDir, { recursive: true, force: true });
});

test("an oversized member is skipped, not treated as the end of the archive", () => {
  const zipDir = mkdtempSync(join(tmpdir(), "mc-zip2-"));
  const out = join(zipDir, "out");
  const huge = join(zipDir, "a-huge.bin");
  const after = join(zipDir, "b-after.md");
  // Incompressible, so it really costs its size on the way out.
  writeFileSync(huge, Buffer.alloc(30 * 1024 * 1024).map(() => Math.floor(Math.random() * 256)));
  writeFileSync(after, "still needed\n");
  execFileSync("zip", ["-q", "-j", "-0", join(zipDir, "h.zip"), huge, after]);

  const names = python(`
import json, pathlib, bridge
paths = bridge._safe_extract_zip(pathlib.Path(${JSON.stringify(join(zipDir, "h.zip"))}),
                                 pathlib.Path(${JSON.stringify(out)}))
print(json.dumps(sorted(p.name for p in paths)))
`);
  assert.ok(names.includes("b-after.md"), "a member past the oversized one must still extract");
  assert.ok(!names.includes("a-huge.bin"), "the oversized member itself must be skipped");
  rmSync(zipDir, { recursive: true, force: true });
});

test("zip slip entries are rejected", () => {
  const zipDir = mkdtempSync(join(tmpdir(), "mc-zip3-"));
  const out = join(zipDir, "out");
  const names = python(`
import json, pathlib, zipfile, bridge
zp = pathlib.Path(${JSON.stringify(join(zipDir, "evil.zip"))})
with zipfile.ZipFile(zp, "w") as z:
    z.writestr("../escaped.txt", "nope")
    z.writestr("fine.txt", "ok")
paths = bridge._safe_extract_zip(zp, pathlib.Path(${JSON.stringify(out)}))
print(json.dumps(sorted(p.name for p in paths)))
`);
  assert.deepEqual(names, ["fine.txt"]);
  rmSync(zipDir, { recursive: true, force: true });
});

test("attachment context gives triage the manifest and the docs", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-att-"));
  writeFileSync(join(dir, "HANDOFF.md"), "# Handoff\nThe content rail is 1304px.\n");
  writeFileSync(join(dir, "styles.css"), ":root { --rail: 1304px; }\n");
  const ctx = python(`
import json, bridge
bridge._download_task_attachments = lambda task: [
    {"label": "h.zip → HANDOFF.md", "path": ${JSON.stringify(join(dir, "HANDOFF.md"))}, "kind": "zip-member"},
    {"label": "h.zip → styles.css", "path": ${JSON.stringify(join(dir, "styles.css"))}, "kind": "zip-member"},
]
print(json.dumps(bridge._attachment_triage_context({"id": "t"})))
`);
  // Docs are inlined so triage can read the spec; source appears in the manifest only.
  assert.match(ctx, /1304px/);
  assert.match(ctx, /styles\.css/);
  assert.doesNotMatch(ctx, /--rail:/, "source bodies would crowd out the triage prompt");
  rmSync(dir, { recursive: true, force: true });
});

test("no attachments means no attachment context at all", () => {
  const ctx = python(`
import json, bridge
bridge._download_task_attachments = lambda task: []
print(json.dumps(bridge._attachment_triage_context({"id": "t"})))
`);
  assert.equal(ctx, "");
});

test("attachments are framed as reference, never as the stack to adopt", () => {
  // A supplied prototype routinely uses a different framework from the target app.
  // Telling a builder to "integrate as-is" invites it to drag React into a Svelte app.
  const dir = mkdtempSync(join(tmpdir(), "mc-att2-"));
  writeFileSync(join(dir, "App.tsx"), "export default () => null;\n");
  const sections = python(`
import json, bridge
bridge._download_task_attachments = lambda task: [
    {"label": "h.zip -> App.tsx", "path": ${JSON.stringify(join(dir, "App.tsx"))}, "kind": "zip-member"},
]
print(json.dumps({
    "builder": bridge._attachment_prompt_section({"id": "t"}),
    "triage": bridge._attachment_triage_context({"id": "t"}),
}))
`);
  assert.match(sections.builder, /repository's stack wins/i);
  assert.doesNotMatch(sections.builder, /integrate it as-is/i);
  // Triage must not turn a framework difference into a question for the human.
  assert.match(sections.triage, /not raise the framework difference as a question/i);
  // ...and it must say so narrowly. Framing the whole package as "already answered"
  // made triage return ready with no questions and dispatch unscoped work.
  assert.match(sections.triage, /settles the framework and NOTHING else/i);
  assert.match(sections.triage, /does not remove the duty to ask/i);
  // But a stack change the ticket itself asks for stays available, and stays gated:
  // it needs an explicit request plus a human's approval, never an inference.
  assert.match(sections.builder, /explicit, approved stack change/i);
  assert.match(sections.builder, /carries no authority/i);
  assert.match(sections.triage, /ask the human to confirm/i);
  rmSync(dir, { recursive: true, force: true });
});

// Several local checkouts of one upstream are several names for one codebase. Listing
// them all made repo selection non-deterministic on identical input — the same ticket
// picked a different clone run to run, and worktrees landed under different parents.

test("duplicate checkouts of one upstream collapse to a single repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-dedupe-"));
  const mk = (rel, url) => {
    const p = join(dir, rel);
    mkdirSync(p, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: p });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: p });
    return p;
  };
  // Same upstream, three names; plus one genuinely different repo.
  mk("backend", "https://github.com/org/backend.git");
  mk("nested/backend-copy", "https://github.com/org/backend.git");
  mk("nested/backend", "https://github.com/org/backend.git");
  mk("other", "https://github.com/org/other.git");

  const labels = python(`
import json, pathlib, bridge
bridge.GITPROJECTS_DIR = pathlib.Path(${JSON.stringify(dir)})
print(json.dumps([r["label"] for r in bridge.discover_local_repos()]))
`);
  const backends = labels.filter(l => l.includes("backend"));
  assert.equal(backends.length, 1, `expected one backend, got ${JSON.stringify(backends)}`);
  // Name match wins, then the shallowest checkout — a top-level clone is the working
  // copy; nested ones (external/, vendor/) are reference copies.
  assert.ok(backends[0].endsWith("/backend"));
  assert.ok(labels.some(l => l.endsWith("/other")), "a distinct repo must survive");
  rmSync(dir, { recursive: true, force: true });
});

test("a repo with no origin is never treated as a duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-dedupe2-"));
  for (const name of ["alpha", "beta"]) {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: p });
  }
  const labels = python(`
import json, pathlib, bridge
bridge.GITPROJECTS_DIR = pathlib.Path(${JSON.stringify(dir)})
print(json.dumps(sorted(r["repo"] for r in bridge.discover_local_repos())))
`);
  assert.deepEqual(labels, ["alpha", "beta"]);
  rmSync(dir, { recursive: true, force: true });
});
