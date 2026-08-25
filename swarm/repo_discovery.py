"""Dependency-free repository discovery shared by watcher tests and runtime."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def discover_repo_paths(root: Path, allow: set[str] | None = None) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    allowed = allow or set()
    candidates: list[tuple[str, Path]] = []
    for first in sorted(root.iterdir()):
        if not first.is_dir() or first.name == "worktrees":
            continue
        if (first / ".git").exists():
            candidates.append((root.name, first))
            continue
        for second in sorted(first.iterdir()):
            if second.is_dir() and (second / ".git").exists():
                candidates.append((first.name, second))

    repos: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for project, repo_dir in candidates:
        try:
            identity = repo_dir.resolve()
        except OSError:
            identity = repo_dir
        if identity in seen:
            continue
        seen.add(identity)
        domain = f"{project}/{repo_dir.name}"
        if allowed and domain not in allowed:
            continue
        repos.append({
            "project": project,
            "repo": repo_dir.name,
            "path": repo_dir,
            "domain": domain,
        })
    return repos
