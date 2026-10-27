"""Adaptive bounded-issue routing, opt-in for future tasks.

Light and heavy run in one session; GSD remains an explicit structured option.
The historical UI-only shadow verdict is retained for comparing old assessments.
New routing requires complete behavioral risk scores, independent of code layer.
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

VERDICTS = ("light", "full")

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"

# Fitted on the backtest above. Thresholds, not constants of nature: re-fit them
# against the shadow log once enough tickets have merged.
DEFAULT_THRESHOLDS = {
    "ui_only_min": 0.7,   # p(frontend-only) must exceed this
    "scope_max": 1.2,     # Score 0–3; ≤1.2 is "a few related adjustments" or less
    "money_max": 0.3,     # p(changes funds/chain/auth behaviour) must stay below this
}

# A failed call is retried on a later dispatch, but not forever: a ticket that has
# failed this many times is left without a verdict.
MAX_FAILED_ATTEMPTS = 3

# Routing tiers and per-ticket overrides. "" is Auto: let the assessment decide.
WORKFLOWS = ("light", "heavy", "gsd")
OVERRIDES = ("", "light", "heavy", "gsd")

# Wall-clock budgets the agent is told to keep. Past the budget it stops and opens
# what it has as a draft PR with a status note, instead of looping.
BUDGET_MINUTES = {"light": 45, "heavy": 120}
# Reasoning effort for the building agent. Most of a run's wall-clock was per-step
# thinking on a large context (MET-792: 54 of 71 minutes), so light runs lower.
EFFORT = {"light": "medium", "heavy": "high"}

POLICY_VERSION = "adaptive-bounded-v1"
RISK_LIMITS = {
    "behavioral_uncertainty": 0.3,
    "blast_radius": 0.3,
    "hard_to_reverse": 0.3,
    "hard_to_test": 0.3,
    "migration_or_contract": 0.3,
    "money_or_chain": 0.3,
}
RISK_QUESTIONS = {
    "behavioral_uncertainty": "Are requirements unclear or is existing behavior insufficiently understood to name a concrete repro, expected result and bounded fix?",
    "blast_radius": "Could the change affect several consumers, services, workflows or broad shared contracts rather than one bounded behavior?",
    "hard_to_reverse": "Would rollback be difficult, destructive or leave persistent external effects?",
    "hard_to_test": "Is it difficult to verify the requested behavior with focused deterministic regression checks and existing local tooling?",
    "migration_or_contract": "Does the task require a database migration, schema change, broad API/shared contract change or compatibility rollout?",
}

# Paths are a conservative backstop, not a UI-only allowlist. Local backend
# mappings, read queries and shared helpers can be bounded. Semantics still win.
LIGHT_MAX_FILES = 15
LIGHT_BLOCKED_PATHS = re.compile(
    r"(^|/)(migrations?|drizzle|alembic|schema|schemas|auth|authentication|authorization|contracts?|programs)(/|$)"
    r"|(^|/)schema\.[^/]+$|^\.github/workflows/", re.I,
)
LIGHT_BLOCKED_PATHS_HUMAN = (
    "migrations/schema, auth or funds/chain semantics, broad shared/API contracts, "
    "CI workflows, unclear requirements, hard-to-reverse effects, or behavior without focused verification. "
    "A bounded backend field mapping, read query or shared helper alone is allowed"
)

QUESTIONS = {
    "ui_only": {
        "type": "noul",
        "instructions": "Can the work described in `ticket` be completed entirely by changing "
                        "frontend application code (pages, components, styles, copy, client-side "
                        "logic, and their UI tests) in an existing web app?",
        "criteria": {
            "true": "Only frontend code needs to change; any data it shows is already "
                    "available from existing APIs.",
            "false": "It also needs changes to API endpoints, server-side queries, database "
                     "schema or migrations, backend services, CI workflows, or on-chain programs.",
        },
    },
    "scope": {
        "type": "score",
        "instructions": "How large is the change `ticket` asks for?",
        "criteria": [
            "One local change to existing behavior: copy/style, an output field mapping, "
            "a read-query correction or a small helper with focused regression coverage.",
            "A few closely related adjustments to one existing behavior or boundary.",
            "Several separate concerns, or a substantial rework of a component, endpoint or flow.",
            "A new feature, multi-step flow or change spanning many consumers/services.",
        ],
    },
    "money_or_chain": {
        "type": "noul",
        "instructions": "Does `ticket` change how funds, fees, token amounts, on-chain "
                        "transactions, wallet signing, or authentication behave (not merely "
                        "how they are displayed)?",
    },
}

QUESTIONS.update({name: {"type": "noul", "instructions": question +
    " Assess the behavior and evidence in ticket, regardless of frontend/backend location. "
    "Unknown or missing evidence counts as risk; do not assume safety from a small description."}
    for name, question in RISK_QUESTIONS.items()})


def _number(value, maximum=1.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("risk score must be a number")
    if not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError("risk score outside range")
    return value


def ticket_state(task: Dict) -> Dict:
    """What Jev reads: the ticket and its triage context, none of MC's boilerplate.

    Same shape as the backtest's input (the head of the agent prompt), so the fitted
    thresholds describe what this call actually sees.
    """
    text = f"# Task: {task.get('title') or ''}\n\n## Context\n{task.get('description') or ''}"
    return {"ticket": text[:8000]}


def ask_jev(task: Dict, api_key: str, timeout: float = 10.0, retries: int = 2) -> Dict:
    """One call, bounded risk questions. Returns the raw Jev answers; raises on any failure."""
    body = json.dumps({"model": JEV_MODEL, "state": ticket_state(task),
                       "questions": QUESTIONS}).encode()
    last: Optional[Exception] = None
    for attempt in range(retries):
        req = urllib.request.Request(JEV_URL, data=body, method="POST", headers={
            "Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 529):
                raise
            time.sleep(2 ** attempt)
    raise last or RuntimeError("Jev request failed")


def summarise(response: Dict) -> Dict:
    """Validated legacy and behavioral risk numbers; unknown risk remains unknown."""
    a = response["answers"]
    result = {
        "model": response.get("model", ""),
        "ui_only": round(_number(a["ui_only"]["noul"]), 3),
        "scope": round(_number(a["scope"]["score"], 3), 3),
        "scope_confidence": round(_number(a["scope"].get("confidence", 0.0)), 3),
        "money_or_chain": round(_number(a["money_or_chain"]["noul"]), 3),
    }
    # Old shadow responses remain readable, but cannot qualify new work as lean.
    for name in RISK_QUESTIONS:
        if name in a:
            result[name] = round(_number(a[name]["noul"]), 3)
    return result


def assess_risk(assessment: Dict, thresholds: Optional[Dict] = None) -> Dict:
    """All safety evidence is required. Invalid/unknown scores fail away from lean."""
    limits = {**RISK_LIMITS}
    if thresholds and "money_max" in thresholds:
        limits["money_or_chain"] = thresholds["money_max"]
    blockers = []
    try:
        scope = _number(assessment.get("scope"), 3)
        scope_max = _number((thresholds or {}).get("scope_max", 1.2), 3)
        if scope > scope_max:
            blockers.append(f"size {scope:.1f}/3 is above {scope_max:.1f}")
        for name, limit in limits.items():
            score = _number(assessment.get(name))
            if score >= _number(limit):
                blockers.append(f"{name.replace('_', ' ')} risk {score:.0%}")
    except (ValueError, TypeError, AttributeError):
        return {"verdict": "full", "why": ["missing or invalid behavioral risk assessment"]}
    return {"verdict": "full" if blockers else "light", "why": blockers or [
        "bounded scope; low behavioral uncertainty and blast radius",
        "reversible with focused regression checks; no high-risk semantics or migration/contract change",
    ]}


def decide(jev: Dict, thresholds: Optional[Dict] = None) -> Dict:
    """Return {'verdict', 'why': [...]} for `summarise()` output — never a bare verdict."""
    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    ui, scope, money = jev["ui_only"], jev["scope"], jev["money_or_chain"]
    blockers: List[str] = []
    if ui <= t["ui_only_min"]:
        blockers.append(f"may need more than frontend changes (UI-only {ui:.0%} ≤ {t['ui_only_min']:.0%})")
    if scope > t["scope_max"]:
        blockers.append(f"size {scope:.1f}/3 is above {t['scope_max']:.1f}")
    if money >= t["money_max"]:
        blockers.append(f"may change funds, chain or auth behaviour ({money:.0%})")
    if blockers:
        return {"verdict": "full", "why": blockers}
    return {"verdict": "light",
            "why": [f"UI-only {ui:.0%}", f"size {scope:.1f}/3", f"funds/chain/auth {money:.0%}"]}


def _records(log_path: Path, task_id: str) -> List[Dict]:
    out: List[Dict] = []
    try:
        lines = log_path.read_text().splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("task_id") == task_id:
            out.append(rec)
    return out


def needs_verdict(log_path: Path, task_id: str) -> bool:
    """False once the ticket has a verdict, or has failed MAX_FAILED_ATTEMPTS times.

    Dispatch runs every poll while planning is in progress; without this each tick
    would call Jev again and append a duplicate.
    """
    recs = _records(log_path, task_id)
    if any(r.get("verdict") in VERDICTS for r in recs):
        return False
    return sum(1 for r in recs if r.get("error")) < MAX_FAILED_ATTEMPTS


def shadow(task: Dict, api_key: str, log_path: Path, *, ref: str = "",
           ask=None, thresholds: Optional[Dict] = None) -> Dict:
    """Ask Jev about `task`, append the result to `log_path`, and return the record.

    The record is the evidence for switching routing on: task identity, Jev's raw
    numbers, the verdict and its reasons, and the thresholds that produced it. A
    failure is recorded too (with `error`), never turned into a verdict.
    """
    rec: Dict = {
        "task_id": task["id"], "ref": ref, "title": task.get("title") or "",
        "at": datetime.now(timezone.utc).isoformat(),
        "thresholds": {**DEFAULT_THRESHOLDS, **(thresholds or {})},
    }
    try:
        jev = summarise((ask or ask_jev)(task, api_key))
        rec.update({"jev": jev, **decide(jev, thresholds)})
    except Exception as e:
        rec["error"] = type(e).__name__ + (f" {e.code}" if hasattr(e, "code") else "")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def routing_enabled(config: Optional[Dict]) -> bool:
    """Whether Jev's verdict picks the workflow. Off unless swarm-config.json says
    `"workflowRouting": {"enabled": true}` — anything else, including a missing or
    unreadable config, keeps every ticket on GSD as before."""
    routing = (config or {}).get("workflowRouting")
    return isinstance(routing, dict) and routing.get("enabled") is True


def routing_applies(config: Optional[Dict], task_id: str) -> bool:
    """Optional canary allowlist limits activation to selected future task IDs."""
    if not routing_enabled(config):
        return False
    if "taskIds" not in config["workflowRouting"]:
        return True
    ids = config["workflowRouting"]["taskIds"]
    return (isinstance(ids, list) and all(isinstance(i, str) and i for i in ids)
            and task_id in ids)


def choose_workflow(jev: Optional[Dict], *, enabled: bool, override: str = "",
                    level: str = "", thresholds: Optional[Dict] = None,
                    jev_error: str = "") -> Dict:
    """Choose a bounded path from complete risk evidence; GSD remains explicit.

    Routing off preserves the legacy default. Missing evidence falls back to heavy.
    Overrides apply only before dispatch; the bridge owns active-run preservation.
    """
    if override in WORKFLOWS:
        return {"workflow": override, "source": "override",
                "why": [f"set to {override} on the ticket"]}
    if not enabled:
        return {"workflow": "gsd", "source": "off", "why": ["Jev workflow routing is off"]}
    if level == "careful":
        return {"workflow": "heavy", "source": "rules", "why": ["process level is careful"]}
    if not jev:
        return {"workflow": "heavy", "source": "fallback",
                "why": [f"Jev unavailable ({jev_error})" if jev_error else "Jev not configured"]}
    verdict = assess_risk(jev, thresholds)
    return {"workflow": "light" if verdict["verdict"] == "light" else "heavy",
            "source": "jev", "why": verdict["why"]}


def crosses_light_bounds(paths: List[str]) -> Optional[str]:
    """Why a light run's diff has outgrown the light workflow, or None."""
    for p in paths or []:
        if LIGHT_BLOCKED_PATHS.search(p or ""):
            return f"touches {p}"
    if len(paths or []) > LIGHT_MAX_FILES:
        return f"changes {len(paths)} files (light allows {LIGHT_MAX_FILES})"
    return None
