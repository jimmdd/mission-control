#!/usr/bin/env python3
"""Locked state manager for swarm task registry."""

import argparse
import fcntl
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    dir_fd = os.open(str(path.parent), os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _append_event(events_file: Path, event: Dict[str, Any]) -> None:
    events_file.parent.mkdir(parents=True, exist_ok=True)
    event["at"] = datetime.now(timezone.utc).isoformat()
    with events_file.open("a") as f:
        f.write(json.dumps(event) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _with_lock(lock_file: Path):
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    fd = lock_file.open("a+")
    fcntl.flock(fd.fileno(), fcntl.LOCK_EX)
    return fd


def _find_task(tasks: List[Dict[str, Any]], task_id: str) -> Dict[str, Any]:
    for task in tasks:
        if task.get("id") == task_id:
            return task
    return {}


def cmd_upsert(args: argparse.Namespace) -> int:
    registry = Path(args.registry)
    lock = Path(args.lock)
    events = Path(args.events)
    task_obj = json.loads(args.task_json)
    task_id = task_obj.get("id")
    if not task_id:
        print("task_json must include id", file=sys.stderr)
        return 2

    fd = _with_lock(lock)
    try:
        tasks = _read_json(registry, [])
        if not isinstance(tasks, list):
            tasks = []
        replaced = False
        for i, task in enumerate(tasks):
            if task.get("id") == task_id:
                tasks[i] = task_obj
                replaced = True
                break
        if not replaced:
            tasks.append(task_obj)
        _atomic_write_json(registry, tasks)
        _append_event(
            events,
            {
                "type": "task_upsert",
                "taskId": task_id,
                "action": "replace" if replaced else "create",
                "status": task_obj.get("status", ""),
            },
        )
        return 0
    finally:
        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
        fd.close()


def cmd_update(args: argparse.Namespace) -> int:
    registry = Path(args.registry)
    lock = Path(args.lock)
    events = Path(args.events)
    patch = json.loads(args.patch_json)
    task_id = args.task_id

    fd = _with_lock(lock)
    try:
        tasks = _read_json(registry, [])
        if not isinstance(tasks, list):
            tasks = []
        target = _find_task(tasks, task_id)
        if not target:
            print(f"task not found: {task_id}", file=sys.stderr)
            return 1
        target.update(patch)
        _atomic_write_json(registry, tasks)
        _append_event(
            events,
            {
                "type": "task_update",
                "taskId": task_id,
                "patch": patch,
                "reason": args.reason or "",
            },
        )
        return 0
    finally:
        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
        fd.close()


def cmd_remove(args: argparse.Namespace) -> int:
    registry = Path(args.registry)
    lock = Path(args.lock)
    events = Path(args.events)
    task_id = args.task_id

    fd = _with_lock(lock)
    try:
        tasks = _read_json(registry, [])
        if not isinstance(tasks, list):
            tasks = []
        original_len = len(tasks)
        tasks = [task for task in tasks if task.get("id") != task_id]
        if len(tasks) == original_len:
            return 1
        _atomic_write_json(registry, tasks)
        _append_event(
            events,
            {"type": "task_remove", "taskId": task_id, "reason": args.reason or ""},
        )
        return 0
    finally:
        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
        fd.close()


def cmd_snapshot_create(args: argparse.Namespace) -> int:
    registry = Path(args.registry)
    events = Path(args.events)
    snapshot_dir = Path(args.snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    snapshot = snapshot_dir / f"snapshot-{stamp}.json"
    payload = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "registry": _read_json(registry, []),
        "eventsTail": [],
    }
    if events.exists():
        tail_lines = events.read_text().splitlines()[-200:]
        parsed = []
        for line in tail_lines:
            try:
                parsed.append(json.loads(line))
            except Exception:
                continue
        payload["eventsTail"] = parsed
    _atomic_write_json(snapshot, payload)
    print(str(snapshot))
    return 0


def cmd_snapshot_list(args: argparse.Namespace) -> int:
    snapshot_dir = Path(args.snapshot_dir)
    if not snapshot_dir.exists():
        return 0
    for path in sorted(snapshot_dir.glob("snapshot-*.json"), reverse=True):
        print(str(path))
    return 0


def cmd_snapshot_restore(args: argparse.Namespace) -> int:
    registry = Path(args.registry)
    lock = Path(args.lock)
    events = Path(args.events)
    snapshot = Path(args.snapshot_file)
    payload = _read_json(snapshot, {})
    reg = payload.get("registry")
    if not isinstance(reg, list):
        print("invalid snapshot: missing registry[]", file=sys.stderr)
        return 2

    fd = _with_lock(lock)
    try:
        _atomic_write_json(registry, reg)
        _append_event(
            events,
            {
                "type": "snapshot_restore",
                "snapshot": str(snapshot),
                "reason": args.reason or "manual",
            },
        )
        return 0
    finally:
        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
        fd.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Swarm registry state helper")
    parser.add_argument("--registry", default=str(Path.home() / ".openclaw" / "swarm" / "active-tasks.json"))
    parser.add_argument("--lock", default=str(Path.home() / ".openclaw" / "swarm" / "active-tasks.lock"))
    parser.add_argument("--events", default=str(Path.home() / ".openclaw" / "swarm" / "events.jsonl"))
    parser.add_argument("--snapshot-dir", default=str(Path.home() / ".openclaw" / "swarm" / "state-snapshots"))

    sub = parser.add_subparsers(dest="command", required=True)

    upsert = sub.add_parser("upsert")
    upsert.add_argument("--task-json", required=True)
    upsert.set_defaults(func=cmd_upsert)

    update = sub.add_parser("update")
    update.add_argument("--task-id", required=True)
    update.add_argument("--patch-json", required=True)
    update.add_argument("--reason", default="")
    update.set_defaults(func=cmd_update)

    remove = sub.add_parser("remove")
    remove.add_argument("--task-id", required=True)
    remove.add_argument("--reason", default="")
    remove.set_defaults(func=cmd_remove)

    snap_create = sub.add_parser("snapshot-create")
    snap_create.set_defaults(func=cmd_snapshot_create)

    snap_list = sub.add_parser("snapshot-list")
    snap_list.set_defaults(func=cmd_snapshot_list)

    snap_restore = sub.add_parser("snapshot-restore")
    snap_restore.add_argument("--snapshot-file", required=True)
    snap_restore.add_argument("--reason", default="")
    snap_restore.set_defaults(func=cmd_snapshot_restore)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
