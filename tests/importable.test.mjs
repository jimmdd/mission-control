// CI was red on every push and nobody could see why: the tests that shell into
// Python swallow stderr, so 60 failures showed as "Command failed" with no cause.
// The cause was one line — `from context_fabrica_config import (...)` at module
// scope in bridge.py, importing a third-party package the runner does not have
// (the workflow installs Node only). So `import bridge` raised ModuleNotFoundError
// and everything downstream of it failed.
//
// It hid locally because this machine's default python3 is 3.9 with the package
// installed, while the runner has neither. That is exactly the gap a test should
// close: every module the suite drives must import on a bare interpreter.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

// Everything the suite shells into, plus the daemon entrypoint itself.
const MODULES = [
  "bridge", "planner", "gsd_backend", "plan_stage", "plan_stage_runner",
  "questions", "process_level", "gsd_plan_import", "gsd_brief", "worktree_env",
];

test("every module the suite drives imports on a bare interpreter", () => {
  for (const mod of MODULES) {
    let err = null;
    try {
      execFileSync("python3", ["-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)}); import ${mod}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      // Surface the real cause, which is precisely what CI could not.
      err = (e.stderr || "").trim().split("\n").slice(-3).join(" | ");
    }
    assert.equal(err, null, `import ${mod} failed: ${err}`);
  }
});

test("an optional dependency is optional, not a hard import", () => {
  // Knowledge recall degrades when the store is unreachable; it must degrade the
  // same way when the package is simply absent, or it is not optional at all.
  const src = execFileSync("python3", ["-c",
    `import pathlib, sys; print(pathlib.Path(${JSON.stringify(SWARM)}, "bridge.py").read_text())`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const at = src.indexOf("from context_fabrica_config import");
  assert.ok(at > -1, "the import is still there");
  const before = src.slice(Math.max(0, at - 400), at);
  assert.match(before, /try:/, "it must be guarded — a hard import makes recall mandatory");
  assert.match(src, /KNOWLEDGE_AVAILABLE/, "and the rest of the file must be able to tell");
});
