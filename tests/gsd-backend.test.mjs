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
