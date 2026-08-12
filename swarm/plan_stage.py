"""Run planning as its own process, and classify what came back.

Planning used to be the first few turns of the same session that then wrote the
code. That made failure unreportable. A stage buried in a two-hundred-turn session
cannot say why it stopped: two full runs went 67 and 46 tool calls with zero Skill
invocations, and the logs looked healthy throughout. Worse, when the planner did the
right thing — produced a precise, actionable question about a font licence — the
question went to a terminal and died, because nothing was listening for one.

So planning gets its own `claude -p`, its own captured stdout, and a verdict:

- `plan_written` — there is a plan on disk with tasks in it.
- `questions_raised` — the planner needs something only a human has.
- `prerequisite_missing` — something the system should fix, not ask about.
- `error` — the run failed, timed out, or produced nothing.

The verdict is taken from the filesystem wherever the filesystem can answer.
`plan_written` means a `PLAN.md` containing `<task>` blocks exists, not that the
agent said it wrote one; `prerequisite_missing` is decided by looking for the
directory. Only `questions_raised` depends on what the agent emitted, and it has to
emit it in a fixed form to count — a question phrased in prose is indistinguishable
from thinking aloud, which is how the last one was lost.

The distinction between the last two is the one that matters. "This repo has no
`.planning/`" is a prerequisite the system fixes by running `/gsd-new-project`;
"which font licence did we buy" is a real question. Asking the first kind trains
people to click through, which is how the second kind stops being read.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional

import gsd_backend

MC_HOME = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))

# The planner marks a question by wrapping JSON in this tag. A fixed form is the
# whole point: prose asking is indistinguishable from prose thinking.
QUESTION_BLOCK = re.compile(r"<mc-questions>\s*(.*?)\s*</mc-questions>", re.S)

# What a real plan looks like on disk. GSD writes tasks as <task> blocks; a PLAN.md
# with none is a document about planning, not a plan.
TASK_BLOCK = re.compile(r"<task\b", re.I)

DEFAULT_TIMEOUT = 1800


def question_protocol() -> str:
    """The instruction that makes a planner's question survive the run."""
    return (
        "If you cannot write the plan because you need a decision that only a human can\n"
        "make — a licence someone bought, a product preference, a tradeoff with no\n"
        "technically correct answer — stop and emit exactly this, then end your run:\n"
        "\n"
        "<mc-questions>\n"
        '[{"question": "...", "why": "what changes depending on the answer",\n'
        '  "options": ["...", "..."]}]\n'
        "</mc-questions>\n"
        "\n"
        "Only ask what a human alone can answer. Anything you could determine by reading\n"
        "the repo, running a command, or following a documented step is not a question —\n"
        "do that instead. Do not ask for permission to proceed, and do not ask about\n"
        "missing setup: report that as a prerequisite by saying what is missing.\n"
    )


def build_prompt(task: Dict, context: str = "") -> str:
    """The planning prompt: what to plan, what is already decided, how to stop."""
    parts = [
        "You are planning one ticket. Produce a phase plan — do not write any application code.",
        f"TICKET: {task.get('title', '')}",
    ]
    if task.get("description"):
        parts.append(f"DESCRIPTION:\n{task['description']}")
    if context:
        parts.append(context)
    parts.append(gsd_backend.plan_step_text())
    parts.append(question_protocol())
    parts.append(
        "When the plan is written, say so and stop. Do not begin executing it."
    )
    return "\n\n".join(parts)


def find_plan(worktree: str) -> Optional[Path]:
    """The plan GSD wrote, if it wrote one with tasks in it.

    Presence of `.planning/` is not enough and neither is the agent's word: the run
    that produced no plan at all still reported progress in its transcript.
    """
    root = Path(worktree) / gsd_backend.planning_dir_name()
    if not root.is_dir():
        return None
    for path in sorted(root.rglob("PLAN.md")):
        try:
            if TASK_BLOCK.search(path.read_text(errors="replace")):
                return path
        except OSError:
            continue
    return None


def parse_questions(output: str) -> List[Dict]:
    """Questions the planner emitted in the agreed form. Malformed blocks are ignored."""
    for match in QUESTION_BLOCK.findall(output or ""):
        try:
            parsed = json.loads(match)
        except ValueError:
            logging.warning("  plan stage emitted an unparseable question block")
            continue
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            continue
        out = []
        for i, q in enumerate(parsed, 1):
            if not isinstance(q, dict) or not q.get("question"):
                continue
            out.append({
                "id": q.get("id") or f"plan_q{i}",
                "question": q["question"],
                "why": q.get("why", ""),
                "options": q.get("options") or None,
                "question_type": "multiple_choice" if q.get("options") else "text",
                "category": q.get("category", "scope"),
                # This is the field the ticket page leads with, and the one nothing
                # used to write — so a planner's question never reached the UI.
                "source": "planner",
            })
        if out:
            return out
    return []


def classify(worktree: str, output: str, returncode: Optional[int]) -> Dict:
    """Turn a finished run into a verdict, preferring the filesystem to the transcript."""
    plan_path = find_plan(worktree)
    if plan_path:
        return {"outcome": "plan_written", "plan_path": str(plan_path),
                "questions": [], "reason": f"plan at {plan_path}"}

    questions = parse_questions(output)
    if questions:
        return {"outcome": "questions_raised", "plan_path": None, "questions": questions,
                "reason": f"{len(questions)} question(s) only a human can answer"}

    # No plan and no question. If the project was never initialised, that is a
    # prerequisite the system fixes — never something to ask a person about.
    if not gsd_backend.project_initialised(worktree):
        ran, detail = gsd_backend.workflow_ran(worktree)
        return {
            "outcome": "prerequisite_missing", "plan_path": None, "questions": [],
            "reason": (f"no {gsd_backend.planning_dir_name()}/ in the worktree — the GSD project "
                       f"was never created ({detail})" if not ran else
                       f"GSD ran but wrote no plan ({detail})"),
        }

    if returncode not in (0, None):
        return {"outcome": "error", "plan_path": None, "questions": [],
                "reason": f"planner exited {returncode}"}

    return {"outcome": "error", "plan_path": None, "questions": [],
            "reason": "planner finished with a GSD project but no plan and no question"}


def _transcript_path(task_id: str) -> Path:
    return MC_HOME / "bridge" / "plan-stage" / f"{task_id}.log"


def text_from_stream(raw: str) -> str:
    """Assistant text out of a `--output-format stream-json` transcript.

    Falls back to returning the input unchanged, so a plain-text transcript — or a
    stream that died mid-line — still classifies rather than reading as empty.
    """
    if not raw:
        return ""
    parts, saw_json = [], False
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            # A half-written final line is normal when the process was killed.
            continue
        saw_json = True
        message = event.get("message") if isinstance(event.get("message"), dict) else event
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
        if isinstance(event.get("result"), str):
            parts.append(event["result"])
    return "\n".join(p for p in parts if p) if saw_json else raw


def run_plan_stage(worktree: str, task: Dict, context: str = "",
                   timeout: int = DEFAULT_TIMEOUT, model: str = "") -> Dict:
    """Plan in `worktree` as a separate process. Returns the verdict plus what it cost.

    Unlike the planner's question-and-answer calls, this one needs tools: it runs
    GSD skills that read the repo and write `.planning/`. The transcript is kept
    whatever happens — a stage that cannot say why it failed is the thing this
    replaces.
    """
    prompt = build_prompt(task, context)
    # stream-json, written straight to disk as it arrives. Buffered text output is
    # worthless here: the first real run was killed at its timeout having flushed
    # nothing, so the transcript came out empty at exactly the moment it was needed —
    # and a question the planner had already emitted would have gone with it.
    cmd = ["claude", "-p", prompt, "--dangerously-skip-permissions",
           "--output-format", "stream-json", "--verbose"]
    if model:
        cmd += ["--model", model]

    path = _transcript_path(task["id"])
    started = time.time()
    returncode, timed_out = None, False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as sink:
            proc = subprocess.Popen(cmd, cwd=worktree, stdout=sink,
                                    stderr=subprocess.STDOUT, text=True)
            try:
                returncode = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                proc.kill()
                proc.wait()
    except FileNotFoundError:
        return {"outcome": "error", "plan_path": None, "questions": [],
                "reason": "claude CLI not found on PATH", "duration_s": 0,
                "transcript_path": "", "gsd_ran": False}
    except OSError as e:
        return {"outcome": "error", "plan_path": None, "questions": [],
                "reason": f"could not run planning: {e}", "duration_s": 0,
                "transcript_path": str(path), "gsd_ran": False}

    try:
        output = text_from_stream(path.read_text(errors="replace"))
    except OSError:
        output = ""

    # Classify even after a timeout. A planner that emitted its question and then
    # hung has still asked it, and a plan already on disk is still a plan — throwing
    # either away because the process overran would repeat the failure this replaces.
    verdict = classify(worktree, output, None if timed_out else returncode)
    if timed_out and verdict["outcome"] == "error":
        verdict["reason"] = f"planning timed out after {timeout}s"

    ran, _ = gsd_backend.workflow_ran(worktree)
    verdict.update({
        "duration_s": round(time.time() - started, 1),
        "transcript_path": str(path),
        # Observable, not inferred from the prompt naming a command.
        "gsd_ran": ran,
    })
    return verdict
