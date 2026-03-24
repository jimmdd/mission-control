#!/usr/bin/env python3
"""
Planner — Spec-driven planning layer for Mission Control.

Sits between Bridge triage and agent dispatch. Takes a triaged task,
produces a structured execution plan, then dispatches step-by-step
with precise scoped prompts.

Models:
  - Planning (structured plan generation): Claude Sonnet via Anthropic API
  - Routing (step classification): MiniMax M2.7 via Ollama (free, local)
  - Verification (did agent satisfy criteria): MiniMax M2.7 via Ollama (free, local)
"""

import json
import logging
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

PLANS_DIR = Path.home() / ".openclaw" / "bridge" / "plans"
PROGRESS_DIR = Path.home() / ".openclaw" / "bridge" / "progress"
SWARM_CONFIG_PATH = Path.home() / ".openclaw" / "swarm" / "swarm-config.json"

# Defaults — overridden by swarm-config.json "planner" section
_DEFAULTS = {
    "planning_model": "claude-sonnet-4-20250514",
    "planning_provider": "anthropic",          # anthropic | ollama | gemini
    "routing_model": "minimax-m2.7:cloud",
    "routing_provider": "ollama",
    "verification_model": "minimax-m2.7:cloud",
    "verification_provider": "ollama",
    "ollama_url": "http://localhost:11434",
    "max_step_retries": 2,
    "step_categories": {
        "deep": {"agent": "claude", "description": "Complex implementation requiring deep reasoning"},
        "quick": {"agent": "claude", "description": "Simple, scoped change"},
        "test": {"agent": "claude", "description": "Writing or fixing tests"},
        "research": {"agent": "claude", "description": "Investigation, no code changes"},
        "review": {"agent": "codex", "description": "Code review or validation"},
    },
}


def _load_config() -> dict:
    """Load planner config from swarm-config.json, merged with defaults."""
    config = dict(_DEFAULTS)
    if SWARM_CONFIG_PATH.exists():
        try:
            full = json.loads(SWARM_CONFIG_PATH.read_text())
            planner_cfg = full.get("planner", {})
            # Merge step_categories deeply
            if "step_categories" in planner_cfg:
                config["step_categories"] = {**config["step_categories"], **planner_cfg.pop("step_categories")}
            config.update(planner_cfg)
        except Exception as e:
            logging.warning(f"Failed to load planner config: {e}")
    # Env vars override config file
    for env_key, cfg_key in [
        ("OLLAMA_URL", "ollama_url"),
        ("OLLAMA_PLANNER_MODEL", "routing_model"),
        ("PLANNER_SONNET_MODEL", "planning_model"),
    ]:
        val = os.environ.get(env_key)
        if val:
            config[cfg_key] = val
    return config


def _get_config() -> dict:
    """Cached config loader (reloads each call for daemon friendliness)."""
    return _load_config()


# Legacy accessors for backward compat
def _ollama_url() -> str:
    return _get_config()["ollama_url"]


def _step_categories() -> dict:
    return _get_config()["step_categories"]


ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta"


def _call_ollama(prompt: str, model: str = "", system: str = "", max_tokens: int = 2048) -> Optional[str]:
    """Call a model via Ollama API."""
    cfg = _get_config()
    model = model or cfg["routing_model"]
    base_url = cfg["ollama_url"]

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = json.dumps({
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": max_tokens, "temperature": 0.2},
    }).encode()

    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data.get("message", {}).get("content", "")
    except Exception as e:
        logging.error(f"Ollama call failed ({model}): {e}")
        return None


def _call_anthropic(prompt: str, model: str = "", system: str = "", max_tokens: int = 4096) -> Optional[str]:
    """Call a model via Anthropic API."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        logging.error("ANTHROPIC_API_KEY not set")
        return None

    cfg = _get_config()
    model = model or cfg["planning_model"]

    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        body["system"] = system

    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        ANTHROPIC_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            content = data.get("content", [])
            if content and content[0].get("type") == "text":
                return content[0]["text"]
            return None
    except Exception as e:
        logging.error(f"Anthropic API call failed ({model}): {e}")
        return None


def _call_gemini(prompt: str, model: str = "", system: str = "", max_tokens: int = 4096) -> Optional[str]:
    """Call a model via Google Gemini API."""
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        logging.error("GOOGLE_GENERATIVE_AI_API_KEY not set")
        return None

    model = model or "gemini-2.5-flash"
    contents = [{"parts": [{"text": prompt}]}]
    body: dict = {
        "contents": contents,
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{GEMINI_API_URL}/models/{model}:generateContent?key={api_key}",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        logging.error(f"Gemini API call failed ({model}): {e}")
        return None


def _call_llm(prompt: str, role: str = "planning", system: str = "", max_tokens: int = 4096) -> Optional[str]:
    """Universal LLM caller. Routes to the right provider based on config.

    role: "planning" | "routing" | "verification" — determines which model/provider to use.
    """
    cfg = _get_config()
    model = cfg.get(f"{role}_model", cfg["planning_model"])
    provider = cfg.get(f"{role}_provider", "anthropic")

    if provider == "ollama":
        return _call_ollama(prompt, model=model, system=system, max_tokens=max_tokens)
    elif provider == "anthropic":
        return _call_anthropic(prompt, model=model, system=system, max_tokens=max_tokens)
    elif provider == "gemini":
        return _call_gemini(prompt, model=model, system=system, max_tokens=max_tokens)
    else:
        logging.error(f"Unknown provider '{provider}' for role '{role}'")
        return None


def _parse_json_response(text: Optional[str]) -> Optional[dict]:
    """Parse JSON from LLM response, stripping markdown fences."""
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logging.error(f"Failed to parse JSON: {text[:300]}")
        return None


def _parse_json_array(text: Optional[str]) -> Optional[list]:
    """Parse JSON array from LLM response."""
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        result = json.loads(text)
        return result if isinstance(result, list) else None
    except json.JSONDecodeError:
        logging.error(f"Failed to parse JSON array: {text[:300]}")
        return None


# === Plan Generation (Sonnet) ===

PLAN_SYSTEM = """You are an orchestration architect decomposing complex tasks for an AI agent swarm.

Each step you produce becomes a FULL AGENT SESSION — the agent will use GSD (a planning/execution
framework) internally to plan, implement, test, and verify its work. You are NOT writing
implementation instructions. You are defining WHAT each agent should achieve, not HOW.

Your job is coordination:
- Break cross-repo or multi-concern work into independent agent sessions
- Define clear boundaries so agents don't step on each other
- Order steps by real dependencies (data flow, API contracts, schema changes)
- Specify acceptance criteria that can be verified after each agent finishes

Rules:
- Each step = one agent session = one repo = one focused deliverable
- Steps must have acceptance criteria (done_when) that are verifiable from git diff or test output
- Only create multiple steps when there are REAL dependencies or cross-repo coordination
- A single-repo task with no sequential dependencies should be ONE step
- Include a verify_command that proves the step's acceptance criteria are met
- For multi-repo tasks, order by data flow (schema first, then API, then consumer)"""


def generate_plan(
    title: str,
    description: str,
    repos: List[dict],
    codebase_context: str = "",
    knowledge: Optional[dict] = None,
    triage_qa: str = "",
) -> Optional[dict]:
    """Generate a structured execution plan using Sonnet.

    Returns a plan dict with steps, or None on failure.
    """
    PLANS_DIR.mkdir(parents=True, exist_ok=True)

    knowledge_section = ""
    if knowledge:
        if knowledge.get("developer_notes"):
            knowledge_section += f"\n## Developer Notes\n{knowledge['developer_notes']}"
        if knowledge.get("past_learnings"):
            knowledge_section += f"\n## Past Learnings\n{knowledge['past_learnings']}"

    qa_section = ""
    if triage_qa:
        qa_section = f"\n## Triage Q&A\n{triage_qa}"

    repo_list = ", ".join(f"{r['project']}/{r['repo']}" for r in repos)

    prompt = f"""Decompose this task into agent sessions for a coding swarm.

## Task
**Title:** {title}
**Target repos:** {repo_list}

**Description:**
{description}
{qa_section}

## Codebase Context
{codebase_context[:12000] if codebase_context else "(no codebase context available)"}
{knowledge_section}

## Important
Each step becomes a FULL AUTONOMOUS AGENT SESSION. The agent will:
1. Read the codebase and understand context
2. Run /gsd:plan-phase internally to create its own detailed implementation plan
3. Run /gsd:execute-phase to implement with atomic commits
4. Run /gsd:verify-work to verify against acceptance criteria
5. Create a PR (or commit and push for intermediate steps)

You are defining WHAT each agent achieves, not the implementation details.
The agent's internal GSD planning handles the HOW.

## Output Format
Return ONLY valid JSON (no markdown fences):
{{
  "summary": "1-2 sentence summary of what this orchestration achieves",
  "total_steps": <number>,
  "estimated_complexity": "simple|moderate|complex",
  "needs_orchestration": true,
  "reasoning": "Why this needs multi-step orchestration (or why it could be single-step)",
  "steps": [
    {{
      "step": 1,
      "title": "Clear deliverable title (e.g. 'Add rate limiting middleware')",
      "description": "What this agent session should deliver. Focus on the WHAT and WHY, not implementation details. Include any cross-repo context the agent needs.",
      "repo": "project/repo",
      "acceptance_criteria": [
        "Verifiable criterion from git diff or test output",
        "e.g. 'Rate limiter returns 429 after 100 req/s per client'",
        "e.g. 'All existing tests still pass'"
      ],
      "verify_command": "npm test -- --grep 'rate-limit'",
      "depends_on": [],
      "category": "deep|quick|test|research|review",
      "context_from_prior_steps": "What this agent needs to know about completed prior steps (API contracts, schema changes, etc.)"
    }}
  ],
  "parallel_groups": [[1], [2, 3], [4]],
  "risks": ["Risk 1 and mitigation"]
}}

Rules:
- If this is a single-repo task with no sequential dependencies, use ONE step and set "needs_orchestration": false
- "depends_on" = step numbers that must finish first (real data/API dependencies, not artificial ordering)
- "category" routes to agent type: deep=complex reasoning, quick=small change, test=testing focus, research=read-only, review=validation
- "acceptance_criteria" must be verifiable from test output or git diff — these become the agent's GSD verification targets
- "verify_command" should be runnable and deterministic
- For multi-repo: split by repo, order by data flow (schema → API → consumer)
"""

    result = _call_llm(prompt, role="planning", system=PLAN_SYSTEM, max_tokens=4096)
    plan = _parse_json_response(result)

    if not plan or "steps" not in plan:
        logging.error("Sonnet failed to produce a valid plan")
        return None

    logging.info(f"  Plan generated: {plan.get('total_steps', len(plan['steps']))} steps, "
                 f"complexity={plan.get('estimated_complexity', '?')}")
    return plan


def save_plan(task_id: str, plan: dict) -> Path:
    """Save plan as both JSON (machine-readable) and markdown (human-readable)."""
    PLANS_DIR.mkdir(parents=True, exist_ok=True)

    # Save JSON
    json_path = PLANS_DIR / f"{task_id}.json"
    json_path.write_text(json.dumps(plan, indent=2))

    # Save markdown
    md_path = PLANS_DIR / f"{task_id}.md"
    lines = [
        f"# Plan: {plan.get('summary', 'Untitled')}",
        f"",
        f"**Complexity:** {plan.get('estimated_complexity', 'unknown')}",
        f"**Steps:** {plan.get('total_steps', len(plan.get('steps', [])))}",
        f"**Parallel groups:** {plan.get('parallel_groups', [])}",
        f"",
    ]

    risks = plan.get("risks", [])
    if risks:
        lines.append("## Risks")
        for risk in risks:
            lines.append(f"- {risk}")
        lines.append("")

    lines.append("## Steps")
    lines.append("")

    for step in plan.get("steps", []):
        status = "[ ]"
        lines.append(f"### {status} Step {step['step']}: {step['title']}")
        lines.append(f"**Repo:** {step.get('repo', '?')}")
        lines.append(f"**Category:** {step.get('category', '?')}")
        if step.get("depends_on"):
            lines.append(f"**Depends on:** steps {step['depends_on']}")
        lines.append("")
        lines.append(step.get("description", ""))
        lines.append("")
        lines.append("**Acceptance Criteria:**")
        for criterion in step.get("acceptance_criteria", step.get("done_when", [])):
            lines.append(f"- [ ] {criterion}")
        lines.append("")
        if step.get("verify_command"):
            lines.append(f"**Verify:** `{step['verify_command']}`")
        if step.get("notes"):
            lines.append(f"**Notes:** {step['notes']}")
        lines.append("")
        lines.append("---")
        lines.append("")

    md_path.write_text("\n".join(lines))
    logging.info(f"  Plan saved: {json_path} + {md_path}")
    return json_path


# === Step Routing ===

def classify_step(step: dict) -> str:
    """Classify step category using the configured routing model."""
    categories = _step_categories()
    if step.get("category") in categories:
        return step["category"]

    prompt = f"""Classify this task step into exactly one category.

Step: {step.get('title', '')}
Description: {step.get('description', '')[:500]}

Categories:
- deep: Complex implementation requiring deep reasoning, multi-file changes
- quick: Simple, scoped change to 1-2 files
- test: Writing or fixing tests
- research: Investigation, reading code, no changes
- review: Code review or validation

Return ONLY the category name (one word)."""

    result = _call_llm(prompt, role="routing")
    if result:
        category = result.strip().lower().rstrip(".")
        if category in categories:
            return category

    return "deep"  # default to deep for safety


# === Progress Tracking ===

def init_progress(task_id: str, plan: dict) -> dict:
    """Initialize progress tracker for a task."""
    PROGRESS_DIR.mkdir(parents=True, exist_ok=True)

    progress = {
        "task_id": task_id,
        "plan_file": str(PLANS_DIR / f"{task_id}.json"),
        "total_steps": len(plan.get("steps", [])),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "status": "in_progress",
        "current_step": None,
        "steps": {},
    }

    for step in plan.get("steps", []):
        step_num = str(step["step"])
        progress["steps"][step_num] = {
            "title": step["title"],
            "status": "pending",  # pending | in_progress | completed | failed | skipped
            "category": step.get("category", "deep"),
            "agent_id": None,
            "started_at": None,
            "completed_at": None,
            "outcome": None,
            "retry_count": 0,
        }

    progress_path = PROGRESS_DIR / f"{task_id}.json"
    progress_path.write_text(json.dumps(progress, indent=2))
    return progress


def load_progress(task_id: str) -> Optional[dict]:
    """Load progress for a task."""
    progress_path = PROGRESS_DIR / f"{task_id}.json"
    if not progress_path.exists():
        return None
    try:
        return json.loads(progress_path.read_text())
    except Exception:
        return None


def update_step_progress(task_id: str, step_num: int, updates: dict):
    """Update progress for a specific step."""
    progress = load_progress(task_id)
    if not progress:
        return

    step_key = str(step_num)
    if step_key in progress["steps"]:
        progress["steps"][step_key].update(updates)
    progress["updated_at"] = datetime.now(timezone.utc).isoformat()

    progress_path = PROGRESS_DIR / f"{task_id}.json"
    progress_path.write_text(json.dumps(progress, indent=2))


def get_next_steps(task_id: str, plan: dict) -> List[dict]:
    """Get the next executable steps based on progress and dependencies.

    Returns steps whose dependencies are all completed and that haven't started yet.
    Respects parallel_groups — returns all steps from the next runnable group.
    """
    progress = load_progress(task_id)
    if not progress:
        return []

    completed = set()
    for step_key, step_progress in progress["steps"].items():
        if step_progress["status"] == "completed":
            completed.add(int(step_key))

    in_progress = set()
    for step_key, step_progress in progress["steps"].items():
        if step_progress["status"] == "in_progress":
            in_progress.add(int(step_key))

    runnable = []
    for step in plan.get("steps", []):
        step_num = step["step"]
        if step_num in completed or step_num in in_progress:
            continue
        deps = set(step.get("depends_on", []))
        if deps.issubset(completed):
            runnable.append(step)

    return runnable


# === Structured Prompt Generation ===

def build_step_prompt(
    task: dict,
    step: dict,
    plan: dict,
    repo_context: str = "",
    knowledge: Optional[dict] = None,
    completed_steps_summary: str = "",
    is_final_step: bool = False,
) -> str:
    """Build an orchestration prompt for a single plan step.

    The agent uses GSD internally for planning and execution.
    This prompt defines WHAT to achieve, not HOW to implement it.
    """
    task_title = task.get("title", "")
    description = task.get("description", "")
    ticket_id_match = re.search(r'[A-Z]+-\d+', task_title)
    ticket_id = ticket_id_match.group(0) if ticket_id_match else "TICKET"
    mc_base = "http://localhost:18789/ext/mission-control"

    acceptance = "\n".join(
        f"- {c}" for c in step.get("acceptance_criteria", step.get("done_when", []))
    )

    context_section = ""
    if completed_steps_summary:
        context_section = f"""
## Prior Steps (already completed by other agents)
{completed_steps_summary}

Use this context to understand what has already been done. Your branch includes these changes.
"""

    cross_step_context = step.get("context_from_prior_steps", "")
    if cross_step_context:
        context_section += f"\n## Cross-Step Context\n{cross_step_context}\n"

    knowledge_section = ""
    if knowledge:
        if knowledge.get("developer_notes"):
            knowledge_section += f"\n## Developer Notes (MUST FOLLOW)\n{knowledge['developer_notes']}\n"
        if knowledge.get("past_learnings"):
            knowledge_section += f"\n## Past Learnings\n{knowledge['past_learnings']}\n"

    linear_url = task.get("external_url") or task.get("linear_issue_url", "")
    linear_section = f"\nLinear ticket: {linear_url}\n" if linear_url else ""

    # Final step creates the PR; intermediate steps just commit and push
    if is_final_step:
        completion_section = f"""
## Mandatory Workflow (GSD)

You MUST follow this exact workflow. Do NOT skip steps. Do NOT write code before planning.

### Step 1: Plan
Run `/gsd:plan-phase --prd` (or `/gsd:new-project --auto` for greenfield).
This creates PLAN.md with task breakdown, must-haves, and verification criteria.
Your GSD plan MUST target these acceptance criteria — they are your definition of done.

### Step 2: Execute
Run `/gsd:execute-phase` to implement with atomic commits.

### Step 3: Verify
Run `/gsd:verify-work` to verify against acceptance criteria.
Also run: `{step.get('verify_command', 'npm test')}`
Do NOT proceed until verification passes.

### Step 4: Gap Closure (if needed)
If VERIFICATION.md shows `status: gaps_found`, run `/gsd:plan-phase --gaps`.
Repeat until `status: passed`.

### Step 5: Pre-PR Validation
Check `.github/workflows/` for CI config. Run equivalent checks locally.
Do NOT create a PR until all checks pass.

### Step 6: PR + Report
1. Push your branch
2. Create PR with `gh pr create` — title MUST start with `[{ticket_id}]`
3. Report to Mission Control:
   curl -X POST {mc_base}/api/webhooks/agent-completion \\
     -H "Content-Type: application/json" \\
     -d '{{"task_id": "{task.get('id', 'TASK_ID')}", "summary": "YOUR_SUMMARY"}}'
"""
    else:
        completion_section = f"""
## Mandatory Workflow (GSD)

You MUST follow this exact workflow. Do NOT skip steps. Do NOT write code before planning.

### Step 1: Plan
Run `/gsd:plan-phase --prd` (or `/gsd:new-project --auto` for greenfield).
This creates PLAN.md with task breakdown, must-haves, and verification criteria.
Your GSD plan MUST target these acceptance criteria — they are your definition of done.

### Step 2: Execute
Run `/gsd:execute-phase` to implement with atomic commits.

### Step 3: Verify
Run `/gsd:verify-work` to verify against acceptance criteria.
Also run: `{step.get('verify_command', 'npm test')}`
Do NOT proceed until verification passes.

### Step 4: Gap Closure (if needed)
If VERIFICATION.md shows `status: gaps_found`, run `/gsd:plan-phase --gaps`.
Repeat until `status: passed`.

### Step 5: Commit + Push (NO PR)
This is step {step['step']} of {plan.get('total_steps', '?')} — an intermediate step.
Do NOT create a PR. Just commit with conventional commits and push your branch.
The orchestrator will chain the next step on your branch.

Report completion:
curl -X POST {mc_base}/api/tasks/{task.get('id', 'TASK_ID')}/activities \\
  -H "Content-Type: application/json" \\
  -d '{{"activity_type": "step_completed", "message": "Step {step['step']} complete: {step['title']}"}}'
"""

    prompt = f"""# Task: {task_title}
## Orchestration Step {step['step']} of {plan.get('total_steps', '?')} — {step['title']}

## Context
{description}
{linear_section}
## Your Mission
{step.get('description', '')}

## Acceptance Criteria (your definition of done)
{acceptance}

## Verification Command
`{step.get('verify_command', 'npm test')}`

## Codebase Info
{repo_context if repo_context else "(explore the codebase as part of your GSD planning step)"}
{context_section}{knowledge_section}
## Constraints
- Do NOT modify files unrelated to this step's acceptance criteria
- Do NOT add dependencies without justification
- Follow existing code patterns and conventions
- Commit messages: conventional commits format
- PR title (if creating PR) MUST start with `[{ticket_id}]`
{completion_section}
You MUST complete all steps autonomously. Do NOT ask for confirmation. Do NOT stop before finishing.
"""
    return prompt


# === Step Verification (MiniMax via Ollama — free) ===

def verify_step_completion(step: dict, agent_output: str) -> dict:
    """Use local MiniMax to verify if a step's DONE WHEN criteria are met.

    Returns: {"passed": bool, "results": [{"criterion": str, "met": bool, "reason": str}]}
    """
    criteria = step.get("acceptance_criteria", step.get("done_when", []))
    if not criteria:
        return {"passed": True, "results": []}

    criteria_text = "\n".join(f"- {c}" for c in criteria)

    prompt = f"""Evaluate whether each criterion is met based on the agent's output.

## Step: {step.get('title', '')}

## Criteria
{criteria_text}

## Agent Output (last 3000 chars)
{agent_output[-3000:]}

Return ONLY valid JSON:
{{
  "passed": true/false,
  "results": [
    {{"criterion": "criterion text", "met": true/false, "reason": "why"}}
  ]
}}

"passed" is true ONLY if ALL criteria are met."""

    result = _call_llm(prompt, role="verification", max_tokens=2048)
    parsed = _parse_json_response(result)

    if parsed and "passed" in parsed:
        return parsed

    return {"passed": False, "results": [{"criterion": "verification", "met": False, "reason": "Verification call failed"}]}


# === Plan Completion Summary ===

def get_completed_steps_summary(task_id: str, plan: dict) -> str:
    """Build a brief summary of completed steps for context injection."""
    progress = load_progress(task_id)
    if not progress:
        return ""

    lines = []
    for step in plan.get("steps", []):
        step_key = str(step["step"])
        step_progress = progress["steps"].get(step_key, {})
        if step_progress.get("status") == "completed":
            outcome = step_progress.get("outcome", "done")
            lines.append(f"- Step {step['step']}: {step['title']} — {outcome}")

    return "\n".join(lines) if lines else ""


def is_plan_complete(task_id: str) -> bool:
    """Check if all steps in a plan are completed."""
    progress = load_progress(task_id)
    if not progress:
        return False

    for step_progress in progress["steps"].values():
        if step_progress["status"] not in ("completed", "skipped"):
            return False
    return True
