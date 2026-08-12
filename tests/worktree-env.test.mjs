// A git worktree holds tracked files only, so local `.env` config never arrives on
// its own. Every gate that compiles or boots the app then fails for a reason that
// has nothing to do with the work under test — which is exactly how the Phase 0
// build gate came to be written off as a broken base commit.
//
// worktree_env.py is Python, so each case drives it through a short python3 program.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

/** Run seed_worktree_env and return its report. */
function seed(repo, worktree) {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
from worktree_env import seed_worktree_env
repo, worktree = json.loads(sys.stdin.read())
print(json.dumps(seed_worktree_env(repo, worktree)))
`;
  const stdout = execFileSync("python3", ["-c", program], {
    input: JSON.stringify([repo, worktree]),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * A repo with one committed file and a .gitignore covering .env, plus a worktree
 * cut from it — the shape every dispatch produces.
 */
function fixture({ gitignore = ".env\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mc-wtenv-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), gitignore);
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "index.js"), "// app\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const worktree = join(root, "wt");
  git(repo, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  return { root, repo, worktree };
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test("a real .env is copied into the worktree, which starts without one", () => {
  const { root, repo, worktree } = fixture();
  try {
    writeFileSync(join(repo, "apps", "web", ".env"), "PUBLIC_API_URL=https://real.invalid\n");
    assert.equal(existsSync(join(worktree, "apps/web/.env")), false, "worktree starts empty");

    const report = seed(repo, worktree);

    assert.deepEqual(report.copied, ["apps/web/.env"]);
    assert.deepEqual(report.seeded, []);
    assert.match(readFileSync(join(worktree, "apps/web/.env"), "utf8"), /real\.invalid/);
  } finally {
    cleanup(root);
  }
});

test("with no local .env, .env.example seeds one and is reported as placeholder", () => {
  const { root, repo, worktree } = fixture();
  try {
    // The template is committed, so it reaches the worktree — but as .env.example,
    // which SvelteKit's $env/static/public does not read.
    writeFileSync(join(repo, "apps", "web", ".env.example"), "PUBLIC_API_URL=\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "example");
    git(repo, "worktree", "remove", "--force", worktree);
    git(repo, "worktree", "add", "-q", "--detach", worktree, "HEAD");

    const report = seed(repo, worktree);

    assert.deepEqual(report.seeded, ["apps/web/.env"]);
    assert.deepEqual(report.copied, []);
    assert.equal(existsSync(join(worktree, "apps/web/.env")), true);
    // The distinction is the point: a gate passing on placeholders is attributable.
    assert.match(report.seeded.join(), /\.env$/);
  } finally {
    cleanup(root);
  }
});

test("a real .env wins over the template", () => {
  const { root, repo, worktree } = fixture();
  try {
    writeFileSync(join(repo, "apps", "web", ".env.example"), "PUBLIC_API_URL=placeholder\n");
    writeFileSync(join(repo, "apps", "web", ".env"), "PUBLIC_API_URL=https://real.invalid\n");

    const report = seed(repo, worktree);

    assert.deepEqual(report.copied, ["apps/web/.env"]);
    assert.deepEqual(report.seeded, []);
    assert.match(readFileSync(join(worktree, "apps/web/.env"), "utf8"), /real\.invalid/);
  } finally {
    cleanup(root);
  }
});

test("a path git would track is skipped, so no secret lands in a diff", () => {
  // No .gitignore entry for .env: copying one here would put local credentials
  // into the agent's next commit.
  const { root, repo, worktree } = fixture({ gitignore: "node_modules\n" });
  try {
    writeFileSync(join(repo, "apps", "web", ".env"), "SECRET=hunter2\n");

    const report = seed(repo, worktree);

    assert.deepEqual(report.copied, []);
    assert.equal(existsSync(join(worktree, "apps/web/.env")), false);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /track/);
  } finally {
    cleanup(root);
  }
});

test("an existing worktree file is never overwritten", () => {
  const { root, repo, worktree } = fixture();
  try {
    writeFileSync(join(repo, "apps", "web", ".env"), "PUBLIC_API_URL=from-repo\n");
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    writeFileSync(join(worktree, "apps", "web", ".env"), "PUBLIC_API_URL=already-here\n");

    const report = seed(repo, worktree);

    assert.deepEqual(report.copied, []);
    assert.match(readFileSync(join(worktree, "apps/web/.env"), "utf8"), /already-here/);
  } finally {
    cleanup(root);
  }
});

test("copied config is owner-only, not whatever the daemon's umask allows", () => {
  const { root, repo, worktree } = fixture();
  try {
    writeFileSync(join(repo, "apps", "web", ".env"), "SECRET=hunter2\n");
    seed(repo, worktree);
    const mode = statSync(join(worktree, "apps/web/.env")).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    cleanup(root);
  }
});

test("a directory absent from the base ref is left alone", () => {
  const { root, repo, worktree } = fixture();
  try {
    // Config for an app that exists in the clone's checkout but not on this ref —
    // a different branch. Nothing to configure, and no directory to create.
    mkdirSync(join(repo, "apps", "other"), { recursive: true });
    writeFileSync(join(repo, "apps", "other", ".env"), "X=1\n");

    const report = seed(repo, worktree);

    assert.deepEqual(report.copied, []);
    assert.equal(existsSync(join(worktree, "apps/other")), false);
  } finally {
    cleanup(root);
  }
});

test("node_modules is not searched for config", () => {
  const { root, repo, worktree } = fixture();
  try {
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", ".env"), "FIXTURE=1\n");

    const report = seed(repo, worktree);

    assert.deepEqual(report.copied, []);
    assert.deepEqual(report.seeded, []);
  } finally {
    cleanup(root);
  }
});
