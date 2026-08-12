"""GSD backend integration helpers for Mission Control swarm prompts.

The current supported backend is GSD Core. Keep all command spellings here so
future gsd-pi support can be added without rewriting planner/bridge prompts.

Spelling matters more than it looks. GSD ships its workflows as skills named
`gsd-plan-phase` (hyphen) in ~/.claude/skills; the older `/gsd:plan-phase` colon
form resolves to nothing. A prompt citing a command that does not exist produces
no error — the agent simply ignores that section and works from the prose around
it. That is exactly what happened: agents ran as plain sessions with no GSD
decomposition, no .planning/ artifacts, and no per-task automated checks, while
the logs looked healthy.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional, Tuple


SUPPORTED_BACKENDS = {"core", "pi"}
DEFAULT_BACKEND = "core"


def get_gsd_backend() -> str:
    backend = os.environ.get("MISSION_CONTROL_GSD_BACKEND", DEFAULT_BACKEND).strip().lower()
    return backend or DEFAULT_BACKEND


def ensure_supported_backend() -> str:
    backend = get_gsd_backend()
    if backend not in SUPPORTED_BACKENDS:
        supported = ", ".join(sorted(SUPPORTED_BACKENDS))
        raise ValueError(
            f"Unsupported MISSION_CONTROL_GSD_BACKEND={backend!r}. "
            f"Supported backends: {supported}."
        )
    if backend == "pi":
        raise NotImplementedError(
            "MISSION_CONTROL_GSD_BACKEND=pi is reserved for the gsd-pi adapter. "
            "The adapter must parse .gsd state and Pi headless status before it can be enabled."
        )
    return backend


def plan_command(greenfield: bool = False) -> str:
    ensure_supported_backend()
    if greenfield:
        return "/gsd-new-project --auto"
    return "/gsd-plan-phase --prd"


def gap_plan_command() -> str:
    ensure_supported_backend()
    return "/gsd-plan-phase --gaps"


def execute_command() -> str:
    ensure_supported_backend()
    return "/gsd-execute-phase"


def verify_command() -> str:
    ensure_supported_backend()
    return "/gsd-verify-work"


def planning_dir_name() -> str:
    ensure_supported_backend()
    return ".planning"


def _tools_path() -> Optional[str]:
    """Locate gsd-tools.cjs — the deterministic half of GSD.

    The workflows themselves are prompts an agent runs, but gsd-tools reports project
    state as JSON without a model in the loop. That is what lets us check whether a
    workflow actually ran instead of trusting that it did.
    """
    candidates = [
        os.environ.get("GSD_TOOLS_PATH", ""),
        str(Path(__file__).resolve().parent.parent
            / "node_modules/@opengsd/gsd-core/gsd-core/bin/gsd-tools.cjs"),
        str(Path.home() / ".claude/gsd-core/bin/gsd-tools.cjs"),
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    found = shutil.which("gsd-tools") or shutil.which("gsd_run")
    return found


def project_progress(cwd: str) -> Optional[dict]:
    """GSD's own view of a project: phases, plans, summaries. None if unavailable."""
    tools = _tools_path()
    if not tools:
        logging.debug("  gsd-tools not found — cannot read GSD project state")
        return None
    cmd = ([tools] if not tools.endswith(".cjs") else ["node", tools]) + \
        ["progress", "--cwd", cwd, "--json-errors"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        logging.debug(f"  gsd-tools progress failed: {e}")
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def workflow_ran(cwd: str) -> Tuple[bool, str]:
    """Did the GSD workflow actually run in this worktree?

    Asking an agent to run a workflow is a request, not a guarantee — and a prompt that
    names a command which does not resolve fails silently, leaving a session that looks
    healthy and produced no plan. This turns that into an observable fact.

    Returns (ran, reason). Unavailable tooling counts as "ran" so a missing gsd-tools
    never blocks a task; the check exists to catch silence, not to gate on itself.
    """
    planning = Path(cwd) / planning_dir_name()
    if not planning.is_dir():
        return False, f"no {planning_dir_name()}/ — the GSD workflow never ran"

    progress = project_progress(cwd)
    if progress is None:
        # Directory exists and we cannot inspect further: take the evidence we have.
        return True, "planning directory present (gsd-tools unavailable for detail)"

    plans = progress.get("total_plans") or 0
    phases = progress.get("phases") or []
    if not plans and not phases:
        return False, "GSD reports 0 plans and 0 phases — planning produced nothing"
    return True, f"{plans} plan(s) across {len(phases)} phase(s)"


def backend_label() -> str:
    ensure_supported_backend()
    return "GSD Core"
