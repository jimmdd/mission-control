# Handoff — Mission Control v2, spec-driven execution

Sessions of 2026-08-11/12. Branch `feat/deterministic-verification`, **39 commits, 177 tests
green, `tsc` clean, nothing pushed anywhere.**

Read `~/.claude/plans/kind-mixing-pixel.md` for the original plan. This document covers what
actually happened, which diverged in the ways that matter.

---

## The one-paragraph version

The thesis is that GSD decomposes work into tasks small enough that a cheaper model executes
them correctly, so the strongest model goes on planning and execution parallelises across
pools. Phase 0 exists to test that. **It has still never been tested**, because two things had
to be true first and neither was: verification had to be trustworthy, and GSD had to actually
run. The gate blocker is now fixed at the root — it was a worktree with no environment, not a
broken base commit — so the one remaining unknown is whether the `/gsd-new-project` fix makes
GSD produce a plan. That rerun has not happened.

## State right now

- Daemon **off**, no agents running, no worktrees, nothing pushed.
- MC server on `http://127.0.0.1:18900` (restart with `npm start`).
- Ticket MET-635 = task `34581c3d-9abc-4993-9974-05fe066146b1`, status `in_progress`,
  step 1 `blocked`, 9/9 questions answered. The font-licence follow-up was answered
  **Adobe Fonts — switch to a Web Project (use.typekit.net) and remove the committed
  binaries**, which is the decision the font work needs. Nothing acted on that answer at the
  time; `process_answered_followups` is what now would, but the daemon is off.
- `~/GitProjects/metadao/backend-phase0` — clone with **push URL `DISABLED://phase0-no-push`**.
  Verified: `git push` fails. Delete it when done (ask first).
- `no_pr: true` in local `swarm-config.json`, so agents are told not to push or open PRs.

## What was built

**Phase 1 complete.** Deterministic verification (exit code, not an LLM judging the agent's own
transcript) · global concurrency cap · `parallel_groups` honoured · progress-write race fixed
with `flock` · capacity distinguished from spawn failure · escalation ladder on verify failure
· quota refusals switch pool without spending a retry.

**Phase 2 complete.** Every attempt appends to `$MC_HOME/bridge/metrics/step-attempts.jsonl`:
outcome, attempt, runtime, escalation flag, observable task shape. Outcomes seen so far:
`passed`, `failed_verification`, `rate_limited`, `exhausted`, `gate_invalid`, `gsd_skipped`.
See `docs/phase-0-measurement.md` for how to read it.

**Phase 4 partial.** `/ticket?id=<task-id>` — ticket header with dated tracker legs, follow-up
question section, collapsed decisions, and an SVG plan map (decisions → rounds, edges from
`depends_on`, click a node for full detail). Linked from every task card (`TICKET ↗`) and the
drawer. Plans-as-SQLite not done; the page reads `bridge/plans` and `bridge/progress` through
`GET /api/tasks/:id/plan`.

**Keyless.** `claude -p` and `codex exec` are providers for MC's own layer (planning, triage,
classification). No `ANTHROPIC_API_KEY` or Gemini key needed. Repo defaults unchanged; opt in
per role via `{role}_provider`. OpenRouter fallback explicitly disabled — it costs real money.

## Bugs found by running it, not by reading it

| Bug | Why it mattered |
|---|---|
| `run-codex.sh` ignored `PROMPT_OVERRIDE` | Codex agents re-ran their original task on every review-fix relaunch |
| Design MCP allowlist hardcoded `mcp__paper__*` | Yours is `plugin:paper-desktop:paper`, so Paper was never read and triage asked about what it was holding |
| Zip cap aborted on first overflow | Two MP4s ate the budget; `ENGINEER-HANDOFF.md` and all source never extracted, while the prompt said "use the provided implementation" |
| Triage read the checked-out branch | Planned against a codebase agents would never open |
| Triage and planner blind to attachments | Asked where tokens live while holding the stylesheet |
| Planner blind to the target app's tree | Planned to *build* a `/brand` page that already exists |
| Prompt said "integrate as-is" | Would have dragged React into a SvelteKit app |
| `verify_command` never checked for satisfiability | Silent quota sink: full retry budget + top of ladder, zero signal |
| Verification could run in a sibling worktree | False green from the gate the whole thesis rests on |
| Six local clones of one upstream | Repo selection non-deterministic on identical input |
| **the `gsd:` colon command form** | **GSD had never run through MC on this install** |

## The two live blockers

### 1. GSD does not produce a plan

Chain of causes, each verified rather than assumed:

1. MC emitted the colon form, `gsd:plan-phase`. GSD 1.10.0 installs skills named `gsd-plan-phase` (hyphen);
   no `~/.claude/commands` exists. A prompt naming a command that does not resolve **fails
   silently** — the agent drops that section and works from the surrounding prose. Two full
   runs: 67 and 46 tool calls, **zero Skill invocations**, one mention of "gsd" in each
   transcript (the prompt). Fixed in `swarm/gsd_backend.py`.
2. Fixing the names was **not sufficient**. A rerun still produced no `.planning/`. Invoking
   the skill directly gave the reason: `/gsd-plan-phase` cannot plan into a repo with no GSD
   project — it stops and asks for `/gsd-new-project`. MC only offered that for repos it judged
   *greenfield*, so an established repo with no GSD project had no branch. Fixed via
   `plan_step_text()`, which now tells the agent to check for `.planning/` and initialise first.
3. **Unverified:** whether step 2's fix works. That rerun has not happened.

Ruled out along the way, so do not re-investigate: skills **are** invocable from
`claude -p --dangerously-skip-permissions` (tested, returned `SKILL_RAN`), and the target repo
has no `.claude` settings or `CLAUDE.md` rule suppressing them.

`gsd_backend.workflow_ran(cwd)` now probes this deterministically via `gsd-tools progress`, and
the bridge records `gsd_ran` on the step plus a `gsd_skipped` metrics row. The graph marks such
steps with an amber left edge.

### 2. The gate cannot pass — **fixed, and the diagnosis was wrong**

The earlier reading was that `bun run --cwd apps/new-ui build` fails on the unmodified base
commit, and that this was the target repo's problem. Both halves were wrong. The branch was
never the issue either: the worktree is descended from `coda/new-ui` and `apps/new-ui` exists
on it.

The cause was that **a git worktree carries tracked files only**. With no `.env`, SvelteKit's
`$env/static/public` exports none of the `PUBLIC_*` names the source imports, so the build dies
on `MISSING_EXPORT "PUBLIC_API_URL"`; bare of `node_modules` it dies earlier, on exit 127.
Supply both and the same commit builds in 4.17s. Verified end to end — `check_verify_command_baseline`
now returns `runnable: True` on the untouched base ref.

`swarm/worktree_env.py` seeds both, for agent worktrees (via `spawn-agent.sh`) and the gate-check
probe. Real local config is copied when present, `.env.example` seeds placeholders otherwise, and
the two are reported separately so a pass stays attributable. A destination git would track is
skipped rather than written. Deps install only when a gate fails in a way that says the tree was
never set up.

The retry-path gap is closed too: the check moved from `_plan_and_dispatch` to `_dispatch_next_steps`,
the funnel both first dispatch and retries go through, with a per-command cache (passes kept,
failures re-probed after 15 minutes so a repaired gate recovers on its own).

## Next, in order

1. **Re-run step 1** to verify the `/gsd-new-project` fix produces `.planning/` with a
   `PLAN.md` containing `<task>` blocks. Dispatch into `backend-phase0`; watch for `.planning/`.
   This is now the only thing between here and Phase 0.
2. **Call the plan stage.** `swarm/plan_stage.py` and `route_plan_stage_outcome` are built and
   tested; what is not decided is where the stage runs relative to `_spawn_for_repos`, because
   that depends on what the rerun shows. Do it with the rerun, not before it.
3. Then Phase 0 proper, per `docs/phase-0-measurement.md`.

The daemon is off in the current state, so nothing polls at all — turn it on before expecting
any of the loops below to fire.

## Done since (session of 2026-08-12)

**Worktree environment** — see blocker 2 above. `swarm/worktree_env.py`, wired into
`spawn-agent.sh` and the gate probe.

**Gate check on every dispatch**, not just the first, with a per-command cache.

**Planning staged** (`swarm/plan_stage.py`). Its own `claude -p`, captured stdout, and one of
four verdicts: `plan_written` / `questions_raised` / `prerequisite_missing` / `error`. Taken
from the filesystem wherever it can answer — a plan means a `PLAN.md` with `<task>` blocks
exists, not that the agent said so. Questions count only in the `<mc-questions>` form, because
prose asking and prose thinking are indistinguishable. `route_plan_stage_outcome` posts raised
questions as planner follow-ups (which is what `process_answered_followups` resumes from),
escalates a missing GSD project as a prerequisite rather than a question, and escalates failures
with the transcript path and `gsd_ran`. **Not yet called** — see next-step 2.

**The question layer.** A question was a prompt and some options: enough to collect an answer,
not enough to get a good one. It now carries `why` it is being asked, the `becomes` decision id
its answer locks, its `thread`, and its `source` (`triage` before there is a plan, `planner`
because the plan stopped — the second leads the ticket).

Three exits sit beside every question, because "answer or the ticket stalls" is a false choice:

- **Ask about this** — opens a thread; `process_open_questions` replies, and is told to say
  plainly when the answer is one only you hold rather than guess.
- **Decide for me** — the agent picks and records why, marked `answered_by: "agent"` so it reads
  as delegated rather than decided, with "Change it" to take it back.
- **Decide later** — stops the question blocking, so one unanswerable question does not hold up
  the other eight. Deferred questions are excluded from the open count and passed to the planner
  under "do not re-ask, and do not build anything that needs these".

**Answering resumes the work** (`process_answered_followups`). This was the missing half.
It watches `planning`, `assigned` **and** `in_progress` — the follow-ups that matter are raised
after planning has started, which is why watching only `planning` meant MET-635 never moved.
Blocked steps are re-run rather than resumed mid-flight: the answer changes the spec, not what
was already built. It stops re-dispatching once the same question has come back twice
(`MAX_RESUME_ROUNDS`) and raises a checkpoint instead of cycling.

`_build_triage_context` now separates decisions from triage answers, so a follow-up answer
reaches the planner labelled as binding rather than buried in the opening Q&A.

**Rounds merge instead of rebuilding.** `post_planning_questions` listed the fields by hand, so
anything it did not know about — an agent's reasoning, a deferral, the conversation that was the
reason a question was still open — was erased on the next round.

Still missing from the original design (`claude.ai/code/artifact/c072dee6`): the `.qspike`
read-only investigation an agent can run mid-thread ("checking the migrations, ~40s"), the
`.talk` free-form box on the findings card, the `.crew` stage→model strip, and the editable
`.targets` block. The question thread is the part that was load-bearing; those are not.

Design rules settled this session, worth not relitigating:

- **The spec is a precondition.** Code produced without a plan is out of process. A step in that
  state must not auto-complete on a passing gate — hold it for a human to accept or redo.
- **Only ask what a human alone can answer.** "This repo has no `.planning/`" is a prerequisite
  the system fixes; "which font licence did we buy" is a real question. Asking the first kind
  trains people to click through, which is how the second kind stops being read.
- **Prefer an observable fact to an instruction being followed.** Exit codes over LLM judgement;
  `workflow_ran()` over trusting the prompt; a staged harness over asking an agent to
  self-orchestrate.

## Not started

Phase 3 (routing — blocked on Phase 0 data by design), Phase 5 (Colima scope/sandbox — now with
four iron-proxy entries queued in `docs/research-notes.md`, including boundary-level secret
injection), Phase 6 (identity + Slack, design in `docs/slack-adaptor.md`), Phase 7 (session
envelope + async approvals).

## Loose ends the user owns

- The Linear key and the font-licence decision were both handled by the user as of
  2026-08-12; neither blocks anything now.
- Branch unpushed, no PR — and the user has asked explicitly that it stay that way for now.
- This laptop now has `~/.mission-control`, a global GSD install
  (`~/.claude/settings.json.pre-gsd.bak` reverts it), an `rm -rf` confirmation hook at
  `~/.claude/hooks/confirm-recursive-delete.sh` (active from a new session), and the
  `backend-phase0` clone.

## Where things live

| | |
|---|---|
| Question shape, exits, merging | `swarm/questions.py` |
| Staged planning + verdicts | `swarm/plan_stage.py`, `bridge.route_plan_stage_outcome` |
| Worktree env + dep seeding | `swarm/worktree_env.py` |
| Question threads, delegation, resume | `swarm/bridge.py` → `process_open_questions`, `process_answered_followups` |
| Question actions API | `src/routes.ts` → `/api/tasks/:id/questions/:qid/{ask,delegate,defer,reopen}` |
| Command spellings, GSD probes | `swarm/gsd_backend.py` |
| Dispatch, escalation, metrics, gate check | `swarm/bridge.py` |
| Verification, plan generation, config | `swarm/planner.py` |
| Ticket page | `public/ticket.html` (pure render helpers above `// ---- BOOTSTRAP ----`) |
| Plan + progress API | `src/routes.ts` → `/api/tasks/:id/plan` |
| Metrics | `$MC_HOME/bridge/metrics/step-attempts.jsonl` |
| How to run the sweep | `docs/phase-0-measurement.md` |
| Research, incl. iron-proxy | `docs/research-notes.md` |
