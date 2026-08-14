# Handoff — Mission Control v2, spec-driven execution

Sessions of 2026-08-11 → 08-14. Branch `feat/deterministic-verification`, **71 commits, 247 tests
green, `tsc` clean, nothing pushed anywhere — and the user has asked that it stay that way.**

Read `~/.claude/plans/kind-mixing-pixel.md` for the original plan. This document covers what
actually happened, which diverged in the ways that matter.

---

## The one-paragraph version

The thesis is that GSD decomposes work into tasks small enough that a cheaper model executes
them correctly, so the strongest model goes on planning and execution parallelises across
pools. Phase 0 exists to test that. **It has still never been tested**, because two things had
to be true first and neither was: verification had to be trustworthy, and GSD had to actually
run. **Both are now true and both were verified by running them.** GSD produces plans; the gate
passes on unmodified code. What has never run is the half after planning — execute, verify,
review — so Phase 0 is still untaken, but for the first time nothing upstream is blocking it.

## State right now

- Daemon **running** (`python3 swarm/bridge.py --daemon --interval 60`), MC server on
  `http://127.0.0.1:18900`. Agent registry empty; concurrency is memory-gated, currently unlimited.
- Ticket MET-635 = `34581c3d-9abc-4993-9974-05fe066146b1`, **re-triaged from scratch**, status
  `planning`, **1 of 6 questions answered**. Its plan and progress were archived on reset.
- **Triage picked the wrong repo** — `metadao/metadao-frontend-v2`, which has no `coda/new-ui`
  branch. Question 1 asks about exactly that and is unanswered. Do not read anything downstream
  of it as sound until that is settled.
- The font question is settled in fact if not on the ticket: **Dalton Maag "Host & Link"**, which
  licenses self-hosting. `~/Downloads/HostLink_AktivGroteskVF_Wght`. Serve
  `WebVariableFonts/Basic/AktivGroteskVF_W_Basic_Wght.woff2` (132 KB, whole 100–900 axis) from
  `apps/new-ui/static/fonts/`. Subsetting is permitted; a **cross-origin header is required** by
  §02.02, and the page-impression cap is on the invoice, not in the PDF.
- Worktrees under `~/GitProjects/metadao/worktrees/`: `planstage-v2` (full phase run),
  `planstage-quick` (the comparison). Both disposable — ask before deleting.
- `~/GitProjects/metadao/backend-phase0` — clone with push URL `DISABLED://phase0-no-push`.
- `no_pr: true` in local `swarm-config.json`.

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

## The blockers that were live, and how they went

### 1. GSD does not produce a plan — **resolved**

Both causes below were real and both are fixed; a run on 2026-08-13 returned
`plan_written` with six plans and 19 `<task>` blocks. Kept because the diagnosis
took two sessions and is worth not repeating.

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
3. Verified 2026-08-13: the rerun produced `.planning/` and plans. A third fault sat behind
   them — `find_plan` globbed `PLAN.md` while GSD writes `01-01-PLAN.md`, so the first
   successful run would have been reported as a failure.

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

1. **Give research file access.** It answers from context only and invents
   explanations for what it cannot see. Everything else about research is now good;
   this is the gap. It should run in the target worktree with tools, like the plan
   stage already does.
2. **The confirm card (design 3d).** Dispatch creates branch, worktree and tmux with
   no confirmation — on a ticket where triage picked the wrong repo. The design says
   "confirm → dispatch is the only write" precisely to catch that.
3. **Nothing advances to phase 2.** GSD plans one phase; MC calls `plan_in_worktree`
   once and dispatches. A 3-phase roadmap silently never finishes, and the work would
   look complete at a third done. Related and undecided: MC's step plan and GSD's
   phase plan are two different decompositions with nothing reconciling them.
4. **Run the execution half.** `/gsd-execute-phase`, verify, review — never run
   through MC, ever. Everything this branch fixed is upstream of it.
5. Then Phase 0 proper, per `docs/phase-0-measurement.md`.

## The design, and what is left of it

The design now lives in the Claude Design project
`4c059ea3-b551-48a7-884f-527e59f466b1`, file `Mission Control UI.dc.html`, read
through the `DesignSync` MCP (`get_file`). It supersedes
`~/Downloads/Mission control ticketing UI.zip`, which is the older handoff.

Built, as of 2026-08-14: **2b and 2c, the whole ticket thread**, on
`public/ticket.html`.

The earlier read — that 2b's 206px rail was cross-ticket navigation belonging on
the dashboard — was wrong, and dropping it was most of why the page was "closer,
still not right". Without it the page was a document with a conversation inside
it; with it, it is the shell the design draws. The rail answers "what else is
waiting on me" without a trip back to the board.

The shell is a three-track CSS grid, not nested boxes: the rails need to run the
full height beside a header that belongs only to the middle column, and every
part has to stay a flat sibling so it can be rendered and tested on its own.
Under 1080px it collapses back to a document.

**2c is the same thread after triage settles** — no second screen. A rule marks
where the questions stopped and the plan arrives under it as a message. The plan
map is no longer a separate view: it was below the fold, which put the
decomposition on the far side of a scroll from the decisions it was built out
of. It is behind `open ▸` on the plan card.

Two wordings are deliberate and should not be "fixed":

- The card says **"from D-01 · D-02"**, not "cites". What is true is that those
  decisions were settled and handed to the planner. Whether the plan text cites
  them is a claim about a document nobody on this page has read.
- Every state in it is **counted off `progress`**, never read off `task.status`.
  "in_progress" on the ticket and a step actually running are different claims.

Rail sections render only when they have content — an empty `DELIVERABLES`
heading asserts the run produced nothing, which is not the same as "nothing is
recorded". `RECALLED` is `GET /api/knowledge/recall`, which shells out to Python
and is allowed to fail silently. `CONTEXT USED` from the design is **not built**:
no endpoint records which files triage read, and inventing the list was the one
thing worse than omitting the section.

Not built, and each lives somewhere different:

- **3a–3d intake** (describe → draft → scope → questions → confirm) is a new
  pre-ticket surface, 620px chat frames. 3d, the confirm card, is still
  next-step 2 below.
- **1a attention inbox / Needs you** is the general view — `public/index.html`
  and `app.js`, not the ticket page.
- 2c's mid-run controls — `Pause after this step`, `Attach tmux`, `/pause`,
  `/replan` — have no endpoints behind them. The composer shows only what works:
  "Change a decision", which reopens one.

## Session of 2026-08-13/14

**GSD works end to end.** `plan_written` on MET-635: init 5.5 min, plan 38 min, six
plans, 19 `<task>` blocks. That was the thing that had never happened.

### The measurement that changed everything

Planning cost is `turns × accumulated context`, and output is a rounding error.
From the transcript, per-turn (rollup events excluded — including them inflated an
earlier figure to 386M, which was wrong):

| | |
|---|---:|
| turns | 1,365 |
| context re-read | 237 M |
| avg context per turn | 173 K |
| output | 101 K |

Context grows 90 K → 228 K per turn as the orchestrator accumulates every file it
reads. **485 turns were `echo pN` idle polls**, each described by the model as
"idle", ~200 K apiece: GSD backgrounds its planner and tells the orchestrator to
"repeat gsd_stall_watch while waiting", and on Claude Code every repeat is a turn.

Two fixes came out of it, both measured:

- **The waiting protocol** — the prompt now says to block inside one shell command
  and names `echo p1` as the failure, because the model invented it.
- **`/gsd-quick` is now the default door.** Same ticket, same start state:
  **155 turns vs 1,365, 7.4 M context vs 237 M, 18.6 min vs 38 — and an identical
  19-task decomposition.** `/gsd-plan-phase` runs ~20 project-phase gates (threat
  model, Nyquist artifacts, API-surface regeneration) that one ticket never needed.
  A ticket can name another door via `plan_mode` in its triage state; that outranks
  the default, and a typo falls back rather than failing.

**GSD is a thick meta-prompt system, not a thin one.** `plan-phase` is 2,005 lines
defining ~20 self-run steps and only 6 delegations. MC's own contribution is 25
lines. We were never the bottleneck — we picked the wrong entry point.

### GSD cannot ask a question here — verified, and it fails silently

The open question was whether MC should keep its own triage layer or hand the
asking to `/gsd-discuss-phase`. It cannot be handed over, and the evidence is on
disk rather than in an argument.

`~/.mission-control/bridge/plan-stage/*.plan.log` records the `system` init event
listing every tool the session was offered. **`AskUserQuestion` is not among the
163.** Claude Code withholds it under `-p`. Across all three transcripts there is
not one `tool_use` block naming it; the 60 / 7 / 9 textual hits are the workflow
markdown being read by `Read`.

That is worse than a stall, and it is the same failure as the `gsd:` colon
commands: **a tool named in a prompt but absent from the runtime fails silently.**
The agent drops the step and works from the surrounding prose — so a discussion
gate becomes the agent deciding alone, with nothing recording that a question
existed. GSD's own escape, `--text` / `workflow.text_mode`, is documented as
"required for non-Claude runtimes where `AskUserQuestion` is not available", but
it only replaces the call with a numbered list and a request to type a choice.
Under `-p` there is nobody to type it.

Two consequences, both now closed:

- **`quick` is safe and that is not luck.** Its single `AskUserQuestion`
  (`quick.md:53`) fires only when the description is empty, and MC always supplies
  one. Being the cheap door and being the headless-safe door are the same fact.
- **`plan-phase` was not.** `PLAN_MODES["phase"]` passed `--prd` with no filepath,
  and `plan-phase.md:71` only sets `PRD_PARAM` when the flag is followed by a
  non-flag token — so the express path never fired, the run fell through to step 4
  ("Load CONTEXT.md"), and its empty branch called `AskUserQuestion`. MET-635 was
  planned without its decisions, silently. Dead since it was written, and it read
  as a feature.

`swarm/gsd_brief.py` now writes the settled decisions into the worktree as a PRD
and the phase door is given its path. GSD's express path converts every
requirement into a locked decision in `CONTEXT.md` and bypasses the gate. Deferred
questions are written under "out of scope" — deciding not to decide is a
constraint, and dropping it invites the planner to build the thing the deferral
was avoiding.

`FORBIDDEN_FLAGS` asserts no door emits `--discuss`. Do not add one: there is no
way to answer it here.

### Planning is a contract, not a Claude feature

`plan_in_worktree` takes a provider. GSD ships as Claude Code skills, so
`/gsd-plan-phase` resolves nowhere else — but its workflows are markdown, so a
runtime without the skill is handed the document and told to write the same
artefacts to the same paths. If the document is missing it stops rather than
improvising, because a plausible plan that is not GSD's decomposition would corrupt
Phase 0. The verdict never reads the transcript (`find_plan` looks at disk), so a
plan written by codex counts exactly as much as one written by claude.

`codex` is installed; **the Gemini CLI is not**, so Gemini is only reachable via the
API path that predates the keyless move.

### The question layer, rebuilt as one conversation

The card layout put a text box on every question down a list that re-rendered on a
timer. It is one stream now, with a decision rail beside it. Clicking decides,
typing talks. Settled questions collapse to a line carrying their outcome.

**Research changed shape twice.** It now settles what it can answer — a question
research can answer is not a question — recording it as the agent's call with its
reasoning, takeable back. It only stays open when a person must choose. Weaker
cases become a `recommends` that lights one pill, labelled "still your call".

**Research cannot read files.** `_answer_thread` is a bare LLM call: no cwd, no
tools. Asked to check whether a `/brand` route existed it invented a scope
restriction rather than saying so. It is now told plainly it cannot read files —
but **giving it real repo access is the highest-value thing left undone.** A cheap
model that can read beats an expensive one that cannot, on exactly the questions
research should be best at. Research runs `claude-opus-5`; triage runs
`claude-sonnet-5`; each reply records which.

### Bugs found by looking, not by testing

Every one of these was found by the user opening the page, not by the suite:

| | |
|---|---|
| `find_plan` globbed `PLAN.md`; GSD writes `01-01-PLAN.md` | the first successful run in this project's history would have been filed as a failure |
| Each planner question rendered twice; two elements shared `id="submit"` | the second card's button was wired to nothing |
| The poll wiped what you were typing, and listeners restacked every render | ten polls in, ten handlers per keystroke |
| Draft restore put sent text straight back | a sent message read as though it had failed |
| `load()` still called `renderQuestions` after it was deleted | page dead on arrival while 230 tests passed |
| Timestamp-first sort detached replies from their question | a message you typed floated at the bottom, from nowhere |
| Settled questions still offered clickable option pills | answer something already decided |
| `option[0]` marked "recommended" | attributed a suggestion to the agent it never made |

There is now a test that drives `load()` against a stubbed DOM — the gap that let
the dead page through. **The UI is still not covered by anything that exercises real
interaction** (focus, timers, typing); that is where the next one hides.

### Bugs found by looking, again (session of 2026-08-14)

Rebuilding the page as 2b/2c surfaced four more, none of which any test could have
caught, because each is a thing that is only wrong once you see it:

| | |
|---|---|
| The brief printed its attachment URLs raw | MET-635's are 140 characters each — four lines of signed S3 query string above the conversation the page exists for |
| Tracker legs ahead of the current one were dated | `LEG_MARKERS` is loose on purpose (`/review/i` matches plenty of messages), so Review claimed a date on a ticket still in Triage |
| The composer said "planning starts when the questions are settled" | on a thread where all six were settled — the page disagreeing with itself |
| A collapsed decision's outcome ran off the column | sliced mid-word by the edge, with no ellipsis to say so |

To see the page without the Chrome extension:
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless
--screenshot=t.png --window-size=1440,1000 --virtual-time-budget=5000
--user-data-dir=<scratch> "http://127.0.0.1:18900/ticket?id=<id>"`. It is slow to
start (~20s) but it renders the real page against the real server, which is the
only thing that found any of the above.

### Also fixed

- **Reset now archives the plan.** A kicked-back ticket kept its plan on disk, and
  the progress file still said `in_progress` with pending steps — enough for the
  daemon to dispatch agents against a discarded plan for a ticket in the inbox.
- **Concurrency is memory, not a count.** Three registry entries claimed `running`
  with no process behind them and held three of four slots; a reaper releases them
  now, recording `agent_reaped`. Below 90% memory there is no limit at all.
- **Planning runs out of process**, so one task's planning no longer freezes the
  whole poll loop for up to an hour.
- The gate check moved onto the dispatch path, so retries are covered too.

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
| GSD entry points, plan modes | `swarm/gsd_backend.py` → `PLAN_MODES`, `plan_mode()` |
| Planning stages, providers, waiting protocol | `swarm/plan_stage.py` |
| Planning out of process | `swarm/plan_stage_runner.py`, `bridge._start_planning_job` |
| Memory ceiling, agent reaping | `swarm/resources.py`, `bridge.reap_dead_agents` |
| The conversation UI | `public/ticket.html` (pure renderers above `// ---- BOOTSTRAP ----`) |
| Design handoff | `~/Downloads/Mission control ticketing UI.zip` |
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
