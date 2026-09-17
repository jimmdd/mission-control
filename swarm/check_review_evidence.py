#!/usr/bin/env python3
"""Reject generated review evidence in a task diff or its unmerged history."""
import re
import subprocess
import sys
from pathlib import PurePosixPath


def is_review_evidence(path: str) -> bool:
    parts = PurePosixPath(path).parts
    # Required app assets and intentional test fixtures/baselines are unaffected.
    if any(part in {"test-results", "playwright-report", ".codex-evidence"} for part in parts[:-1]):
        return True
    proof_dir = any(part in {"evidence", "proof", "proofs"} or part.endswith(("-proof", "-proofs", "-evidence")) for part in parts[:-1])
    generated_area = bool(parts and (parts[0] in {".planning", ".omx", "evidence", "proof", "proofs"} or "docs" in parts[:-1]))
    ticket_report = bool(re.fullmatch(r"[a-z]+-\d+-(?:.*-)?(?:proof|evidence|validation|review|test-report|manifest|fix-list)\.(?:md|txt|json|html)", PurePosixPath(path).name, re.IGNORECASE))
    return generated_area and (proof_dir or ticket_report)


def check(worktree: str, base: str) -> list[str]:
    def git(*args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=worktree, text=True)
    history = git("log", "--format=", "--name-only", "-z", "--diff-filter=AM", f"{base}..HEAD")
    current = git("diff", "--name-only", "-z", "--diff-filter=ACMR", base, "--")
    return sorted({p for p in re.split(r"\x00|\n", history + "\x00" + current) if is_review_evidence(p)})


if __name__ == "__main__":
    try:
        files = check(sys.argv[1], sys.argv[2])
    except (IndexError, OSError, subprocess.CalledProcessError) as exc:
        print(f"Evidence gate could not inspect Git history: {exc}", file=sys.stderr)
        sys.exit(2)
    if files:
        print("VERDICT: FAIL — generated review evidence must be outside Git (including branch history).")
        print("\n".join(f"- {path}" for path in files))
        print("Attachment CLI, when installed: ~/.mission-control/bin/gh-attachments pr comment --attach <file>")
        print("Put only necessary evidence and validation notes in the PR description/comments, not versioned reports or indexes.")
        print("Use attachments or CI/artifact storage; preserve product assets, executable tests, and intentional fixtures.")
        print("If no PR exists, keep local backups, clean task-owned history, open the PR, then attach proofs.")
        print("Coordinate with other writers; back up first and use exact force-with-lease for a published task branch.")
        sys.exit(1)
