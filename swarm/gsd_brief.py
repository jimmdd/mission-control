"""The settled decisions, as a file GSD already knows how to read.

Mission Control asks the questions. It has to: GSD's discussion is built on
`AskUserQuestion`, and **that tool does not exist under `claude -p`**. Verified
from a real run — the MET-635 plan transcript lists the 163 tools the session was
offered and `AskUserQuestion` is not among them, and across three transcripts
there is not one `tool_use` block naming it. The sixty "mentions" are the workflow
markdown being read by the agent.

That matters more than a stall would. A missing tool named in a prompt fails the
same way the `gsd:` colon commands did: silently. The agent drops the section and
proceeds from the surrounding prose — so a discussion step becomes the agent
deciding, alone, with no record that a question was ever asked. GSD's own escape,
`--text` mode, is documented as "required for non-Claude runtimes where
AskUserQuestion is not available", but it only replaces the tool with a numbered
list and a request to type a choice. Under `-p` there is nobody to type it.

So the questions stay ours — asynchronous, with ids, exits and a thread, which is
the only shape that works when the answer arrives four hours later. What was
missing is the other half: making those answers *binding* on GSD rather than
prose in a prompt it may or may not weigh. GSD documents a file contract for
exactly this:

- `plan-phase.md:6` — `consumes: CONTEXT.md`
- `plan-phase.md` step 3.5 — `--prd <filepath>` reads the file, turns every
  requirement into a locked decision in `CONTEXT.md`, and **bypasses step 4**,
  which is the step that would otherwise call `AskUserQuestion` about the missing
  context and, finding no such tool, choose for itself.

This module writes that file. It is the same move already made for planning: the
workflows are markdown, so a runtime is handed the document and told to write the
same artefacts to the same paths.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional

BRIEF_NAME = "MC-BRIEF.md"


def _clean(text: str) -> str:
    """One line of prose, with the markdown link targets taken out.

    A Linear description carries its attachment URLs inline and they run to 140
    characters each. They are noise in a decision record, and the label is the
    part somebody wrote.
    """
    out = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text or "")
    out = re.sub(r"<https?://[^>]*>", "", out)
    return re.sub(r"[ \t]{2,}", " ", out).strip()


def render(task: Dict, questions: Optional[List[Dict]] = None) -> str:
    """The brief GSD's PRD express path turns into a locked CONTEXT.md.

    Every settled decision becomes a requirement line, because that is what the
    express path converts one-for-one. A deferred question is stated as
    out of scope rather than omitted: "we decided not to decide this yet" is a
    constraint on the plan, and dropping it invites the planner to build the thing
    the deferral was avoiding.
    """
    qs = questions or []
    answered = [q for q in qs if q.get("answer")]
    deferred = [q for q in qs if q.get("deferred") and not q.get("answer")]

    lines = [
        f"# {task.get('title', 'Untitled ticket')}",
        "",
        "> Written by Mission Control from the decisions settled on the ticket.",
        "> Every line under Requirements is a decision a human has already made or",
        "> explicitly delegated. Treat them as locked and do not re-open them.",
        "",
    ]

    description = _clean(task.get("description") or "")
    if description:
        lines += ["## Background", "", description, ""]

    lines += ["## Requirements", ""]
    if answered:
        for q in answered:
            tag = q.get("becomes") or "decision"
            by = " (chosen by the agent on the user's behalf)" if q.get("answered_by") == "agent" else ""
            lines.append(f"- **{tag}** — {_clean(q.get('question', ''))}")
            lines.append(f"  - Decision: {_clean(str(q.get('answer', '')))}{by}")
            if q.get("why"):
                lines.append(f"  - Why it was asked: {_clean(q['why'])}")
            if q.get("reason"):
                lines.append(f"  - Reasoning recorded with the answer: {_clean(q['reason'])}")
    else:
        # Never leave the section empty: the express path reads requirements, and a
        # PRD with none is indistinguishable from a PRD it failed to parse.
        lines.append("- No decisions were needed — the ticket description is the whole requirement.")
    lines.append("")

    if deferred:
        lines += ["## Out of scope", ""]
        for q in deferred:
            tag = q.get("becomes") or "decision"
            lines.append(
                f"- **{tag}** — {_clean(q.get('question', ''))} "
                "was deliberately deferred. Do not build anything that depends on it."
            )
        lines.append("")

    return "\n".join(lines)


def write(worktree: str, task: Dict, questions: Optional[List[Dict]] = None) -> Optional[Path]:
    """Write the brief into the worktree. Returns its path, or None if it cannot.

    Failing to write is not fatal — the decisions are in the prompt too — so this
    reports rather than raises. What it must never do is return a path to a file
    that is not there: `--prd` pointing at nothing sends the express path looking
    for a file, and the gate it exists to skip fires anyway.
    """
    try:
        root = Path(worktree)
        if not root.is_dir():
            return None
        path = root / BRIEF_NAME
        path.write_text(render(task, questions), encoding="utf-8")
        return path
    except OSError:
        return None
