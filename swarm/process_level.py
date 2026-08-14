"""How much process a ticket needs, decided from what is already known.

"I can't imagine a very simple task needs this whole process" is the right
objection, and the answer is not a new judgement call — it is that the judgement
already exists and was being thrown away. Triage returns `ready`, defined in its
own prompt as "enough detail to write code (clear requirements, identifiable
target repo)". That *is* a complexity assessment, made per ticket, already paid
for.

What made it unsafe to act on was not the judgement but its invisibility: the
ready path recorded nothing, so a confident wrong call could not be reviewed and
nearly branched into a live company repo unprompted. So the rule here is the one
the rest of the system runs on — prefer an observable fact to an assertion — and
the level always travels with the reasons that produced it, so a person can see
what the machine concluded and overrule it.

Every input is something MC already has. No extra model call is made to decide
this; that would be answering "is this simple?" with the expensive thing the
question is trying to avoid.

    simple   — triage had no questions, one repo, a gate that passes, no
               migrations, and nothing that leaves the machine.
    normal   — the default. Confirm before anything is created.
    careful  — more than one repo, no runnable gate, schema or infrastructure
               changes, or triage itself was unsure.

`careful` is deliberately reachable by *any* single risk, while `simple` needs
every condition at once. The costs are not symmetric: a simple ticket treated
carefully wastes a click, a careful one treated simply writes to a database.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

LEVELS = ("simple", "normal", "careful")

# Paths whose change is not undone by reverting a commit. A migration that has run
# has already altered something the git history does not describe.
IRREVERSIBLE = re.compile(
    r"(^|/)(migrations?|alembic|schema|infra|terraform|helm|k8s|deploy|\.github/workflows)(/|$)"
    r"|\.(sql|tf)$",
    re.I,
)


def _touches_irreversible(paths: List[str]) -> Optional[str]:
    for p in paths or []:
        if IRREVERSIBLE.search(p or ""):
            return p
    return None


def assess(
    *,
    questions: Optional[List[Dict]] = None,
    repos: Optional[List[Dict]] = None,
    gate_runnable: Optional[bool] = None,
    paths: Optional[List[str]] = None,
    pushable: bool = True,
    triage_ready: bool = True,
    stage: str = "build",
) -> Dict:
    """Return {'level', 'why': [...]} — never a bare verdict.

    `why` is the point as much as `level` is. A level with no reasons is the same
    unreviewable judgement this exists to replace, and it is what the ticket page
    shows so the call can be disagreed with.

    `stage` is which gate is asking, and it matters because the two gates guard
    very different things:

    - `plan` runs before planning, when no plan exists — so there is no gate to
      probe and no file list to inspect. Planning writes `.planning/` and nothing
      else, so their absence is not treated as a risk. Making it one would mean
      every ticket needs confirmation before an agent may *think*, which is the
      objection this module answers.
    - `build` runs before code is written, where a plan exists and both are
      knowable. Here an unknown gate is not a passing one.
    """
    questions = questions or []
    repos = repos or []
    reasons: List[str] = []

    open_qs = [q for q in questions if not q.get("answer") and not q.get("deferred")]
    if open_qs:
        # Nothing is decidable while a human still owes an answer.
        return {"level": "normal", "why": [f"{len(open_qs)} question(s) still open"]}

    building = stage == "build"

    risky = _touches_irreversible(paths or [])
    if risky:
        reasons.append(f"touches {risky}, which reverting a commit does not undo")
    if len(repos) > 1:
        reasons.append(f"spans {len(repos)} repos")
    if gate_runnable is False:
        reasons.append("no verify command that runs on the base commit")
    if not triage_ready:
        reasons.append("triage did not consider it ready")
    if reasons:
        return {"level": "careful", "why": reasons}

    # Simple needs everything at once, not merely the absence of trouble.
    if questions:
        reasons.append(f"{len(questions)} question(s), all settled")
    else:
        reasons.append("triage had no questions")
    if len(repos) == 1:
        reasons.append("one repo")
    if gate_runnable:
        reasons.append("its gate passes on the base commit")
    if pushable:
        # Not a blocker on its own, but it is the difference between a mistake
        # that stays on the machine and one that does not.
        reasons.append("can push, so a mistake leaves this machine")
        return {"level": "normal", "why": reasons}
    reasons.append("cannot push — a mistake stays local")

    if len(repos) != 1:
        return {"level": "normal", "why": reasons}
    # Before planning there is no gate to probe and no file list to read, and
    # planning writes nothing but `.planning/`. Requiring them here would mean
    # confirming before an agent may think, which is the thing being fixed.
    if building and not gate_runnable:
        reasons.append("its gate has not been shown to run")
        return {"level": "normal", "why": reasons}
    if not building:
        reasons.append("planning only — no code is written at this stage")
    return {"level": "simple", "why": reasons}


def requires_confirmation(level: str, override: str = "") -> bool:
    """Whether a human must confirm before anything is created.

    An explicit choice on the ticket outranks the assessment, in both directions:
    somebody who marks a ticket `careful` gets the gate even when the rules say
    otherwise, and somebody who marks it `simple` has said so deliberately, on a
    ticket, where it is visible — which is the whole difference from the silent
    auto-dispatch this replaces.
    """
    effective = override if override in LEVELS else level
    return effective != "simple"
