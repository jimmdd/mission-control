"""Serialize launches and reconcile acknowledged attempts before retrying them."""

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path


class LaunchPending(RuntimeError):
    """A matching pane exists but has not acknowledged this attempt yet."""


def find_launch(swarm: Path, task_id: str, mc_task_id: str, repo: str, branch: str):
    registry = swarm / "active-tasks.json"
    entries = json.loads(registry.read_text()) if registry.exists() else []
    entry = next((e for e in entries if e.get("id") == task_id), None)
    if not entry or entry.get("status") not in ("running", "completed_by_agent"):
        return None
    matches = (entry.get("mcTaskId", "") == mc_task_id
               and Path(entry.get("repo", "")).resolve() == Path(repo).resolve()
               and entry.get("branch") == branch)
    session = entry.get("tmuxSession")
    if not session:
        return None
    result = subprocess.run(
        ["tmux", "list-panes", "-t", f"={session}", "-F", "#{pane_dead}"],
        capture_output=True, text=True, timeout=5,
    )
    alive = result.returncode == 0 and "0" in result.stdout.splitlines()
    if alive and not matches:
        raise RuntimeError(f"Live session {session} belongs to a different execution target")
    if alive and entry.get("launchAttemptId") and not entry.get("launchAcknowledgedAt"):
        raise LaunchPending(f"Waiting for {session} to acknowledge startup")
    if matches and (alive or (entry.get("launchAcknowledgedAt")
                             and entry.get("status") == "completed_by_agent"
                             and not entry.get("completionSyncedAt"))):
        return entry
    return None


def wait_for_ack(swarm: Path, task_id: str, attempt: str, timeout: float):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        entries = json.loads((swarm / "active-tasks.json").read_text())
        entry = next((e for e in entries if e.get("id") == task_id), {})
        if entry.get("launchAttemptId") != attempt:
            raise RuntimeError("Launch attempt was replaced before acknowledgement")
        if entry.get("status") == "failed":
            raise RuntimeError("Agent failed during startup")
        if entry.get("launchAcknowledgedAt"):
            return
        time.sleep(0.1)
    raise RuntimeError("Agent did not acknowledge startup before the deadline")


def main():
    swarm = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control"))) / "swarm"
    command, *args = sys.argv[1:]
    if command == "lock":
        script, task_id, *rest = args
        locks = swarm / "launch-locks"
        locks.mkdir(parents=True, exist_ok=True)
        # The open descriptor survives exec, including a timeout which kills the
        # parent while a setup subprocess still owns the launch. tmux closes it
        # explicitly so the detached agent does not keep the launch lock forever.
        import hashlib
        lock = (locks / (hashlib.sha256(task_id.encode()).hexdigest() + ".lock")).open("a+")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 3
        os.set_inheritable(lock.fileno(), True)
        env = {**os.environ, "MC_LAUNCH_LOCK": task_id, "MC_LAUNCH_LOCK_FD": str(lock.fileno())}
        os.execve("/bin/bash", ["bash", script, task_id, *rest], env)
    elif command == "find":
        entry = find_launch(swarm, *args)
        if entry:
            print(json.dumps(entry))
            return 0
        return 1
    elif command == "wait":
        wait_for_ack(swarm, args[0], args[1], float(args[2]))
    elif command == "exec":
        launcher, task_id = args
        patch = json.dumps({"launchAcknowledgedAt": int(time.time() * 1000), "launchState": "acknowledged"})
        subprocess.run([
            sys.executable, str(swarm / "swarm-state.py"), "update",
            "--task-id", task_id, "--attempt-id", os.environ["MC_LAUNCH_ATTEMPT"],
            "--patch-json", patch, "--reason", "launcher-acknowledged",
        ], check=True, timeout=10)
        os.execv(launcher, [launcher, task_id])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except LaunchPending as e:
        print(str(e), file=sys.stderr)
        sys.exit(3)
    except Exception as e:
        print(f"launch state: {e}", file=sys.stderr)
        sys.exit(2)
