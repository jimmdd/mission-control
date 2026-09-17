"""Shared evidence-storage instruction for Mission Control agent prompts."""

EVIDENCE_POLICY = """
## Review evidence storage (user policy — applies to every task)

- Keep generated review screenshots, recordings, traces, and bulky test reports out of Git, including branch history. Capture them outside the checkout or in a locally ignored evidence directory; inspect the staged diff before committing.
- Upload selected before/after images and videos as PR attachments (GitHub UI or `gh pr comment --attach` / `gh pr edit --attach` when supported). Store complete test output and traces as CI artifacts or approved artifact storage; record retention/expiry where applicable. No-PR/local-only tasks must keep evidence local unless publishing is separately authorized.
- Keep concise text validation notes and an evidence index in Git. Link the PR/CI artifacts, identify the tested commit and scenario/viewport, and verify uploaded links before removing local copies. Never replace a working proof link with an inaccessible local path.
- This excludes required product assets and intentional test fixtures/baselines: keep those versioned normally. A shipped team headshot is a product asset, not review evidence.
- Before finishing, inspect the whole PR diff for accidental generated proof files. Move any to attachments/artifacts. If already committed, clean only task-owned branch history with a backup and an exact force-with-lease check, coordinating with other writers; never rewrite a shared/default branch. Preserve all source changes and existing ticket constraints, including CI/lint gates and MET-725's no-database-change rule.
"""
