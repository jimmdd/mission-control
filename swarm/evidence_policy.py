"""Shared evidence-storage instruction for Mission Control agent prompts."""

EVIDENCE_POLICY = """
## Review evidence storage (user policy — applies to every task)

- Keep all task-specific review proof out of Git, including branch history: screenshots, recordings, traces, test output, Markdown reports, manifests, validation notes, and evidence indexes. Capture them outside the checkout or in a locally ignored evidence directory; inspect the staged diff before committing.
- Upload selected before/after images and videos as PR attachments (GitHub UI or `gh pr comment --attach` / `gh pr edit --attach` when supported; if installed, `~/.mission-control/bin/gh-attachments` provides attachment-capable CLI without replacing the system `gh`). Store complete test output and traces as CI artifacts or approved artifact storage; record retention/expiry where applicable. No-PR/local-only tasks must keep evidence local unless publishing is separately authorized.
- Put only evidence genuinely needed for review in the PR description or comments, with before/after pairs side by side. Keep concise validation results, tested commit, scenario/viewport, and necessary artifact links there; do not create versioned proof reports or indexes. Verify uploaded links before removing local copies. Keep redundant output local or in CI artifacts.
- This excludes required product assets and intentional test fixtures/baselines, executable regression tests, and durable product documentation: keep those versioned normally. A shipped team headshot is a product asset, not review evidence.
- Before finishing, inspect the whole PR diff for accidental generated proof files. Move any to attachments/artifacts. If already committed, clean only task-owned branch history with a backup and an exact force-with-lease check, coordinating with other writers; never rewrite a shared/default branch. Preserve all source changes and existing ticket constraints, including CI/lint gates and MET-725's no-database-change rule.
"""
