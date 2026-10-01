# Mission Control PR delivery gate

Adopted from oh-my-openagent at commit 412e7fd5675174614da66ba63b37d7c467bd2e01:
- .agents/skills/work-with-pr/SKILL.md: local CI validation, real-surface QA, reviewer-readable PRs, post-push CI/review repair loop.
- packages/shared-skills/skills/review-work/SKILL.md: independent approval plus real QA; missing/inconclusive review is not PASS.
- AGENTS.md PR MERGE POLICY: do not bypass failing gates or weaken checks; pre-existing CI failure remains a blocker.

Adaptations: retain Mission Control's repo-native commands, Lore commit rules, draft PR/human merge boundary and bounded repair budgets. Exhaustion leaves work blocked. Local Greptile CLI review and independent Codex review are required; Cubic is not required. Evidence remains outside Git, with before/after screenshots attached to UI PRs.

Implementation: `swarm/pre-review.sh` writes a local PASS receipt only for a clean, unchanged head/base. `swarm/pr_readiness.py check <PR URL>` queries GitHub checks and paginated review threads and requires that receipt for the same head/base. Missing checks, API errors, cancelled jobs, unresolved threads and requested changes block readiness. Receipts live under `$MC_HOME/swarm/pr-review-state`, never in a commit.

The completion webhook stores the PR deliverable but returns HTTP 409 and leaves the task in Testing until the gate passes. The monitor keeps observing completed agents after their sessions exit, repairs CI/review failures, and rechecks readiness before marking them ready. Retry exhaustion or an unavailable reviewer cannot fall through to success. Explicit local-only tasks and investigations preserve their existing workflow. Merged PRs are reconciled as already merged; this policy does not authorize merging.

Future agents receive these instructions on initial dispatch, change-request follow-ups and monitor-launched repair runs. Run the exact root commands from each repository's CI workflow before pushing. A push is permitted to start remote CI; a claim of readiness requires remote success on that head. Re-fetch the PR base and rerun independent review after changes to either head or base.

## Local Greptile prerequisite and gate

Install the official CLI on the Mission Control host (`npm install -g greptile`,
Node 22+) and sign in with `greptile login`. Verify access using `greptile whoami`
under the account that launches agents. Greptile must be on that process's PATH.
The CLI sends committed changes to Greptile; the repository must be enabled for
the signed-in organization. No new environment variable or repository dependency
is introduced; existing local Greptile authentication is used.

Before each push, `pre-review.sh` runs `greptile review --branch <base-sha> --json
--agent`, checks completed status for the same head and merge base, and then runs
Codex. Use a clean named branch; detached or dirty checkouts cannot pass. Each
review phase uses the existing `PRE_REVIEW_TIMEOUT_SECONDS` bound (default 900s).
Any Greptile finding blocks, even with a high confidence score. Fix, commit, and
rerun; unavailable authentication, malformed results, pending status and timeouts
also block. There is no automatic install, login, or push inside the gate.

Results live under `$MC_HOME/swarm/pr-review-state/greptile`, outside Git. The
combined PASS receipt embeds Greptile's completed result and commit identities;
older Codex-only receipts no longer satisfy readiness. Installed pre-review
symlinks load this code on the next invocation without a service restart.
