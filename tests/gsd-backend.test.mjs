// GSD ships its workflows as skills named `gsd-plan-phase` (hyphen). The older
// `/gsd:plan-phase` colon form resolves to nothing — and a prompt citing a command
// that does not exist produces no error at all. The agent silently ignores that
// section and works from the surrounding prose.
//
// That is not hypothetical: it ran that way. Agents executed as plain sessions with
// no GSD decomposition, no .planning/ artifacts and no per-task automated checks,
// while every log looked healthy. Nothing failed, so nothing surfaced.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

function commands() {
  const out = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
print(json.dumps({
    "plan": g.plan_command(),
    "greenfield": g.plan_command(greenfield=True),
    "gaps": g.gap_plan_command(),
    "execute": g.execute_command(),
    "verify": g.verify_command(),
}))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

test("no emitted command uses the dead colon form", () => {
  for (const [role, cmd] of Object.entries(commands())) {
    assert.doesNotMatch(cmd, /\/gsd:/, `${role} still emits the colon form: ${cmd}`);
    assert.match(cmd, /^\/gsd-[a-z-]+/, `${role} should name a gsd- skill: ${cmd}`);
  }
});

test("the repo carries no colon-form reference anywhere", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const dir of ["swarm", "src", "public", "docs"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const file of walk(base)) {
      if (/\.(py|ts|js|md|sh|json|html)$/.test(file) === false) continue;
      const text = readFileSync(file, "utf8");
      // gsd_backend.py documents the dead form on purpose; everything else must not use it.
      if (file.endsWith("gsd_backend.py")) continue;
      assert.ok(!/\/gsd:[a-z]/.test(text), `${file} references a command that does not exist`);
    }
  }
});

test("every command names a skill that is actually installed", { skip: !existsSync(join(homedir(), ".claude/skills")) }, () => {
  // The real failure was drift between what MC says and what GSD ships, so assert
  // against the installation rather than against a list copied from it.
  const skills = join(homedir(), ".claude", "skills");
  for (const [role, cmd] of Object.entries(commands())) {
    const name = cmd.split(/\s+/)[0].replace(/^\//, "");
    assert.ok(existsSync(join(skills, name)),
      `${role} names ${name}, which is not installed in ~/.claude/skills`);
  }
});

// Asking an agent to run a workflow is a request, not a guarantee. The colon-form bug
// proved a prompt can name a command that never resolves and produce a session that
// looks entirely healthy. So the harness checks the outcome rather than trusting it.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function ran(cwd) {
  const out = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
ok, why = g.workflow_ran(${JSON.stringify(cwd)})
print(json.dumps({"ok": ok, "why": why}))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

test("a worktree with no .planning is reported as never having run GSD", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-gsd-none-"));
  const r = ran(dir);
  assert.equal(r.ok, false);
  assert.match(r.why, /never ran/);
  rmSync(dir, { recursive: true, force: true });
});

test("an empty .planning is not mistaken for a workflow that ran", () => {
  // The directory alone proves nothing — GSD scaffolding can exist with no plan in it.
  const dir = mkdtempSync(join(tmpdir(), "mc-gsd-empty-"));
  mkdirSync(join(dir, ".planning"), { recursive: true });
  const r = ran(dir);
  assert.equal(r.ok, false);
  assert.match(r.why, /0 plans|never ran/);
  rmSync(dir, { recursive: true, force: true });
});

test("the check never blocks a task when it cannot inspect the project", () => {
  // A missing gsd-tools must not turn into a phantom failure: the check exists to
  // catch silence, not to gate on its own availability.
  const dir = mkdtempSync(join(tmpdir(), "mc-gsd-nt-"));
  mkdirSync(join(dir, ".planning"), { recursive: true });
  const out = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
g._tools_path = lambda: None
ok, why = g.workflow_ran(${JSON.stringify(dir)})
print(json.dumps({"ok": ok, "why": why}))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(JSON.parse(out).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

// /gsd-plan-phase cannot plan into a repo with no .planning/ — it stops and asks for
// /gsd-new-project. MC only offered that for repos it judged greenfield, so an
// established repo with no GSD project fell between the two cases. An agent holding a
// complete mission description then built the thing rather than relaying the question,
// which is exactly what happened twice on a real ticket.

test("the plan sequence is decided by project state, not by guessing greenfield", () => {
  const bare = mkdtempSync(join(tmpdir(), "mc-gsd-bare-"));
  const ready = mkdtempSync(join(tmpdir(), "mc-gsd-ready-"));
  mkdirSync(join(ready, ".planning"), { recursive: true });

  const seq = cwd => JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
print(json.dumps(g.plan_sequence(${JSON.stringify(cwd)})))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

  assert.deepEqual(seq(bare), ["/gsd-new-project --auto", "/gsd-quick --validate"],
    "an uninitialised repo must be initialised before a phase can be planned into it");
  assert.deepEqual(seq(ready), ["/gsd-quick --validate"],
    "an initialised repo must not be re-initialised");

  rmSync(bare, { recursive: true, force: true });
  rmSync(ready, { recursive: true, force: true });
});

test("the prompt states the precondition rather than assuming it", () => {
  const text = execFileSync("python3", ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
print(g.plan_step_text())
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  assert.match(text, /\.planning/, "the agent has to know what to check for");
  assert.match(text, /gsd-new-project/, "and what to run when it is missing");
  // The observed failure was skipping ahead to code when planning could not proceed.
  assert.match(text, /must not\s+skip ahead to writing code/);
});

test("a ticket's own choice of GSD door outranks the default", () => {
  // Quick by default — same 19-task decomposition on MET-635 in 155 turns instead
  // of 1,365 — but work that genuinely spans phases can ask for the full workflow.
  const r = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
print(json.dumps({
  "default": g.plan_command(),
  "asked_phase": g.plan_command(mode="phase"),
  "asked_mvp": g.plan_command(mode="mvp"),
  "typo": g.plan_command(mode="nonsense"),
}))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  assert.match(r.default, /gsd-quick/);
  assert.match(r.asked_phase, /gsd-plan-phase/);
  assert.match(r.asked_mvp, /gsd-mvp-phase/);
  // A typo on a ticket must not stop it being planned.
  assert.match(r.typo, /gsd-quick/);
});
