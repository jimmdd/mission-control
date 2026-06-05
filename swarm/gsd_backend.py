"""GSD backend integration helpers for Mission Control swarm prompts.

The current supported backend is GSD Core. Keep all command spellings here so
future gsd-pi support can be added without rewriting planner/bridge prompts.
"""

from __future__ import annotations

import os


SUPPORTED_BACKENDS = {"core"}
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
            f"Supported backends: {supported}. gsd-pi requires a separate adapter."
        )
    return backend


def plan_command(greenfield: bool = False) -> str:
    ensure_supported_backend()
    if greenfield:
        return "/gsd:new-project --auto"
    return "/gsd:plan-phase --prd"


def gap_plan_command() -> str:
    ensure_supported_backend()
    return "/gsd:plan-phase --gaps"


def execute_command() -> str:
    ensure_supported_backend()
    return "/gsd:execute-phase"


def verify_command() -> str:
    ensure_supported_backend()
    return "/gsd:verify-work"


def planning_dir_name() -> str:
    ensure_supported_backend()
    return ".planning"


def backend_label() -> str:
    ensure_supported_backend()
    return "GSD Core"
