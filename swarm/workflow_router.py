"""Would this ticket have been fine on a light workflow? Asked, recorded, not acted on.

Every implementation ticket runs the full GSD workflow, so a two-line footer weight
change costs the same hours as a new launch flow. The proposed fix is to let Jev
(TypeSafe's System One model, typed answers with probabilities) route bounded
frontend tickets to a lighter path. Before anything is routed that way, this runs in
SHADOW: each ticket gets a verdict, the verdict is written down, and the ticket runs
the full workflow exactly as before. The verdicts are compared against what the
merged PRs actually turned out to be before the routing is ever switched on.

Why shadow first: the thresholds were fitted against 35 past tickets whose merged
PRs are the ground truth (2026-09-22) and scored on those same tickets — 14 picked
light, 10 right, 2 misses — so they are probably optimistic. "UI-only" alone was not
enough: nine of 23 UI-only tickets were large (MET-726 changed 7k lines). And no
reading of a ticket can see backend work it does not mention (MET-657, MET-659 read
as UI and needed new API queries).

The policy stays here, in code: Jev reports what it sees; `decide` chooses. Every
uncertainty resolves to `full`, because a small ticket sent the long way wastes time
while a large one sent the short way ships a thin PR.
"""

from __future__ import annotations

import json
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
