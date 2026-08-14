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


# How much GSD to run for a plan. `/gsd-plan-phase` is built to plan a phase of a
# project: on MET-635 it ran ~20 gate steps itself — threat model, Nyquist
# artifacts, API-surface regeneration — before delegating, and took 38 minutes with
# 1,209 orchestrator turns. Most tickets are not a project phase, and GSD ships
# lighter doors for them. Measured per ticket rather than assumed.
PLAN_MODES = {
    # `--prd` used to be passed here with no filepath, which is a no-op that reads
    # as a feature. plan-phase.md:71 only sets PRD_PARAM when the flag is followed
    # by a non-flag token — `--prd` alone matches nothing, so the express path
    # never fired and the run fell through to step 4, "Load CONTEXT.md", whose
    # empty branch calls `AskUserQuestion`. That tool does not exist under
    # `claude -p` (verified: 163 tools offered on the MET-635 run, not one of them
    # it), so the gate did not stall — the agent chose for itself, silently. The
    # path is supplied at call time now, and only when there is a file behind it.
    "phase": "/gsd-plan-phase",         # full: multi-phase work
    "quick": "/gsd-quick --validate",   # GSD guarantees, optional agents skipped
    "mvp": "/gsd-mvp-phase",            # vertical slice, then plan-phase
}

# Nothing may put GSD into a discussion. Its discussion is AskUserQuestion, there
# is no such tool in our runtime, and the failure is silent — the workflow's own
# fallback ("--text") only turns it into a numbered list printed to a transcript
# nobody is reading. Questions are asked through the ticket or not at all.
FORBIDDEN_FLAGS = ("--discuss",)
# Quick by default: measured against the full path on MET-635 it produced the same
# 19-task decomposition in 155 turns instead of 1,365, and 7.4M context tokens
# instead of 237M. The full phase workflow is for work that genuinely spans phases,
# and a ticket can ask for it.
DEFAULT_PLAN_MODE = "quick"


def plan_mode(requested: str = "") -> str:
    """Which door to use. A ticket's own choice outranks the machine's default.

    Precedence: what the ticket asks for, then the environment, then the default.
    An unrecognised value falls back rather than failing — a typo on a ticket must
    not stop it being planned.
    """
    for candidate in (requested, os.environ.get("MC_GSD_PLAN_MODE", ""), DEFAULT_PLAN_MODE):
        mode = (candidate or "").strip().lower()
        if mode in PLAN_MODES:
            return mode
    return DEFAULT_PLAN_MODE


def plan_command(greenfield: bool = False, mode: str = "", brief: str = "") -> str:
    """The door, plus the brief when there is one and the door reads one.

    Only `plan-phase` has a PRD express path. `quick` names its context file after
    an id it generates mid-run (`quick.md:311`), so there is no path to hand it
    ahead of time — and it needs none: its single `AskUserQuestion` fires only when
    the description is empty, and we always supply one.
    """
    ensure_supported_backend()
    if greenfield:
        return "/gsd-new-project --auto"
    command = PLAN_MODES[plan_mode(mode)]
    if brief and command.startswith("/gsd-plan-phase"):
        command = f"{command} --prd {brief}"
    assert not any(f in command for f in FORBIDDEN_FLAGS), f"GSD cannot discuss headlessly: {command}"
    return command


def planning_roots(cwd: str) -> list:
    """Every directory GSD might have put `.planning/` in, for this checkout.

    GSD resolves the project root through `git rev-parse --git-common-dir`, so in a
    linked worktree it writes to the *main* checkout and shares one `.planning/`
    across worktrees. Its own words, from the run that caught this:

        "GSD's worktree-safety deliberately resolves the project root to the main
        checkout, so planning artifacts are shared across worktrees. `--cwd`
        doesn't override it."

    But it does not always do that — MET-635's plan landed inside the worktree, the
    demo ticket's in the main checkout, same command. So the placement is a runtime
    judgement rather than a rule, and looking in only one place is wrong half the
    time. MC reported `prerequisite_missing` on a run that had just written a
    complete GSD project, because it checked the worktree and GSD had used the
    checkout above it.

    Worktree first: when both exist, this run's own tree is the more specific
    answer.
    """
    roots = [Path(cwd)]
    try:
        out = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=cwd,
                             capture_output=True, text=True, timeout=10)
        if out.returncode == 0:
            common = Path(out.stdout.strip())
            if not common.is_absolute():
                common = Path(cwd) / common
            # `<main checkout>/.git` → the checkout is its parent.
            main = common.parent.resolve()
            if main != Path(cwd).resolve():
                roots.append(main)
    except (OSError, subprocess.SubprocessError):
        pass
    return roots


def project_initialised(cwd: str) -> bool:
    """Does this repo already have a GSD project to plan a phase into?"""
    return any((r / planning_dir_name()).is_dir() for r in planning_roots(cwd))


def init_command() -> str:
    """Create the GSD project a phase plan needs to land in.

    `/gsd-plan-phase` cannot plan into a repo with no `.planning/` — it stops and asks
    for `/gsd-new-project` first. Mission Control only offered that for repos it judged
    greenfield, so an established repo with no GSD project fell between the two: the
    plan step could not proceed, and an agent handed a complete mission description
    simply built the thing instead of stopping to say so.
    """
    ensure_supported_backend()
    return "/gsd-new-project --auto"


def workflow_path(command: str) -> Optional[str]:
    """The workflow document behind a GSD skill, for a runtime that has no skills.

    GSD ships as Claude Code skills, so `/gsd-plan-phase` resolves there and nowhere
    else. The workflows themselves are markdown under gsd-core/workflows — documents,
    not code — so any agent that can read a file can follow one. That is what keeps
    planning a contract rather than a Claude Code feature.
    """
    name = command.lstrip("/").removeprefix("gsd-").split()[0]
    for root in (Path.home() / ".claude" / "gsd-core" / "workflows",):
        candidate = root / f"{name}.md"
        if candidate.is_file():
            return str(candidate)
    return None


def plan_step_text(provider: str = "", mode: str = "", brief: str = "") -> str:
    """The Plan step, written so the agent handles an uninitialised project itself.

    The worktree does not exist when the prompt is built, so the sequence cannot be
    decided ahead of time — but the agent can check one directory. Stating the
    precondition is what was missing: `/gsd-plan-phase` stops and asks for
    `/gsd-new-project` when there is no `.planning/`, and an agent holding a complete
    mission description will build the thing instead of relaying that question.
    """
    ensure_supported_backend()
    text = (
        f"First check whether this repo has a GSD project: `ls -d {planning_dir_name()} 2>/dev/null`.\n"
        f"- If it is MISSING, run `{init_command()}` first. `{plan_command()}` cannot plan into a\n"
        f"  repo with no {planning_dir_name()}/ — it will stop and ask for this, and you must not\n"
        f"  skip ahead to writing code when that happens.\n"
        f"- Then run `{plan_command(mode=mode, brief=brief)}`."
    )
    if brief:
        # Said plainly as well as passed as a flag. The decisions are already in
        # this prompt as prose; the file is what makes them binding, and an agent
        # that reads it will not re-litigate what it says.
        text += (
            f"\n\n`{brief}` holds the decisions already settled with the human on this\n"
            "ticket. They are locked: build to them, do not re-open them, and do not ask\n"
            "about anything they already answer."
        )
    return text


def plan_sequence(cwd: str) -> list:
    """Commands to get from this repo's current state to a phase plan."""
    ensure_supported_backend()
    if project_initialised(cwd):
        return [plan_command()]
    return [init_command(), plan_command()]


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
