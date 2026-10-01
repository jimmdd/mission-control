"""Shared evidence-storage instruction for Mission Control agent prompts."""

from pathlib import Path

EVIDENCE_POLICY = """
## Review evidence storage (user policy — applies to every task)

- Keep all task-specific review proof out of Git, including branch history: screenshots, recordings, traces, test output, Markdown reports, manifests, validation notes, and evidence indexes. Capture them outside the checkout or in a locally ignored evidence directory; inspect the staged diff before committing.
- Upload selected before/after images and videos as PR attachments (GitHub UI or `gh pr comment --attach` / `gh pr edit --attach` when supported; if installed, `~/.mission-control/bin/gh-attachments` provides attachment-capable CLI without replacing the system `gh`). Store complete test output and traces as CI artifacts or approved artifact storage; record retention/expiry where applicable. No-PR/local-only tasks must keep evidence local unless publishing is separately authorized.
- Put only evidence genuinely needed for review in the PR description or comments, with before/after pairs side by side. Keep concise validation results, tested commit, scenario/viewport, and necessary artifact links there; do not create versioned proof reports or indexes. Verify uploaded links before removing local copies. Keep redundant output local or in CI artifacts.
- This excludes required product assets and intentional test fixtures/baselines, executable regression tests, and durable product documentation: keep those versioned normally. A shipped team headshot is a product asset, not review evidence.
- Before finishing, inspect the whole PR diff for accidental generated proof files. Move any to attachments/artifacts. If already committed, clean only task-owned branch history with a backup and an exact force-with-lease check, coordinating with other writers; never rewrite a shared/default branch. Preserve all source changes and existing ticket constraints, including CI/lint gates and MET-725's no-database-change rule.
"""

# Adapted from oh-my-openagent's work-with-pr and review-work guidelines.
# Keep repo-specific commands, branch targets, merge authority and resource limits.
EVIDENCE_POLICY += """
## PR delivery gate (applies to every initial run and follow-up)

A pushed branch or PR URL is progress, not a completed deliverable.
1. Read the repository's CI workflow and run the exact applicable root commands,
   including formatting, lint, types, tests and build. A narrower app check does
   not replace a root CI check. Fix failures; never weaken or skip a gate to pass.
2. For behavior changes, exercise the real CLI/API/browser surface and preserve
   sanitized evidence locally. UI PRs need before/after screenshots in the PR.
   Close task-created browser tabs, contexts and processes in finally cleanup.
3. Commit the final changes using the repository's commit convention. Run the
   independent pre-review.sh on a clean named branch against the current PR base,
   before every push. It runs local Greptile CLI review followed by Codex review.
   Greptile findings must be addressed and reviewed again; a confidence score is
   not approval. Missing CLI/authentication, invalid output and timeouts block.
   Require an explicit PASS; unavailable review, WARN, or exhausted repair rounds
   are blocked states, never approval. A new commit/base invalidates that review.
4. Push and create/update the task's existing PR, draft by default. Read CI and
   reviewer feedback for the CURRENT head. Fix failures and actionable findings,
   re-run affected local checks and real-surface QA, commit, re-review and push.
   Keep cycling while meaningful progress is possible. If a runtime retry limit
   or external blocker stops repair, report the concrete blocker and leave the
   task incomplete. Resolve addressed review threads with evidence, not blindly.
5. After push, verify that checks have appeared and all applicable checks finish
   successfully. Empty/pending/cancelled/unknown checks and GitHub lookup errors
   are not success. Re-check the head SHA after waiting. Report completion only
   after current-head CI AND independent review pass with no unresolved threads.
   The completion endpoint enforces this; HTTP 409 means continue fixing/waiting,
   not success. Keep the ticket in Testing until the delivery gate passes.
6. Keep PR descriptions reviewer-readable: problem, final behavior, exact tested
   commit and commands, QA evidence, remaining blockers and rollout prerequisites.
   Do not mark ready, merge, auto-merge, deploy, or override branch protection
   beyond the user's authorization. No-PR tasks remain local and never publish.

Reference: https://github.com/code-yeongyu/oh-my-openagent/blob/dev/.agents/skills/work-with-pr/SKILL.md
Adaptation: local Greptile plus independent Codex replace upstream's repo-specific Cubic gate;
human merge policy and existing retry budgets remain in force without false PASS.
"""
EVIDENCE_POLICY += f'\nIndependent review runner: `bash {Path(__file__).with_name("pre-review.sh")} "$(pwd)" "${{BASE_BRANCH:-origin/master}}"`. Fetch the PR base before reviewing.\n'
