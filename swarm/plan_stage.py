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

import hashlib
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

# Separate budgets, because the two stages cost very differently. Setting up an
# established repo is a one-off that reads the codebase and writes a roadmap; the
# 1800s the two shared went entirely to setup and planning never started.
#
# Both numbers are measured, not guessed. Setting up MET-635's repo took most of
# 1800s. Planning its first phase wrote its first plan at 19 minutes and two more by
# 27, and was still inside GSD's own plan-checker when 1800s killed it — so the cap
# was cutting off work that was still producing plans, not runaway.
INIT_TIMEOUT = int(os.environ.get("MC_GSD_INIT_TIMEOUT", "2700"))
PLAN_TIMEOUT = int(os.environ.get("MC_GSD_PLAN_TIMEOUT", "3600"))
DEFAULT_TIMEOUT = PLAN_TIMEOUT


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


def _planning_provider() -> str:
    """Which runtime plans. `planning_provider` in swarm-config.json; claude by default."""
    raw = (os.environ.get("MC_PLANNING_PROVIDER") or "").strip()
    if raw:
        return raw
    try:
        from planner import _get_config
        return str(_get_config().get("planning_provider", "") or "claude")
    except Exception:
        return "claude"


def _planning_effort() -> str:
    """Reasoning effort, for runtimes that take one. Ignored by those that do not."""
    raw = (os.environ.get("MC_PLANNING_EFFORT") or "").strip()
    if raw:
        return raw
    try:
        from planner import _get_config
        return str(_get_config().get("planning_effort", "") or "")
    except Exception:
        return ""


def workflow_instruction(provider: str, command: str) -> str:
    """How to invoke a GSD workflow on this runtime.

    GSD ships as Claude Code skills — 71 of them in ~/.claude/skills — so `/gsd-plan-phase`
    resolves there and nowhere else. But the workflows themselves are markdown documents
    under gsd-core/workflows, not code, and any agent that can read a file and follow it
    can execute one. So a runtime without the skill is handed the document instead.

    That keeps planning a contract rather than a runtime: whichever CLI runs, the verdict
    is still "is there a PLAN.md with <task> blocks on disk", which `find_plan` answers
    without reading a transcript.
    """
    if provider in ("claude", "claude-cli"):
        return f"Run `{command}`."

    path = gsd_backend.workflow_path(command)
    if not path:
        # Better to say so than to let a runtime improvise a plan and have it counted
        # as GSD output — the whole thesis rests on GSD's decomposition, not on any
        # plausible-looking plan.
        return (f"`{command}` is a Claude Code skill and this runtime cannot resolve it, "
                f"and its workflow document could not be found either. Stop and report "
                f"this rather than planning some other way.")
    return (f"This runtime has no `{command}` skill, so follow its workflow directly:\n"
            f"1. Read `{path}` in full.\n"
            f"2. Execute the steps it describes, in order, writing the same artefacts to "
            f"the same paths it specifies.\n"
            f"3. Where it calls for a sub-agent you cannot spawn, do that step's work "
            f"yourself in this session rather than skipping it.\n"
            f"Do not invent your own planning format — the output must match what the "
            f"workflow specifies.")


def waiting_protocol() -> str:
    """Never poll a background subagent by returning to the model.

    GSD backgrounds its planner and tells the orchestrator to "repeat gsd_stall_watch
    while waiting/active". On Claude Code every repeat is a turn, and every turn
    re-reads the whole context. On MET-635 that came to 485 turns of `echo pN`,
    each described by the model as "idle", at roughly 200K tokens apiece — about
    36% of the run's turns and 97M tokens, spent waiting.

    A shell loop that sleeps costs one turn no matter how long it waits. GSD ships
    the sleep already, inside its own helper; it just is not reliably reached.
    """
    return (
        "WAITING ON A BACKGROUND SUBAGENT — this matters more than it looks:\n"
        "Wait inside a single shell command that blocks, never by running a command,\n"
        "returning, and running another. One blocking call costs one turn however\n"
        "long it takes; polling costs a turn and a full context re-read every time\n"
        "round, and that is the single largest cost in a planning run.\n"
        "\n"
        "Use the workflow's own stall-detection helper if it defines one, since it\n"
        "already sleeps between checks. Otherwise block like this:\n"
        "\n"
        "  for i in $(seq 1 120); do <check> && break; sleep 15; done\n"
        "\n"
        "Do not emit placeholder commands such as `echo p1`, `echo p2` to pass the\n"
        "time. If you have nothing to do but wait, wait inside one command.\n"
    )


def _ticket_section(task: Dict) -> List[str]:
    parts = [f"TICKET: {task.get('title', '')}"]
    if task.get("description"):
        parts.append(f"DESCRIPTION:\n{task['description']}")
    return parts


def build_init_prompt(task: Dict, context: str = "", provider: str = "") -> str:
    """Create the GSD project. Nothing else.

    Initialising an established repo is expensive — on MET-635 it read the codebase,
    wrote a six-phase roadmap, a design contract and 61KB of research. Sharing one
    budget with planning meant it consumed the whole thirty minutes and planning
    never started. Separate stage, separate budget, and it only ever runs once.
    """
    parts = [
        "Set up the GSD project for this repository. Do not plan a phase yet, and do "
        "not write any application code.",
        *_ticket_section(task),
    ]
    if context:
        parts.append(context)
    parts.append(
        f"{workflow_instruction(provider or _planning_provider(), gsd_backend.init_command())}\n"
        f"When {gsd_backend.planning_dir_name()}/ exists with the project documents in it, "
        f"say so and stop."
    )
    # Scope, or the roadmap becomes a programme. Told only to start a "new project",
    # GSD read one ticket as a body of work and produced a six-phase roadmap — then
    # planning phase one alone wrote 220KB across three plans. Most of the cost, and
    # most of the scope, was work nobody had asked for.
    parts.append(
        "SCOPE: this is one ticket, not a programme of work. The roadmap must cover "
        "what this ticket asks for and nothing beyond it — prefer a single phase, and "
        "only split into more when the ticket genuinely contains separable pieces with "
        "a dependency between them. Do not add phases for adjacent improvements, "
        "follow-up polish, or work the ticket implies but does not request."
    )
    return "\n\n".join(parts)


def build_prompt(task: Dict, context: str = "", provider: str = "", mode: str = "") -> str:
    """The planning prompt: what to plan, what is already decided, how to stop.

    Assumes the GSD project exists — `plan_in_worktree` guarantees that by running
    the init stage first. `plan_step_text()` still states the precondition, because
    a plan stage that silently builds the thing when the project is missing is the
    original failure.
    """
    parts = [
        "You are planning one ticket. Produce a phase plan — do not write any application code.",
        *_ticket_section(task),
    ]
    if context:
        parts.append(context)
    parts.append(gsd_backend.plan_step_text(provider or _planning_provider(), mode))
    parts.append(question_protocol())
    parts.append(waiting_protocol())
    parts.append(
        "When the plan is written, say so and stop. Do not begin executing it."
    )
    return "\n\n".join(parts)


def find_plan(worktree: str, since: Optional[float] = None) -> Optional[Path]:
    """The plan GSD wrote, if *this run* wrote one with tasks in it.

    Presence of `.planning/` is not enough and neither is the agent's word: the run
    that produced no plan at all still reported progress in its transcript.

    `since` is the wall-clock the run started, and it is what stops a plan from
    somebody else's work being read as this one's. `.planning/` is tracked, so the
    second ticket in a GSD repo starts from a checkout that already contains a prior
    phase's PLAN.md — and the planning worktree is reused across attempts, so a
    retry starts with the previous attempt's. Without the floor the verdict is
    `plan_written` whatever this run did, and because a plan outranks a question, a
    `<mc-questions>` block the planner emitted is discarded with it.
    """
    root = Path(worktree) / gsd_backend.planning_dir_name()
    if not root.is_dir():
        return None
    # `*PLAN.md`, not `PLAN.md`. GSD names a phase's plans `01-01-PLAN.md`, one per
    # wave — the exact-name glob found nothing on a run that had just written two
    # perfectly good plans, and reported the success as "no plan and no question".
    # Newest first: a repo with several planned phases should report the plan this
    # run produced, not whichever sorts first by name.
    candidates = []
    for path in root.rglob("*PLAN.md"):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if since is not None and mtime < since:
            continue
        candidates.append((mtime, path))

    for _, path in sorted(candidates, reverse=True):
        try:
            if TASK_BLOCK.search(path.read_text(errors="replace")):
                return path
        except OSError:
            continue
    return None


def _question_id(question: str) -> str:
    """A stable id for a question, derived from its text.

    Same question asked twice is the same question — so re-asking something already
    answered still collapses onto the answer, which is what we want. A different
    question gets a different id and therefore reaches a human.
    """
    digest = hashlib.sha1(" ".join(question.lower().split()).encode()).hexdigest()
    return f"plan_{digest[:10]}"


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
                # Derived from the question text, not its position. `questions.merge`
                # matches by id and lets an existing answer win, so a positional
                # `plan_q1` meant round two's *different* question inherited round
                # one's answer: it read as settled, never reached anyone, and went to
                # the planner as a binding decision it had never made.
                "id": q.get("id") or _question_id(q["question"]),
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


def classify(worktree: str, output: str, returncode: Optional[int],
             since: Optional[float] = None) -> Dict:
    """Turn a finished run into a verdict, preferring the filesystem to the transcript.

    `since` scopes "is there a plan" to this run — see `find_plan`.
    """
    plan_path = find_plan(worktree, since=since)
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


def _transcript_path(task_id: str, stage: str = "plan") -> Path:
    """One transcript per stage. Init and plan overwriting each other would lose the
    only account of whichever ran first."""
    return MC_HOME / "bridge" / "plan-stage" / f"{task_id}.{stage}.log"


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


def build_command(provider: str, prompt: str, model: str = "", effort: str = "") -> List[str]:
    """The CLI invocation for a runtime. Raises ValueError for one we cannot drive.

    Both need tools and write access: these stages read the repo and create
    `.planning/`. That rules out the read-only sandbox MC uses for its own
    question-and-answer calls.
    """
    if provider in ("claude", "claude-cli"):
        cmd = ["claude", "-p", prompt, "--dangerously-skip-permissions",
               "--output-format", "stream-json", "--verbose"]
        if model:
            cmd += ["--model", model]
        return cmd

    if provider in ("codex", "codex-cli"):
        cmd = ["codex", "exec"]
        if model:
            cmd += ["--model", model]
        if effort:
            cmd += ["-c", f"model_reasoning_effort={effort}"]
        # Planning writes into the worktree, so the read-only sandbox will not do.
        cmd += ["--dangerously-bypass-approvals-and-sandbox", prompt]
        return cmd

    raise ValueError(f"unknown planning provider: {provider!r}")


def _run_cli(worktree: str, prompt: str, transcript: Path, timeout: int,
             model: str = "", provider: str = "claude", effort: str = "") -> Dict:
    """Run one tool-using planning process in a worktree, streaming to disk.

    Provider-agnostic on purpose. The verdict never reads the transcript to decide
    whether a plan exists — `find_plan` looks at the filesystem — so a plan written
    by codex counts exactly as much as one written by claude, and the contract is
    the artefact rather than the runtime.

    Output goes straight to the file as it arrives. Buffered output is worthless
    here: the first real run was killed at its timeout having flushed nothing, so
    the transcript came out empty at exactly the moment it was needed, and a
    question the planner had already emitted would have gone with it.

    Returns `{"output", "returncode", "timed_out", "duration_s", "failed"}`.
    """
    try:
        cmd = build_command(provider, prompt, model, effort)
    except ValueError as e:
        return {"output": "", "returncode": None, "timed_out": False,
                "duration_s": 0, "failed": str(e)}

    started = time.time()
    returncode, timed_out = None, False
    try:
        transcript.parent.mkdir(parents=True, exist_ok=True)
        with transcript.open("w") as sink:
            proc = subprocess.Popen(cmd, cwd=worktree, stdout=sink,
                                    stderr=subprocess.STDOUT, text=True)
            try:
                returncode = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                proc.kill()
                proc.wait()
    except FileNotFoundError:
        return {"output": "", "returncode": None, "timed_out": False,
                "duration_s": 0, "failed": f"{cmd[0]} CLI not found on PATH"}
    except OSError as e:
        return {"output": "", "returncode": None, "timed_out": False,
                "duration_s": 0, "failed": f"could not start planning: {e}"}

    try:
        output = text_from_stream(transcript.read_text(errors="replace"))
    except OSError:
        output = ""

    return {"output": output, "returncode": returncode, "timed_out": timed_out,
            "duration_s": round(time.time() - started, 1), "failed": None}


def run_init_stage(worktree: str, task: Dict, context: str = "", provider: str = "",
                   timeout: int = INIT_TIMEOUT, model: str = "") -> Dict:
    """Create the GSD project. Verdict is `initialised` or `prerequisite_missing`.

    Its own stage because it is expensive and it happens once: on MET-635 it read
    the codebase, wrote a six-phase roadmap, a design contract and 61KB of research,
    consumed the entire shared budget, and planning never started.

    A failure here is a prerequisite, not a question — nobody is asked to approve
    creating a directory.
    """
    if gsd_backend.project_initialised(worktree):
        return {"outcome": "initialised", "plan_path": None, "questions": [],
                "reason": "the GSD project already exists", "duration_s": 0,
                "transcript_path": "", "gsd_ran": True, "stage": "init"}

    transcript = _transcript_path(task["id"], "init")
    provider = provider or _planning_provider()
    run = _run_cli(worktree, build_init_prompt(task, context, provider), transcript,
                   timeout, model, provider=provider, effort=_planning_effort())
    ran, detail = gsd_backend.workflow_ran(worktree)

    if gsd_backend.project_initialised(worktree):
        outcome, reason = "initialised", f"created {gsd_backend.planning_dir_name()}/"
    elif run["failed"]:
        outcome, reason = "prerequisite_missing", run["failed"]
    elif run["timed_out"]:
        outcome, reason = "prerequisite_missing", f"project setup timed out after {timeout}s"
    else:
        outcome, reason = "prerequisite_missing", (
            f"project setup finished without creating "
            f"{gsd_backend.planning_dir_name()}/ ({detail})")

    return {"outcome": outcome, "plan_path": None, "questions": [], "reason": reason,
            "duration_s": run["duration_s"], "transcript_path": str(transcript),
            "gsd_ran": ran, "stage": "init"}


def run_plan_stage(worktree: str, task: Dict, context: str = "", provider: str = "", mode: str = "",
                   timeout: int = PLAN_TIMEOUT, model: str = "") -> Dict:
    """Plan in `worktree` as its own process. Assumes the GSD project exists."""
    transcript = _transcript_path(task["id"], "plan")
    # Stamped before the run so only a plan this run wrote can count. One second of
    # slack absorbs filesystem timestamp granularity.
    since = time.time() - 1
    provider = provider or _planning_provider()
    run = _run_cli(worktree, build_prompt(task, context, provider, mode), transcript,
                   timeout, model, provider=provider, effort=_planning_effort())

    if run["failed"]:
        verdict = {"outcome": "error", "plan_path": None, "questions": [],
                   "reason": run["failed"]}
    else:
        # Classify even after a timeout. A planner that emitted its question and then
        # hung has still asked it, and a plan already on disk is still a plan —
        # throwing either away because the process overran would repeat the failure
        # this whole stage replaces.
        verdict = classify(worktree, run["output"],
                           None if run["timed_out"] else run["returncode"],
                           since=since)
        if run["timed_out"] and verdict["outcome"] == "error":
            verdict["reason"] = f"planning timed out after {timeout}s"

    ran, _ = gsd_backend.workflow_ran(worktree)
    verdict.update({
        "duration_s": run["duration_s"],
        "transcript_path": str(transcript),
        # Observable, not inferred from the prompt naming a command.
        "gsd_ran": ran,
        "stage": "plan",
    })
    return verdict


def _configured_model(role: str) -> str:
    """The model MC has been told to use for a role, or "" to accept the CLI default.

    The stage used to pass no `--model` at all, so it silently ran on whatever the
    `claude` CLI defaulted to — `planning_model` in swarm-config.json had no effect,
    and the model in use would change under you if the CLI's default ever moved.
    That is the one setting Phase 0 must control: the thesis is that a strong model
    plans and a cheaper one executes, and it cannot be measured if planning's model
    is whatever happened to be default that week.
    """
    try:
        from planner import _get_config
        return str(_get_config().get(f"{role}_model", "") or "")
    except Exception:
        return ""


def plan_in_worktree(worktree: str, task: Dict, context: str = "",
                     model: str = "", provider: str = "", mode: str = "") -> Dict:
    """Get from a bare repo to a plan: initialise if needed, then plan.

    Two processes with two budgets rather than one. The init stage is skipped
    entirely when `.planning/` already exists, so a retry after a failed plan costs
    only the plan.

    The returned verdict is the one that decides what happens next; `stages` carries
    each stage's own verdict so a post-mortem can see where the time went.
    """
    stages = []
    # Explicit, so planning's model is a decision rather than a default.
    model = model or _configured_model("planning")

    provider = provider or _planning_provider()
    init = run_init_stage(worktree, task, context, provider=provider, model=model)
    stages.append(init)
    if init["outcome"] != "initialised":
        return {**init, "stages": stages}

    plan = run_plan_stage(worktree, task, context, provider=provider, model=model, mode=mode)
    stages.append(plan)
    return {**plan, "stages": stages}
