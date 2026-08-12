"""Run a staged planning job out of process, and leave the verdict on disk.

`stage_planning` used to call `plan_in_worktree` inline, inside the daemon's single
poll loop. Planning takes tens of minutes, so the whole bridge stopped for the
duration: no question servicing, no step dispatch, no review handling, no
escalations. One task's planning froze every other task on the machine.

So it runs here instead, as its own process, and writes `<task>.job.json` when it
finishes. The bridge starts one, returns immediately, and reads the verdict on a
later tick. A separate process rather than a thread because the daemon restarts:
a thread dies silently with it, while a process leaves a pid the next daemon can
check and a verdict file it can still pick up.

Usage: plan_stage_runner.py <job-file>

The job file carries its own input, so the caller does not have to quote a prompt
through a shell:

    {"task": {...}, "worktree": "...", "context": "...", "model": ""}
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print("usage: plan_stage_runner.py <job-file>", file=sys.stderr)
        return 2

    job_path = Path(argv[0])
    try:
        job = json.loads(job_path.read_text())
    except (OSError, ValueError) as e:
        print(f"could not read job {job_path}: {e}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    from plan_stage import plan_in_worktree

    try:
        verdict = plan_in_worktree(
            job["worktree"], job["task"],
            context=job.get("context", ""), model=job.get("model", ""),
        )
    except Exception as e:                      # noqa: BLE001 — the verdict must land
        logging.exception("planning job failed")
        verdict = {"outcome": "error", "plan_path": None, "questions": [],
                   "reason": f"planning job crashed: {e}", "duration_s": 0,
                   "transcript_path": "", "gsd_ran": False, "stages": []}

    # Written last and atomically: the bridge treats the presence of `verdict` as
    # "finished", so a half-written file must never look complete.
    job["verdict"] = verdict
    job["state"] = "done"
    tmp = job_path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(job))
        os.replace(tmp, job_path)
    except OSError as e:
        print(f"could not write verdict: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
