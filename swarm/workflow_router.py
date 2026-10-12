"""Which workflow a ticket gets — light, heavy or GSD — and Jev's shadow verdict on it.

Every implementation ticket runs the full GSD workflow, so a two-line footer weight
change costs the same hours as a new launch flow. The fix is to let Jev (TypeSafe's
System One model, typed answers with probabilities) route bounded frontend tickets
to a lighter path. This module holds both halves, and only the first is on by default:

SHADOW (on; MC_JEV_SHADOW=0 turns it off) — each ticket gets a light/full verdict,
the verdict is written to the shadow log, and the ticket runs exactly as before. The
verdicts are compared against what the merged PRs actually turned out to be.

ROUTING (off; `workflowRouting.enabled` in swarm-config.json turns it on) — the
verdict picks the workflow:

    light — one agent, no planning stage, one gate review.
    heavy — the same agent, plus a short plan it writes itself, one critic pass on
            that plan, and a final code + gate review. Still no separate stage.
    gsd   — the GSD loop. While routing is off, every ticket gets it, as today.
            With routing on it is never chosen automatically (measured 1–3.5 hours
            and 25–29M input tokens per ticket, 2026-09-22), only by explicit
            override. A per-ticket override is honoured either way.

Why shadow first: the thresholds were fitted against 35 past tickets whose merged
PRs are the ground truth (2026-09-22) and scored on those same tickets — 14 picked
light, 10 right, 2 misses — so they are probably optimistic. "UI-only" alone was not
enough: nine of 23 UI-only tickets were large (MET-726 changed 7k lines). And no
reading of a ticket can see backend work it does not mention (MET-657, MET-659 read
as UI and needed new API queries), which is why a light run carries its own bounds
and escalates when it crosses them.

The policy stays here, in code: Jev reports what it sees; `decide` and
`choose_workflow` choose. Every uncertainty resolves away from light, because a small
ticket sent the long way wastes time while a large one sent the short way ships a
thin PR.
"""

from __future__ import annotations

import json
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

# What a light run may not touch. Crossing either bound means the ticket was not
# what it looked like, and the run switches to the heavy workflow.
LIGHT_MAX_FILES = 15
LIGHT_BLOCKED_PATHS = re.compile(
    r"(^|/)(migrations?|drizzle|alembic|\.sqlx|sql)(/|$)"
    r"|\.sql$"
    r"|^\.github/workflows/"
    r"|^apps/(new-api|api|backable-api|backable-ws|ws-server|chat-server|cranker|accelerated-cranker"
    r"|futarchy-indexer-v2|backoffice)/"
    r"|^packages/",
    re.I,
)
LIGHT_BLOCKED_PATHS_HUMAN = (
    "API or backend services (`apps/new-api`, `apps/api`, `apps/backable-api`, "
    "indexers, crankers, ws/chat servers, backoffice), shared `packages/`, SQL, "
    "migrations or schema, and `.github/workflows`"
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
            "A single tweak to an existing element: a color, spacing, copy, icon, or one "
            "component's styling.",
            "A few closely related adjustments on one existing page or component.",
            "Several separate concerns, or a substantial rework of an existing section or flow.",
            "A new page, feature, or multi-step flow, or a change that spans many pages.",
        ],
    },
    "money_or_chain": {
        "type": "noul",
        "instructions": "Does `ticket` change how funds, fees, token amounts, on-chain "
                        "transactions, wallet signing, or authentication behave (not merely "
                        "how they are displayed)?",
    },
}


def ticket_state(task: Dict) -> Dict:
    """What Jev reads: the ticket and its triage context, none of MC's boilerplate.

    Same shape as the backtest's input (the head of the agent prompt), so the fitted
    thresholds describe what this call actually sees.
    """
    text = f"# Task: {task.get('title') or ''}\n\n## Context\n{task.get('description') or ''}"
    return {"ticket": text[:8000]}


def ask_jev(task: Dict, api_key: str, timeout: float = 10.0, retries: int = 2) -> Dict:
    """One call, three questions. Returns the raw Jev answers; raises on any failure."""
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
    """The three numbers the policy reads."""
    a = response["answers"]
    return {
        "model": response.get("model", ""),
        "ui_only": round(float(a["ui_only"]["noul"]), 3),
        "scope": round(float(a["scope"]["score"]), 3),
        "scope_confidence": round(float(a["scope"].get("confidence", 0.0)), 3),
        "money_or_chain": round(float(a["money_or_chain"]["noul"]), 3),
    }


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


def choose_workflow(jev: Optional[Dict], *, enabled: bool, override: str = "",
                    level: str = "", thresholds: Optional[Dict] = None,
                    jev_error: str = "") -> Dict:
    """Return {'workflow', 'source', 'why': [...]} — never a bare tier.

    `jev` is `summarise()` output, or None when Jev was not asked or failed. With
    routing off (`enabled=False`) the answer is `gsd` with source `off` unless the
    ticket carries an explicit override. With routing on, `decide`'s light verdict
    becomes `light` and anything else `heavy`; `careful` process level alone forces
    `heavy`, and nothing here returns `gsd` except an override.
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
    verdict = decide(jev, thresholds)
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
