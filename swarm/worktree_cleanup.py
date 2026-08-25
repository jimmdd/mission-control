#!/usr/bin/env python3
"""Safely release MC-managed worktrees whose linked ticket is done.

The ticket status is authoritative. A completed ticket first transitions its
registry entry to a terminal state so the monitor cannot respawn it. The local
branch is deliberately retained; only registered worktree checkouts are removed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from mc_api import headers_for


MAX_REGISTRY_ENTRIES = 500


def _run(args: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def fetch_task_status(mc_url: str, task_id: str) -> str | None:
    path = f"/api/tasks/{quote(task_id, safe='')}"
    request = Request(f"{mc_url.rstrip('/')}{path}", headers=headers_for("GET", path))
    try:
        with urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        return "deleted" if error.code == 404 else None
    except (URLError, TimeoutError, json.JSONDecodeError):
        return None
    status = payload.get("status") if isinstance(payload, dict) else None
    return status if isinstance(status, str) else None


def post_activity(mc_url: str, task_id: str, activity_type: str, message: str) -> None:
    payload = json.dumps({"activity_type": activity_type, "message": message}).encode("utf-8")
    request = Request(
        f"{mc_url.rstrip('/')}/api/tasks/{quote(task_id, safe='')}/activities",
        data=payload,
        headers=headers_for("POST", f"/api/tasks/{quote(task_id, safe='')}/activities", json_body=True),
        method="POST",
    )
    try:
        with urlopen(request, timeout=5):
            pass
    except (HTTPError, URLError, TimeoutError):
        pass


def session_exists(session: str) -> bool:
    if not session:
        return False
    return _run(["tmux", "has-session", "-t", session]).returncode == 0


def stop_session(session: str) -> bool:
    if not session:
        return True
    result = _run(["tmux", "kill-session", "-t", session])
    return result.returncode == 0 or not session_exists(session)


def _worktree_entries(repo: Path) -> list[Path]:
    result = _run(["git", "worktree", "list", "--porcelain"], cwd=repo)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or "git worktree list failed")
    paths: list[Path] = []
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            paths.append(Path(line.removeprefix("worktree ")).resolve())
    return paths


def _managed_path(repo: Path, worktree: Path) -> bool:
    expected_root = (repo.parent / "worktrees").resolve()
    return worktree != repo and worktree.parent == expected_root


def _dirty_reason(worktree: Path) -> str | None:
    result = _run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=worktree,
    )
    if result.returncode != 0:
        return "git_status_failed"
    if result.stdout.strip():
        return "dirty_worktree"
    return None


def _remove_registered_worktree(repo: Path, worktree: Path) -> tuple[bool, str]:
    if not _managed_path(repo, worktree):
        return False, "unmanaged_path"
    try:
        registered = _worktree_entries(repo)
    except RuntimeError:
        return False, "worktree_registry_unavailable"
    if worktree not in registered:
        return False, "unregistered_worktree"
    dirty = _dirty_reason(worktree)
    if dirty:
        return False, dirty

    # Ignored dependency/config files are disposable once a ticket is done. The
    # explicit clean check above protects tracked and ordinary untracked work;
    # --force is needed only because git otherwise refuses ignored files too.
    result = _run(["git", "worktree", "remove", "--force", str(worktree)], cwd=repo)
    if result.returncode != 0:
        return False, "git_worktree_remove_failed"
    return True, "removed"


def _state_command(state_tool: Path, registry: Path, *args: str) -> list[str]:
    state_dir = registry.parent
    return [
        sys.executable,
        str(state_tool),
        "--registry",
        str(registry),
        "--lock",
        str(state_dir / "active-tasks.lock"),
        "--events",
        str(state_dir / "events.jsonl"),
        *args,
    ]


def update_state(state_tool: Path, registry: Path, task_id: str, patch: dict[str, Any]) -> bool:
    result = _run(
        _state_command(
            state_tool,
            registry,
            "update",
            "--task-id",
            task_id,
            "--patch-json",
            json.dumps(patch),
            "--reason",
            "completed-worktree-cleanup",
        )
    )
    return result.returncode == 0


def remove_state(state_tool: Path, registry: Path, task_id: str) -> bool:
    result = _run(
        _state_command(
            state_tool,
            registry,
            "remove",
            "--task-id",
            task_id,
            "--reason",
            "completed-worktree-cleanup",
        )
    )
    return result.returncode == 0


def _planning_path(mc_task_id: str, repo: Path) -> Path:
    return (repo.parent / "worktrees" / f"planning-{mc_task_id[:8]}").resolve()


def _mark_preserved(
    state_tool: Path,
    registry: Path,
    entry: dict[str, Any],
    mc_url: str,
    mc_task_id: str,
    reason: str,
    activity_poster: Callable[[str, str, str, str], None],
) -> dict[str, str]:
    task_id = str(entry.get("id") or "")
    previous_reason = str(entry.get("cleanupBlocked") or "")
    if previous_reason != reason:
        update_state(state_tool, registry, task_id, {"cleanupBlocked": reason})
    if previous_reason != reason:
        activity_poster(
            mc_url,
            mc_task_id,
            "updated",
            f"Worktree cleanup deferred ({reason}); local files and branch were preserved.",
        )
    return {"task": task_id, "result": "preserved", "reason": reason}


def cleanup_completed_worktrees(
    registry: Path,
    state_tool: Path,
    mc_url: str,
    *,
    dry_run: bool = False,
    status_lookup: Callable[[str, str], str | None] = fetch_task_status,
    is_session_active: Callable[[str], bool] = session_exists,
    stop_active_session: Callable[[str], bool] = stop_session,
    activity_poster: Callable[[str, str, str, str], None] = post_activity,
) -> list[dict[str, str]]:
    if not registry.exists():
        return []
    try:
        entries = json.loads(registry.read_text())
    except (OSError, json.JSONDecodeError):
        return [{"task": "registry", "result": "blocked", "reason": "invalid_registry"}]
    if not isinstance(entries, list):
        return [{"task": "registry", "result": "blocked", "reason": "invalid_registry"}]

    results: list[dict[str, str]] = []
    for entry in entries[:MAX_REGISTRY_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        task_id = str(entry.get("id") or "")
        mc_task_id = str(entry.get("mcTaskId") or "")
        if not task_id or not mc_task_id:
            continue
        ticket_status = status_lookup(mc_url, mc_task_id)
        if ticket_status not in {"done", "deleted"}:
            continue
        cleanup_activity_poster = activity_poster if ticket_status == "done" else (lambda *_: None)

        repo_raw = str(entry.get("repo") or "")
        worktree_raw = str(entry.get("worktree") or "")
        session = str(entry.get("tmuxSession") or "")

        if dry_run:
            if not repo_raw or not worktree_raw:
                results.append({"task": task_id, "result": "dry_run", "reason": "missing_paths"})
                continue
            repo = Path(repo_raw).resolve()
            worktree = Path(worktree_raw).resolve()
            if not repo.is_dir() or not _managed_path(repo, worktree):
                results.append({"task": task_id, "result": "dry_run", "reason": "unmanaged_path"})
                continue
            reason = "would_stop_and_remove" if is_session_active(session) else "would_remove"
            if worktree.exists():
                try:
                    if worktree not in _worktree_entries(repo):
                        reason = "unregistered_worktree"
                    else:
                        reason = _dirty_reason(worktree) or reason
                except RuntimeError:
                    reason = "worktree_registry_unavailable"
            results.append({"task": task_id, "result": "dry_run", "reason": reason})
            continue

        # Mark terminal before touching tmux/filesystem. If this write fails, fail
        # closed: a still-running registry entry could otherwise be respawned.
        terminal_status = "deleted" if ticket_status == "deleted" else "done"
        if entry.get("status") != terminal_status:
            if not update_state(
                state_tool,
                registry,
                task_id,
                {"status": terminal_status},
            ):
                results.append({"task": task_id, "result": "blocked", "reason": "state_update_failed"})
                continue

        if is_session_active(session) and not stop_active_session(session):
            reason = "session_stop_failed"
            update_state(state_tool, registry, task_id, {"cleanupBlocked": reason})
            results.append({"task": task_id, "result": "blocked", "reason": reason})
            continue

        # A bad path must not keep a closed ticket's agent alive or eligible for
        # respawn. Stop it first, then preserve anything we cannot prove is an
        # MC-managed checkout.
        if not repo_raw or not worktree_raw:
            results.append(
                _mark_preserved(
                    state_tool, registry, entry, mc_url, mc_task_id,
                    "missing_paths", cleanup_activity_poster,
                )
            )
            continue
        repo = Path(repo_raw).resolve()
        worktree = Path(worktree_raw).resolve()
        if not repo.is_dir() or not _managed_path(repo, worktree):
            results.append(
                _mark_preserved(
                    state_tool, registry, entry, mc_url, mc_task_id,
                    "unmanaged_path", cleanup_activity_poster,
                )
            )
            continue

        blocked_reason: str | None = None
        if worktree.exists():
            removed, reason = _remove_registered_worktree(repo, worktree)
            if not removed:
                blocked_reason = reason

        planning = _planning_path(mc_task_id, repo)
        if not blocked_reason and planning.exists():
            removed, reason = _remove_registered_worktree(repo, planning)
            if not removed:
                blocked_reason = f"planning_{reason}"

        if blocked_reason:
            results.append(
                _mark_preserved(
                    state_tool, registry, entry, mc_url, mc_task_id,
                    blocked_reason, cleanup_activity_poster,
                )
            )
            continue

        if not remove_state(state_tool, registry, task_id):
            results.append({"task": task_id, "result": "blocked", "reason": "state_remove_failed"})
            continue
        if ticket_status == "done":
            activity_poster(
                mc_url,
                mc_task_id,
                "updated",
                f"Released completed task worktree for {task_id}; local branch {entry.get('branch') or '(unknown)'} was retained.",
            )
        results.append({
            "task": task_id,
            "result": "removed",
            "reason": "ticket_deleted" if ticket_status == "deleted" else "ticket_done",
        })
    return results


def main() -> int:
    mc_home = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=mc_home / "swarm" / "active-tasks.json")
    parser.add_argument("--state-tool", type=Path, default=mc_home / "swarm" / "swarm-state.py")
    parser.add_argument("--mc-url", default=os.environ.get("MISSION_CONTROL_URL", "http://localhost:18900"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    results = cleanup_completed_worktrees(
        args.registry,
        args.state_tool,
        args.mc_url,
        dry_run=args.dry_run,
    )
    for result in results:
        print(json.dumps(result, sort_keys=True))
    return 1 if any(result["result"] == "blocked" for result in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
