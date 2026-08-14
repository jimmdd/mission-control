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
    Waves become `parallel_groups`, and a wave depends on the one before it —
    which is what a wave means, and what the map already draws.
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
    groups: Dict[int, List[int]] = {}
    n = 0
    for plan in sorted(parsed, key=lambda p: p["wave"]):
        for t in plan["tasks"]:
            n += 1
            steps.append({
                "step": n,
                "title": t["title"],
                "files": t["files"],
                "verify_command": t["verify_command"],
                "category": t["kind"],
                "source": plan["source"],
                # Depends on every step of the previous wave: a later wave starts
                # when the earlier one is done, which is the only ordering GSD
                # states. Inventing finer edges would draw a graph nobody wrote.
                "depends_on": [],
            })
            groups.setdefault(plan["wave"], []).append(n)

    ordered_waves = sorted(groups)
    for i, wave in enumerate(ordered_waves[1:], start=1):
        previous = groups[ordered_waves[i - 1]]
        for step_no in groups[wave]:
            steps[step_no - 1]["depends_on"] = list(previous)

    return {
        "steps": steps,
        "parallel_groups": [groups[w] for w in ordered_waves],
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
