#!/usr/bin/env python3
"""Run the local Greptile CLI before delivery; never turn runner failure into PASS."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from pr_readiness import run


def capture(args, worktree, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Greptile review exceeded the review timeout")
    process = subprocess.Popen(args, cwd=worktree, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=remaining)
    except subprocess.TimeoutExpired as error:
        raise TimeoutError("Greptile review exceeded the review timeout") from error
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
    if process.returncode:
        raise RuntimeError(f"Greptile command failed (exit {process.returncode}): {stderr[-2000:]} {stdout[-2000:]}")
    return json.loads(stdout)


def validate(review, status, head, merge_base):
    if not isinstance(review, dict) or not isinstance(review.get("comments"), list):
        raise ValueError("Greptile did not return a findings array")
    if (not isinstance(status, dict) or status.get("status") != "COMPLETED"
            or status.get("headSha") != head or status.get("baseSha") != merge_base
            or not status.get("runId") or status.get("commentCount") != len(review["comments"])):
        raise ValueError("Greptile completion could not be verified for the reviewed head and merge base")


def review_branch(worktree, base, head, base_oid, output, timeout):
    def unchanged():
        if (run(["git", "rev-parse", "HEAD"], worktree) != head
                or run(["git", "rev-parse", base], worktree) != base_oid
                or run(["git", "status", "--porcelain"], worktree)):
            raise ValueError("Greptile requires a clean, unchanged head and base; commit and rerun review")

    output = Path(output)
    output.unlink(missing_ok=True)
    unchanged()
    # Greptile rejects detached HEAD. Do not silently change the agent's branch.
    run(["git", "symbolic-ref", "--quiet", "HEAD"], worktree)
    merge_base = run(["git", "merge-base", base_oid, head], worktree)
    deadline = time.monotonic() + timeout
    review = capture(["greptile", "review", "--branch", base_oid, "--json", "--agent"], worktree, deadline)
    status = capture(["greptile", "review", "status", "--commit", head, "--json", "--agent"], worktree, deadline)
    validate(review, status, head, merge_base)
    unchanged()
    payload = {"head": head, "base": base_oid, "mergeBase": merge_base,
               "runId": status["runId"], "status": "COMPLETED",
               "verdict": "FAIL" if review["comments"] else "PASS", "review": review}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    with open(temporary, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
        json.dump(payload, handle)
    temporary.replace(output)
    print(json.dumps(review, indent=2))
    print(f"Greptile evidence: {output}")
    if review["comments"]:
        print("Greptile found issues. Address the findings, commit, and rerun pre-review before pushing.")
        return 1
    print("Greptile review: PASS")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("worktree", "base", "head", "base_oid", "output"):
        parser.add_argument(name)
    parser.add_argument("--timeout", type=float, default=900)
    args = parser.parse_args()
    try:
        if not 0 < args.timeout <= 3600:
            raise ValueError("Review timeout must be greater than zero and at most 3600 seconds")
        sys.exit(review_branch(args.worktree, args.base, args.head, args.base_oid, args.output, args.timeout))
    except (OSError, ValueError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
        print(f"Greptile review unavailable: {error}", file=sys.stderr)
        print("Require greptile on PATH, an authenticated account (`greptile whoami`), and a named branch. Do not push without a completed review.", file=sys.stderr)
        sys.exit(2)
