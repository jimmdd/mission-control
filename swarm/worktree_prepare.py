#!/usr/bin/env python3
"""Create a task worktree without discarding recoverable work from prior attempts."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def _git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return (result.stdout or "").strip()


def _branch_exists(repo: Path, branch: str) -> bool:
    return subprocess.run(
        ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
        capture_output=True,
    ).returncode == 0


def _worktrees(repo: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in _git(repo, "worktree", "list", "--porcelain").splitlines() + [""]:
        if not line:
            if current:
                entries.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value
    return entries


def _progress(repo: Path, worktree: Path | None, branch: str, base_ref: str) -> tuple[int, int]:
    # Fail closed if the base cannot be resolved. Treating that as zero commits
    # could delete the very branch this recovery guard exists to preserve.
    ahead_raw = _git(repo, "rev-list", "--count", f"{base_ref}..{branch}")
    if not ahead_raw.isdigit():
        raise RuntimeError(f"could not measure commits between {base_ref} and {branch}")
    ahead = int(ahead_raw)
    dirty = 0
    if worktree and worktree.exists():
        dirty = len([line for line in _git(worktree, "status", "--porcelain").splitlines() if line])
    return ahead, dirty


def prepare_worktree(repo_path: str, desired_path: str, branch: str, base_ref: str) -> dict:
    """Create a clean worktree, or reuse the branch holder when it has partial work."""
    repo = Path(repo_path).resolve()
    desired = Path(desired_path).resolve()
    if not repo.is_dir():
        raise RuntimeError(f"repository does not exist: {repo}")

    _git(repo, "worktree", "prune", check=False)
    branch_ref = f"refs/heads/{branch}"
    holder: Path | None = None
    for entry in _worktrees(repo):
        if entry.get("branch") == branch_ref and entry.get("worktree"):
            holder = Path(entry["worktree"]).resolve()
            break

    if holder:
        if holder == repo:
            raise RuntimeError(f"{branch} is checked out in the main clone; switch branches before dispatch")
        ahead, dirty = _progress(repo, holder, branch, base_ref)
        if ahead or dirty:
            return {
                "path": str(holder),
                "reused": True,
                "ahead": ahead,
                "dirty": dirty,
                "reason": "partial_work_preserved",
            }
        _git(repo, "worktree", "remove", "--force", str(holder))

    branch_exists = _branch_exists(repo, branch)
    if branch_exists:
        ahead, _ = _progress(repo, None, branch, base_ref)
        if ahead:
            if desired.exists():
                raise RuntimeError(f"refusing to overwrite existing path: {desired}")
            desired.parent.mkdir(parents=True, exist_ok=True)
            _git(repo, "worktree", "add", str(desired), branch)
            return {
                "path": str(desired),
                "reused": True,
                "ahead": ahead,
                "dirty": 0,
                "reason": "commits_preserved",
            }
        _git(repo, "branch", "-D", branch)

    if desired.exists():
        raise RuntimeError(f"refusing to overwrite existing path: {desired}")
    desired.parent.mkdir(parents=True, exist_ok=True)
    _git(repo, "worktree", "add", str(desired), "-b", branch, base_ref)
    return {"path": str(desired), "reused": False, "ahead": 0, "dirty": 0, "reason": "created"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--base", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare_worktree(args.repo, args.worktree, args.branch, args.base)))
