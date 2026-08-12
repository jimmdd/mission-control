# Phase 0 — does a cheaper builder pass GSD tasks?

The thesis: GSD decomposes work into tasks small and unambiguous enough that any
competent model executes them correctly, because the plan carries the context. If that
holds, the strongest model belongs on research and planning, and execution parallelises
across whichever pools have headroom.

Three conditions have to hold for a weak executor to be safe. GSD supplies two, and the
third is now in the bridge:

| Condition | Where it comes from |
|---|---|
| Task small and unambiguous | GSD planner sizing: 10–30% context, 1–3 files, exact `<files>` |
| A check independent of the executor | Nyquist rule — every task carries `<automated>`; the bridge runs it and reads the exit code |
| Failure caught and escalated | `escalation_ladder` in `swarm-config.json` |

## What gets measured

Every attempt appends one JSON object to
`$MC_HOME/bridge/metrics/step-attempts.jsonl`:

```json
{"task_id":"…","step":2,"at":"…","outcome":"passed","attempt":1,
 "profile":"claude","base_profile":"claude","verified_by":"command",
 "escalated":false,
 "shape":{"category":"quick","file_count":2,"criteria_count":3,
          "has_verify_command":true,"depends_on_count":1}}
```

`outcome` is one of `passed`, `failed_verification`, `rate_limited`, `exhausted`.

The two numbers that decide the thesis:

- **First-try pass rate** — rows with `outcome=passed` and `attempt=1`, over all steps.
- **Escalation rate** — steps whose passing attempt has `escalated=true`.

Read escalation rate as a statement about *plans*, not only about cost. If the stronger
model rescues everything, plan quality is never being challenged, and the thesis is
untested rather than confirmed.

`shape` exists so outcome can be correlated against observable task properties. It
deliberately carries no difficulty or confidence field — GSD forbids its planner from
judging what is too hard, and self-rated confidence is a weak predictor. Routing has to
come from measured history and observable shape.

## Running a sweep

Vary one thing at a time and keep the plan fixed, or the result measures the plan
instead of the model.

1. Pick a ticket with a real `verify_command` on every step. Check it:
   `jq '[.steps[] | {step, verify_command}]' $MC_HOME/bridge/plans/<task-id>.json`
2. Set the starting runtime per category in `swarm-config.json` → `planner.step_categories`.
3. Disable escalation for the sweep — `escalation_ladder: {}` — so a weak runtime's
   failures are visible rather than rescued.
4. Run, then read the metrics file.
5. Repeat for the next candidate runtime **against the same saved plan**.

Then run it once more with escalation enabled, to measure what the ladder recovers.

### Candidates and what each one costs

| Candidate | Why it is on the list |
|---|---|
| A strong Claude model | Baseline. If this fails a task, the task is mis-planned. |
| A cheaper Claude model | Lightest draw on the Claude pool; same subscription. |
| Codex | A second, independent subscription pool — roughly doubles throughput at no marginal cost. Costs parallelism: GSD falls back to sequential inline execution when the `Agent` tool is unavailable. |
| A local model | Free, but gate it behind a tool-calling probe first: the binding constraint is reliable tool use, not reasoning. |

Billing here is subscription, not per-token, so the constraint is quota exhaustion
rather than dollars. Measure tasks completed per quota window and time-to-rate-limit
under sustained load — not cost per task.

## Plan quality: the other half

Run the sweep twice — once with plan convergence off, once on. If a converged plan lifts
the weakest runtime's first-try rate, that is the thesis proven, and it says to spend
quota on review rather than on a stronger builder.

Convergence is a GSD project setting, so it lives in the target repo's `.planning/`, not
in Mission Control:

```
workflow.plan_review_convergence: true
```

`/gsd:plan-review-convergence --claude --codex` then reviews the plans with both CLIs
and replans until the concerns are resolved, with stall detection and an escalation gate.

Two failure modes to design for rather than discover:

- **Reviewers disagreeing** — one ships, one blocks. This is the highest-signal event the
  loop produces. It must raise a checkpoint, never resolve by majority.
- **`--max-cycles` exhausted** — escalate, do not ship.

## Order of gates

Verification precedes review, always. A task failing its `<automated>` check must never
reach a reviewer: reviewing incomplete work spends the most expensive quota in the system
on a question already answered by an exit code.

```
plan → plan-review-convergence → execute (per-task automated checks)
     → validate-phase (coverage audit) → verify-work (human UAT)
     → code review → PR
```

## Prediction worth falsifying

Tasks that copy an existing pattern pass on any competent builder; tasks that create a
new interface fail. If that is the split, routing is easy — and since the plan is what
carries the context, plan quality matters more than builder choice.
