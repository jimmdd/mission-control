"""Read GSD's plan back into the shape Mission Control's UI knows.

MC's plan endpoint serves `bridge/plans/<task-id>.json` — a step list with
dependencies and waves, which the ticket page draws as a map. GSD writes
`.planning/**/NN-NN-PLAN.md`: YAML frontmatter plus `<task>` blocks. Nothing
translated between them, so a ticket with a perfectly good plan on disk reported
`{"plan": null}` and the page said "no plan yet" indefinitely.

This is the narrow half of the handoff's third open problem — "MC's step plan and
GSD's phase plan are two different decompositions with nothing reconciling them".
It does not reconcile them. It reads GSD's, which is the one that now exists, and
presents it in the shape the page already draws. MC's own planner still writes the
same file when it runs; whichever produced the plan, the page reads one format.

Deliberately lossy. A `<task>` carries an action several paragraphs long, and the
map shows a title and an edge — the detail belongs in the plan file, which the
page links to rather than reprints.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Optional

TASK_BLOCK = re.compile(r"<task\b([^>]*)>(.*?)</task>", re.S | re.I)
NAME = re.compile(r"<name>\s*(.*?)\s*</name>", re.S | re.I)
FILES = re.compile(r"<files>\s*(.*?)\s*</files>", re.S | re.I)
VERIFY = re.compile(r"<verify>\s*(.*?)\s*</verify>", re.S | re.I)
ATTR = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
# Enough YAML for the fields that matter. A dependency-free reader is worth more
# here than full YAML: this runs inside the bridge, which has no yaml import today.
FRONT = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)


def _front_matter(text: str) -> Dict[str, str]:
    m = FRONT.search(text or "")
    if not m:
        return {}
    out: Dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "-", "#")):
            k, _, v = line.partition(":")
            out[k.strip()] = v.strip()
    return out


def _files_of(block: str) -> List[str]:
    m = FILES.search(block)
    if not m:
        return []
    return [f.strip() for f in re.split(r"[,\n]", m.group(1)) if f.strip()]


def parse_plan_file(path: Path) -> Dict:
    """One GSD plan file — its wave, its tasks, and the files they touch."""
    text = path.read_text(errors="replace")
    front = _front_matter(text)
    try:
        wave = int(front.get("wave", "1"))
    except ValueError:
        wave = 1
    tasks = []
    for attrs, block in TASK_BLOCK.findall(text):
        name = NAME.search(block)
        title = (name.group(1) if name else "").strip()
        # "Task 3: Do the thing" — the number is the position, which the step
        # already carries. Keeping it would print it twice on every node.
        title = re.sub(r"^task\s*\d+\s*[:.\-–]\s*", "", title, flags=re.I)
        verify = VERIFY.search(block)
        tasks.append({
            "title": title or "(untitled task)",
            "kind": dict(ATTR.findall(attrs or "")).get("type", ""),
            "files": _files_of(block),
            "verify_command": (verify.group(1).strip().splitlines() or [""])[0] if verify else "",
        })
    return {"wave": wave, "phase": front.get("phase", ""), "tasks": tasks, "source": str(path)}


def to_mc_plan(plan_files: List[Path]) -> Optional[Dict]:
    """GSD's plans as MC's step list, or None when there is nothing to show.

    Steps are numbered across the whole set so the ids are stable and unique.

    The grouping is load-bearing, not decorative: `planner.py` reads
    `parallel_groups` from this same file to decide how many agents to dispatch at
    once. The first version put every task of a plan file into one group, which
    would have fired ten agents simultaneously for work GSD wrote as ten ordered
    steps of one plan.

    GSD's shape: tasks *within* a plan file are sequential — each `<task>` has a
    precondition describing the state the previous one leaves — while separate
    plan files sharing a `wave` are the ones meant to run together. So the Nth
    task of every file in a wave forms one group, and the groups run in order.
    """
    parsed = []
    for p in sorted(plan_files):
        try:
            parsed.append(parse_plan_file(p))
        except OSError:
            continue
    parsed = [p for p in parsed if p["tasks"]]
    if not parsed:
        return None

    steps: List[Dict] = []
    ordered: List[List[int]] = []
    n = 0
    for wave in sorted({p["wave"] for p in parsed}):
        files_in_wave = [p for p in parsed if p["wave"] == wave]
        # One group per position: the Nth task of each plan file in this wave.
        # Within a file the tasks stay ordered, because each one's precondition
        # describes what the last one left behind.
        by_position: Dict[int, List[int]] = {}
        for plan in files_in_wave:
            previous: Optional[int] = None
            for i, t in enumerate(plan["tasks"]):
                n += 1
                steps.append({
                    "step": n,
                    "title": t["title"],
                    "files": t["files"],
                    "verify_command": t["verify_command"],
                    "category": t["kind"],
                    "source": plan["source"],
                    # The step before it in the same plan file. Not every step of
                    # the previous wave: that would draw edges GSD never wrote.
                    "depends_on": [previous] if previous else [],
                })
                by_position.setdefault(i, []).append(n)
                previous = n
        for i in sorted(by_position):
            ordered.append(by_position[i])

    return {
        "steps": steps,
        "parallel_groups": ordered,
        "source": "gsd",
        "phase": parsed[0].get("phase", ""),
    }


def write_mc_plan(mc_home: Path, task_id: str, plan_files: List[Path]) -> Optional[Path]:
    """Write the imported plan where `/api/tasks/:id/plan` looks for it."""
    plan = to_mc_plan(plan_files)
    if not plan:
        return None
    dest = Path(mc_home) / "bridge" / "plans" / f"{task_id}.json"
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(plan, indent=2), encoding="utf-8")
        return dest
    except OSError:
        return None
