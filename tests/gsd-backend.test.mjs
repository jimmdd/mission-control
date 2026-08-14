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

// ─────────── GSD cannot ask a question here, so it must not be asked to ───────────
// Verified from a real run rather than reasoned about: the MET-635 plan transcript
// records the 163 tools that session was offered and `AskUserQuestion` is not among
// them — Claude Code withholds it under `-p`. Across all three plan-stage
// transcripts there is not one tool_use block naming it; the sixty textual mentions
// are the workflow markdown being read.
//
// A missing tool named in a prompt fails exactly the way the colon commands did:
// silently. The agent drops the step and proceeds from surrounding prose — so a
// discussion gate becomes the agent deciding alone, with no record that anything
// was ever asked. GSD's documented fallback (`--text`) only turns the tool call
// into a numbered list and a request to type a choice, and under `-p` there is
// nobody to type it.

function planCommands() {
  const out = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_backend as g
print(json.dumps({
    "modes": {m: g.plan_command(mode=m) for m in g.PLAN_MODES},
    "phase_with_brief": g.plan_command(mode="phase", brief="/w/MC-BRIEF.md"),
    "quick_with_brief": g.plan_command(mode="quick", brief="/w/MC-BRIEF.md"),
    "step_text": g.plan_step_text("claude", "phase", "/w/MC-BRIEF.md"),
    "step_text_bare": g.plan_step_text("claude", "phase"),
}))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

test("no door may put GSD into a discussion it cannot have", () => {
  const c = planCommands();
  for (const [mode, cmd] of Object.entries(c.modes)) {
    assert.doesNotMatch(cmd, /--discuss/, `${mode} would open a discussion with no way to ask: ${cmd}`);
  }
  assert.doesNotMatch(c.phase_with_brief, /--discuss/);
});

test("--prd is never passed without a path behind it", () => {
  // plan-phase.md:71 only sets PRD_PARAM when --prd is followed by a non-flag
  // token, so a bare `--prd` matched nothing and the express path never fired.
  // The run then fell through to step 4, whose empty branch calls AskUserQuestion.
  const c = planCommands();
  for (const [mode, cmd] of Object.entries(c.modes)) {
    assert.doesNotMatch(cmd, /--prd(\s|$)(?!\S)/, `${mode} passes a valueless --prd: ${cmd}`);
    assert.doesNotMatch(cmd, /--prd$/, `${mode} ends on a bare --prd: ${cmd}`);
  }
  assert.match(c.phase_with_brief, /--prd \/w\/MC-BRIEF\.md/, "with a brief, the path is supplied");
});

test("only the door with a PRD express path is given the brief", () => {
  // quick names its context file after an id it generates mid-run, so there is no
  // path to hand it in advance — and it needs none: its one AskUserQuestion fires
  // only on an empty description, and we always supply one.
  const c = planCommands();
  assert.doesNotMatch(c.quick_with_brief, /--prd/);
  assert.match(c.quick_with_brief, /^\/gsd-quick/);
});

test("the plan step says the decisions are locked, and only when they exist", () => {
  const c = planCommands();
  assert.match(c.step_text, /MC-BRIEF\.md/);
  assert.match(c.step_text, /locked/i);
  assert.doesNotMatch(c.step_text_bare, /MC-BRIEF/, "no brief, no claim that one exists");
});

// The brief is what makes an answer binding rather than advisory. GSD's PRD express
// path turns every requirement in it into a locked decision in CONTEXT.md and
// bypasses the gate that would otherwise ask about the missing context.

function brief(task, questions) {
  return execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_brief
task, qs = json.loads(sys.argv[1]), json.loads(sys.argv[2])
print(gsd_brief.render(task, qs))
`, JSON.stringify(task), JSON.stringify(questions)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

test("every settled decision becomes a requirement the planner must honour", () => {
  const out = brief(
    { title: "Paginate /api/tasks", description: "See [the design](https://x.example/a?sig=abc)." },
    [{ becomes: "D-01", question: "Cursor column?", answer: "created_at", why: "picks the index" },
     { becomes: "D-02", question: "Page size?", answer: "50", answered_by: "agent", reason: "list renders 20" }]);

  assert.match(out, /## Requirements/);
  assert.match(out, /\*\*D-01\*\* — Cursor column\?/);
  assert.match(out, /Decision: created_at/);
  // A delegated pick reads as delegated here too, so the planner is not told a
  // human weighed something an agent decided.
  assert.match(out, /chosen by the agent on the user's behalf/);
  assert.match(out, /locked/i);
  // The description's attachment URLs are noise in a decision record; the words
  // somebody wrote are not.
  assert.match(out, /See the design\./);
  assert.doesNotMatch(out, /https?:/);
});

test("a deferred question is stated as out of scope, not dropped", () => {
  // "We decided not to decide this yet" is a constraint on the plan. Omitting it
  // invites the planner to build the thing the deferral was avoiding.
  const out = brief({ title: "T" }, [{ becomes: "D-03", question: "Rate limit?", deferred: true }]);
  assert.match(out, /## Out of scope/);
  assert.match(out, /\*\*D-03\*\*/);
  assert.match(out, /Do not build anything that depends on it/);
});

test("a ticket with no questions still produces a parseable brief", () => {
  // A PRD with an empty Requirements section is indistinguishable from one the
  // express path failed to read.
  const out = brief({ title: "T", description: "Just do the thing." }, []);
  assert.match(out, /## Requirements/);
  assert.match(out, /- \S/, "the section has at least one bullet");
});

test("the brief is only reported when it actually reached disk", async () => {
  // --prd pointing at a file that is not there sends the express path looking for
  // one, and the gate it exists to skip fires anyway.
  const out = execFileSync("python3", ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import gsd_brief
print(gsd_brief.write("/definitely/not/a/worktree", {"title": "T"}, []))
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(out.trim(), /^None$/);
});
