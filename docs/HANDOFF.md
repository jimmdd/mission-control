# Handoff — Mission Control v2, spec-driven execution

Session of 2026-08-11/12. Branch `feat/deterministic-verification`, **32 commits, 125 tests
green, `tsc` clean, nothing pushed anywhere.**

Read `~/.claude/plans/kind-mixing-pixel.md` for the original plan. This document covers what
actually happened, which diverged in the ways that matter.

---

## The one-paragraph version

The thesis is that GSD decomposes work into tasks small enough that a cheaper model executes
them correctly, so the strongest model goes on planning and execution parallelises across
pools. Phase 0 exists to test that. **It has still never been tested**, because two things had
to be true first and neither was: verification had to be trustworthy, and GSD had to actually
run. Both are now fixed or diagnosed. The remaining blocker is a build that fails on
unmodified code, which is in the target repo, not here.

## State right now

- Daemon **off**, no agents running, no worktrees, nothing pushed.
- MC server on `http://127.0.0.1:18900` (restart with `npm start`).
- Ticket MET-635 = task `34581c3d-9abc-4993-9974-05fe066146b1`, status `in_progress`,
  step 1 `blocked`, 9/9 questions answered. The font-licence follow-up was answered
  **Adobe Fonts — switch to a Web Project (use.typekit.net) and remove the committed
  binaries**, which is the decision the font work needs. Nothing acted on that answer;
  see next-step 5.
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

### 2. The gate cannot pass

`bun run --cwd apps/new-ui build` fails on the **unmodified base commit** —
`MISSING_EXPORT "PUBLIC_API_URL"` from `$env/static/public`. Confirmed with a control worktree.
So no Phase 0 number is possible until either the build works in a fresh worktree (your repo's
problem, not MC's) or the sweep targets a ticket whose build already runs locally.

`validate_plan_gates` catches this before dispatch — on MET-635's plan it blocks steps 1–3 and
correctly passes step 4. **Known gap: it runs only in `_plan_and_dispatch`, not on the retry
path.** A step re-dispatched directly escalated `claude → codex` straight into the broken gate.
Fix that before further runs.

## Next, in order

1. **Re-run step 1** to verify the `/gsd-new-project` fix produces `.planning/` with a
   `PLAN.md` containing `<task>` blocks. Dispatch into `backend-phase0`; watch for `.planning/`.
2. **Gate precheck on the retry path**, so a broken gate costs one attempt rather than the
   whole ladder.
3. **Stage the plan step** — its own `claude -p` process with captured stdout, then classify:
   plan written / questions raised / prerequisite missing / error. This is the big one and it
   is what everything else waits on. Rationale: a stage buried in a 200-turn session cannot
   report why it failed; tonight the planner produced a precise, actionable question and it
   went to a terminal and died.
4. **Route planner questions to the UI** with `source: "planner"`. The section already exists
   and is tested; nothing writes that field yet.
5. **Close the loop: answering a follow-up must resume planning.** This is missing entirely and
   is the half that makes the feature real. Today the section renders, the answer is stored in
   `triage_state`, and then nothing happens — no code watches for a follow-up becoming answered,
   so planning stays stopped until a human notices and re-dispatches by hand. Verified live: the
   font-licence follow-up was answered and the ticket did not move.

   What it needs:
   - A watcher on the planning path (`process_planning_tasks` is the natural home) that fires
     when a step is held on follow-ups and all of them now have answers.
   - Re-dispatch of the *plan stage only*, not the whole step — the answer changes the spec, not
     the work already done.
   - The answers must reach the planner's prompt. `_build_triage_context` already folds answered
     questions in, so this mostly works; confirm follow-ups are included and labelled as
     decisions rather than triage answers.
   - A guard against loops: a planner that raises a follow-up, gets an answer, and raises the
     same one again should escalate rather than cycle.

   Note the daemon is off in the current state, so nothing polls at all — turn it on before
   expecting any of this to trigger.
6. Then Phase 0 proper, per `docs/phase-0-measurement.md`.

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

- **Rotate the Linear key** pasted into the transcript (`lin_api_…`). It is a test key per the
  user, but it is in a transcript. *(An earlier warning about a Codex token was mine and wrong
  — retracted; nothing read it.)*
- **`apps/new-ui` ships 4 Aktiv Grotesk `.woff2` files self-hosted.** Adobe Fonts terms do not
  permit self-hosting; web use must come from `use.typekit.net`. Which licence you hold changes
  the implementation. This is the one open follow-up on the ticket.
- Branch unpushed, no PR.
- This laptop now has `~/.mission-control`, a global GSD install
  (`~/.claude/settings.json.pre-gsd.bak` reverts it), an `rm -rf` confirmation hook at
  `~/.claude/hooks/confirm-recursive-delete.sh` (active from a new session), and the
  `backend-phase0` clone.

## Where things live

| | |
|---|---|
| Command spellings, GSD probes | `swarm/gsd_backend.py` |
| Dispatch, escalation, metrics, gate check | `swarm/bridge.py` |
| Verification, plan generation, config | `swarm/planner.py` |
| Ticket page | `public/ticket.html` (pure render helpers above `// ---- BOOTSTRAP ----`) |
| Plan + progress API | `src/routes.ts` → `/api/tasks/:id/plan` |
| Metrics | `$MC_HOME/bridge/metrics/step-attempts.jsonl` |
| How to run the sweep | `docs/phase-0-measurement.md` |
| Research, incl. iron-proxy | `docs/research-notes.md` |
