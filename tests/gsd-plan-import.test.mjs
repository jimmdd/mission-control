// MC's plan endpoint serves `bridge/plans/<id>.json` — a step list the ticket page
// draws as a map. GSD writes `.planning/**/NN-NN-PLAN.md`: YAML frontmatter plus
// <task> blocks. Nothing translated between them, so MET-635 — ten planned steps
// across 24 files, sitting on disk — reported {"plan": null} and the page said
// "no plan yet" indefinitely.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

function planFile(wave, tasks) {
  return `---
phase: quick-260814-abc
plan: 0${wave}
wave: ${wave}
depends_on: []
files_modified:
  - src/a.ts
---

<tasks>
${tasks.map((t, i) => `<task type="auto">
  <name>Task ${i + 1}: ${t.title}</name>
  <files>${(t.files || []).join(", ")}</files>
  <action>Some long action prose that the map does not print.</action>
  ${t.verify ? `<verify>${t.verify}</verify>` : ""}
</task>`).join("\n")}
</tasks>
`;
}

function importPlans(dir) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_plan_import as g
files = sorted(Path(sys.argv[1]).rglob("*PLAN.md"))
print(json.dumps(g.to_mc_plan(files)))
`, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

function withPlans(files) {
  const dir = mkdtempSync(join(tmpdir(), "mc-gsdplan-"));
  mkdirSync(join(dir, "quick", "t"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, "quick", "t", name), body);
  }
  return dir;
}

test("GSD tasks become steps the map can draw", () => {
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [
    { title: "Relocate the brand intro", files: ["a.svelte", "b.ts"], verify: "npm test" },
    { title: "Add the guide skeleton", files: ["c.svelte"] },
  ]) });
  const p = importPlans(dir);
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].step, 1);
  assert.equal(p.steps[0].title, "Relocate the brand intro", "the 'Task N:' prefix is stripped");
  assert.deepEqual(p.steps[0].files, ["a.svelte", "b.ts"]);
  assert.equal(p.steps[0].verify_command, "npm test");
  assert.equal(p.source, "gsd");
  rmSync(dir, { recursive: true, force: true });
});

test("the numbering is not repeated on every node", () => {
  // "Task 3: Do the thing" would print the position twice — the step already
  // carries its number.
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [{ title: "Do the thing" }]) });
  assert.doesNotMatch(importPlans(dir).steps[0].title, /^Task\s*\d/);
  rmSync(dir, { recursive: true, force: true });
});

test("tasks inside one plan file are sequential, not a swarm", () => {
  // This grouping is load-bearing: planner.py reads parallel_groups from the same
  // file to decide how many agents to dispatch at once. Putting a plan's ten tasks
  // in one group would fire ten agents for work GSD wrote as ten ordered steps,
  // each with a precondition describing what the last one left behind.
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [
    { title: "first" }, { title: "second" }, { title: "third" }]) });
  const p = importPlans(dir);
  assert.deepEqual(p.parallel_groups, [[1], [2], [3]], "one at a time");
  assert.deepEqual(p.steps[0].depends_on, []);
  assert.deepEqual(p.steps[1].depends_on, [1]);
  assert.deepEqual(p.steps[2].depends_on, [2]);
  // Undeclared files are why: without a list, disjointness cannot be shown.
  rmSync(dir, { recursive: true, force: true });
});

test("separate plan files in one wave are what run together", () => {
  // That is what a wave means in GSD: files, not tasks.
  const dir = withPlans({
    "01-01-PLAN.md": planFile(1, [{ title: "a1" }, { title: "a2" }]),
    "01-02-PLAN.md": planFile(1, [{ title: "b1" }, { title: "b2" }]),
  });
  const p = importPlans(dir);
  assert.equal(p.steps.length, 4);
  assert.deepEqual(p.parallel_groups, [[1, 3], [2, 4]], "the Nth task of each file runs together");
  // Dependencies follow the grouping, so the second position waits for the whole
  // first position rather than only for its own file's predecessor.
  assert.deepEqual(p.steps[1].depends_on, [1, 3]);
  assert.deepEqual(p.steps[3].depends_on, [1, 3]);
  rmSync(dir, { recursive: true, force: true });
});

test("a later wave still follows the earlier one", () => {
  const dir = withPlans({
    "01-01-PLAN.md": planFile(1, [{ title: "first" }]),
    "01-02-PLAN.md": planFile(2, [{ title: "second" }]),
  });
  const p = importPlans(dir);
  assert.deepEqual(p.parallel_groups, [[1], [2]]);
  rmSync(dir, { recursive: true, force: true });
});

test("a plan file with no tasks contributes nothing", () => {
  // A document about planning is not a plan — the same rule find_plan applies.
  const dir = withPlans({ "01-01-PLAN.md": "---\nwave: 1\n---\n\nNo tasks here.\n" });
  assert.equal(importPlans(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test("it is written where the plan endpoint looks", () => {
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [{ title: "only" }]) });
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  execFileSync("python3", ["-c", `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_plan_import as g
g.write_mc_plan(Path(sys.argv[1]), "task-123", sorted(Path(sys.argv[2]).rglob("*PLAN.md")))
`, home, dir], { stdio: "ignore" });
  const dest = join(home, "bridge", "plans", "task-123.json");
  assert.ok(existsSync(dest), "the endpoint reads bridge/plans/<id>.json");
  assert.equal(JSON.parse(readFileSync(dest, "utf8")).steps.length, 1);
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("adjacent steps that touch no common file are merged into one wave", () => {
  // "One at a time" is a stand-in for the real constraint, which is that two
  // agents editing the same file collide. The plan says which files each task
  // touches, so that constraint is checkable rather than assumed.
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [
    { title: "touch a", files: ["src/a.ts"] },
    { title: "touch b", files: ["src/b.ts"] },
    { title: "touch c", files: ["src/c.ts"] },
  ]) });
  const p = importPlans(dir);
  assert.deepEqual(p.parallel_groups, [[1, 2, 3]], "independent work runs together");
  rmSync(dir, { recursive: true, force: true });
});

test("a shared file keeps them apart", () => {
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [
    { title: "touch a", files: ["src/a.ts"] },
    { title: "also touch a", files: ["src/a.ts", "src/b.ts"] },
  ]) });
  assert.deepEqual(importPlans(dir).parallel_groups, [[1], [2]]);
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown file list is not treated as disjoint", () => {
  // Unknown is not disjoint, and the cost of being wrong is two agents writing
  // the same file.
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [
    { title: "declares nothing", files: [] },
    { title: "touch b", files: ["src/b.ts"] },
  ]) });
  assert.deepEqual(importPlans(dir).parallel_groups, [[1], [2]]);
  rmSync(dir, { recursive: true, force: true });
});

test("the real plan is not widened, because its tasks are not independent", () => {
  // 29 of MET-635's 45 task pairs share a file and one test file is touched by
  // seven of ten tasks. Staying serial there is the honest answer, and the point:
  // the widening is earned per plan, not granted.
  const dir = withPlans({ "01-01-PLAN.md": planFile(1, [
    { title: "one", files: ["shared.test.ts", "a.ts"] },
    { title: "two", files: ["shared.test.ts", "b.ts"] },
  ]) });
  assert.deepEqual(importPlans(dir).parallel_groups, [[1], [2]]);
  rmSync(dir, { recursive: true, force: true });
});
