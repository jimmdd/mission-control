# Adaptive bounded issue routing

The opt-in policy `adaptive-bounded-v1` permits bounded frontend and backend fixes
on the light workflow. UI-only probability is retained for historical shadow data;
it no longer determines the live route. Light requires scope <= 1.2/3 and complete,
finite risk scores below 0.3 for behavioral uncertainty, blast radius, difficulty
of rollback, difficulty of testing, migrations/broad contracts, and funds/chain/auth
semantics. These are conservative initial policy thresholds, not calibrated outcome
probabilities. Missing, malformed or failed assessments take the heavy path.

Light means trace/repro, brief plan, minimal fix with regression, focused checks,
independent review, bounded repair, and an authorized draft PR. Heavy adds a written
plan and independent plan critique in the same session. GSD is available explicitly
for tasks warranting structured staged planning. Neither lean path requires a GSD
project bootstrap. Semantic risk wins over filenames: bounded backend mappings,
read queries and local shared helpers are allowed; migrations/schema, auth/program
paths, CI and >15 files are conservative escalation backstops. Agents must also
escalate semantic risks that paths cannot reveal.

Routing reasons, raw scores, policy version and timestamp persist in triage state.
Agents must report each stage to the existing progress API and activity history.
This is a prompt contract using existing persistence, not a new enforced workflow
state machine. Failed routing persistence stops dispatch. Explicit escalation
outranks cached light choices and light overrides; repeated pickup reuses the
persisted result. A planning job already owned by GSD always stays GSD. Active
runs retain their recorded route; active legacy runs remain GSD. Ordinary overrides
only affect tasks before execution. Existing question checkpoints provide the
answer surface, notification and resume path; incomplete planner question output
uses the existing actionable operational escalation path.

## Reversible rollout (not activated by this change)

1. Integrate this branch into the bridge's source checkout while preserving any
   unrelated local changes. This branch is based on the committed routing baseline;
   separate uncommitted health, review-recovery and Linear-sync fixes remain owned
   by their existing workers and are not included here.
2. Coordinate with the owner of any active run. Do not restart or hot-patch the
   bridge during that run; an explicitly authorized per-ticket cancellation is a
   separate operation owned by its monitor. The running Python process must load
   new source at a later approved restart; config alone cannot load new code.
3. Enable one *future*, unstarted task with an allowlist in `workflowRouting`:
   `{"enabled":true,"taskIds":["FUTURE_TASK_ID"]}`. No IDs/config are changed by
   this branch. Empty or malformed allowlists disable automatic selection.
   Existing explicit per-ticket overrides retain their behavior outside the canary.
4. Verify the persisted policy/reasons, stage events, independent review and draft
   result for a bounded issue. A reviewer failure blocks delivery. Observe at least
   one escalation and one blocked-question notification in an isolated test task.
5. Add future IDs gradually. Omitting `taskIds` enables global automatic routing;
   that requires a separate rollout decision. The default remains disabled when
   `workflowRouting.enabled` is absent or false.

Rollback: set `enabled:false` (or an empty canary allowlist) to stop routing new
unassessed tasks. Persisted decisions remain pinned for idempotent pickup; adjust
an explicit override on an unstarted task if it must change. Never clear/reroute an
active run. Reverting the branch requires a later approved bridge restart. No
merge, deploy, runtime restart, global enablement or PR publication is part of this
implementation.
