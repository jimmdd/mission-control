import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const gate = fileURLToPath(new URL("../swarm/check_review_evidence.py", import.meta.url));
test("evidence gate preserves product assets but catches proofs even after a deletion commit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-evidence-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  const file = (name) => { mkdirSync(join(cwd, name, ".."), { recursive: true }); writeFileSync(join(cwd, name), "fixture"); };
  const check = () => spawnSync("python3", [gate, cwd, "base"], { encoding: "utf8" });
  try {
    git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "base"); git("tag", "base");
    file("apps/new-ui/static/team/headshot.webp"); file("tests/fixtures/screenshots/baseline.png");
    git("add", "."); git("commit", "-m", "product assets and fixtures");
    assert.equal(check().status, 0);
    file(".planning/phases/one/evidence/after/chart.png");
    assert.equal(check().status, 0, "untracked captures are local and not published");
    git("add", ".");
    assert.equal(check().status, 1, "staged evidence is rejected before commit");
    git("commit", "-m", "proof");
    git("rm", ".planning/phases/one/evidence/after/chart.png"); git("commit", "-m", "delete proof");
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /chart.png/);
    assert.doesNotMatch(result.stdout, /headshot.webp|baseline.png/);
    assert.equal(spawnSync("python3", [gate, cwd, "missing-base"], { encoding: "utf8" }).status, 2);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
