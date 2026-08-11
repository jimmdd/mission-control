#!/usr/bin/env python3
"""
Planner — Spec-driven planning layer for Mission Control.

Sits between Bridge triage and agent dispatch. Takes a triaged task,
produces a structured execution plan, then dispatches step-by-step
with precise scoped prompts.

Models:
  - Planning (structured plan generation): Claude Sonnet via Anthropic API
  - Routing (step classification): MiniMax M2.7 via Ollama (free, local)
  - Verification (did agent satisfy criteria): the step's own verify_command,
    judged by exit code. No model is involved unless the step has no runnable
    command, in which case MiniMax M2.7 via Ollama judges the agent's output.
"""

import fcntl
import json
import logging
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from gsd_backend import (
    backend_label,
    execute_command as gsd_execute_command,
    gap_plan_command as gsd_gap_plan_command,
    plan_command as gsd_plan_command,
    verify_command as gsd_verify_command,
)

MC_HOME = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))
PLANS_DIR = MC_HOME / "bridge" / "plans"
PROGRESS_DIR = MC_HOME / "bridge" / "progress"
SWARM_CONFIG_PATH = MC_HOME / "swarm" / "swarm-config.json"

# Defaults — overridden by swarm-config.json "planner" section
_DEFAULTS = {
    "planning_model": "claude-sonnet-4-20250514",
    "planning_provider": "anthropic",          # anthropic | ollama | gemini
    "routing_model": "minimax-m2.7:cloud",
    "routing_provider": "ollama",
    "verification_model": "minimax-m2.7:cloud",
    "verification_provider": "ollama",
    # Autopilot roles — small/fast/cheap by default ("explore needs speed,
    # not intelligence"). Override per-role in swarm-config.json "planner".
    "scope_model": "gemini-2.5-flash",
    "scope_provider": "gemini",
    "explore_model": "gemini-2.5-flash",
    "explore_provider": "gemini",
    "synthesize_model": "gemini-2.5-flash",
    "synthesize_provider": "gemini",
    "gapcheck_model": "gemini-2.5-flash",
    "gapcheck_provider": "gemini",
    "ollama_url": "http://localhost:11434",
    "max_step_retries": 2,
    # Ceiling on agent sessions running at once across every profile. Each one is a
    # worktree plus a CLI process, so the limit is machine memory, not quota — on a
    # 24 GB box 2 is the working number. 0 means no global ceiling (per-profile
    # maxAgents in spawn-agent.sh still applies).
    "max_concurrent_agents": 0,
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
    # spawn-agent.sh reads the same env var, so one export caps both layers.
    cap = os.environ.get("MC_MAX_CONCURRENT_AGENTS")
    if cap:
        try:
            config["max_concurrent_agents"] = max(0, int(cap))
        except ValueError:
            logging.warning(f"Ignoring non-numeric MC_MAX_CONCURRENT_AGENTS={cap!r}")
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
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Transient/rate-limit HTTP codes worth retrying before giving up on a provider.
_RETRYABLE_HTTP = {408, 429, 500, 502, 503, 504}


def _post_json_with_retry(req, *, timeout: int = 120, label: str = "LLM",
                          max_retries: int = 3, base_delay: float = 2.0) -> Optional[dict]:
    """POST a urllib Request with exponential backoff on rate-limit/transient
    errors (so we exhaust the free provider before falling back). Returns the
    parsed JSON dict, or None once retries are spent (caller then falls back)."""
    delay = base_delay
    for attempt in range(max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            retryable = e.code in _RETRYABLE_HTTP
            if retryable and attempt < max_retries:
                logging.warning(f"{label} HTTP {e.code} — retry {attempt + 1}/{max_retries} in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            logging.error(f"{label} HTTP {e.code}: {e}")
            return None
        except Exception as e:  # timeouts, connection resets, etc.
            if attempt < max_retries:
                logging.warning(f"{label} error ({e}) — retry {attempt + 1}/{max_retries} in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            logging.error(f"{label} failed: {e}")
            return None
    return None


def _call_openrouter(prompt: str, model: str = "", system: str = "", max_tokens: int = 4096) -> Optional[str]:
    """Call a model via OpenRouter (OpenAI-compatible chat completions API)."""
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        logging.error("OPENROUTER_API_KEY not set")
        return None

    cfg = _get_config()
    model = model or cfg["planning_model"]

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }).encode()

    req = urllib.request.Request(
        OPENROUTER_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://github.com/jimmdd/mission-control",
            "X-Title": "Mission Control",
        },
    )

    data = _post_json_with_retry(req, label=f"OpenRouter ({model})")
    if data is None:
        return None
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        logging.error(f"OpenRouter ({model}) unexpected response shape: {e}")
        return None


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
        f"{GEMINI_API_URL}/models/{model}:generateContent",
        data=payload,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
    )

    data = _post_json_with_retry(req, label=f"Gemini ({model})")
    if data is None:
        return None
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        logging.error(f"Gemini ({model}) unexpected response shape: {e}")
        return None


def _load_fallback_config() -> dict:
    """Top-level `llm_fallback` block from swarm-config.json.

    Default: enabled, route failed primary calls through OpenRouter using
    google/gemini-2.5-flash. Set {"enabled": false} to turn the safety net off.
    """
    cfg = {"enabled": True, "model": "google/gemini-2.5-flash"}
    if SWARM_CONFIG_PATH.exists():
        try:
            full = json.loads(SWARM_CONFIG_PATH.read_text())
            cfg.update(full.get("llm_fallback", {}))
        except Exception:
            pass
    return cfg


def _to_openrouter_model(model: str) -> str:
    """Best-effort map a bare provider model name to an OpenRouter slug."""
    if not model or "/" in model:
        return model
    m = model.lower()
    if m.startswith("gemini"):
        return f"google/{model}"
    if m.startswith("claude"):
        return f"anthropic/{model}"
    if m.startswith(("gpt", "o1", "o3", "o4")):
        return f"openai/{model}"
    return model


def call_openrouter_fallback(prompt: str, model: str = "", system: str = "", max_tokens: int = 4096) -> Optional[str]:
    """Retry a failed primary LLM call via OpenRouter — the universal backup.

    Returns None when the fallback is disabled or no OPENROUTER_API_KEY is set,
    so callers can treat None as "no result". `model` is the primary model name;
    it is mapped to an OpenRouter slug, else the configured default is used.
    """
    fb = _load_fallback_config()
    if not fb.get("enabled", True):
        return None
    if not os.environ.get("OPENROUTER_API_KEY"):
        return None
    fb_model = _to_openrouter_model(model) or fb.get("model", "google/gemini-2.5-flash")
    logging.warning(f"Primary LLM call failed — falling back to OpenRouter ({fb_model})")
    return _call_openrouter(prompt, model=fb_model, system=system, max_tokens=max_tokens)


def _call_llm(prompt: str, role: str = "planning", system: str = "", max_tokens: int = 4096) -> Optional[str]:
    """Universal LLM caller. Routes to the right provider based on config.

    role: "planning" | "routing" | "verification" — determines which model/provider to use.
    Falls back to OpenRouter when the configured provider fails (see llm_fallback).
    """
    cfg = _get_config()
    model = cfg.get(f"{role}_model", cfg["planning_model"])
    provider = cfg.get(f"{role}_provider", "anthropic")

    if provider == "ollama":
        result = _call_ollama(prompt, model=model, system=system, max_tokens=max_tokens)
    elif provider == "anthropic":
        result = _call_anthropic(prompt, model=model, system=system, max_tokens=max_tokens)
    elif provider == "gemini":
        result = _call_gemini(prompt, model=model, system=system, max_tokens=max_tokens)
    elif provider == "openrouter":
        result = _call_openrouter(prompt, model=model, system=system, max_tokens=max_tokens)
    else:
        logging.error(f"Unknown provider '{provider}' for role '{role}'")
        return None

    # Auto-fallback to OpenRouter when the primary provider returned nothing.
    if result is None and provider != "openrouter":
        fb = call_openrouter_fallback(prompt, model=model, system=system, max_tokens=max_tokens)
        if fb is not None:
            return fb
    return result


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

Each step you produce becomes a FULL AGENT SESSION — the agent will use GSD Core (a planning/execution
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
2. Run the configured GSD Core planning command internally to create its own detailed implementation plan
3. Run the configured GSD Core execution command to implement with atomic commits
4. Run the configured GSD Core verification command to verify against acceptance criteria
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

def _write_progress(progress_path: Path, progress: dict):
    """Replace the progress file in one step, so a concurrent reader sees either
    the old file or the new one and never a half-written one."""
    tmp = progress_path.with_suffix(f".json.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(progress, indent=2))
    os.replace(tmp, progress_path)


@contextmanager
def _progress_lock(task_id: str):
    """Hold the task's progress file for a read-modify-write.

    Steps finish independently, and two of them updating their own entries at once
    would otherwise each write back a copy of the file read before the other's
    change — losing one step's result. Same `flock` approach as swarm-state.py.
    """
    PROGRESS_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = PROGRESS_DIR / f"{task_id}.lock"
    with lock_path.open("a+") as fd:
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fd.fileno(), fcntl.LOCK_UN)


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
    with _progress_lock(task_id):
        _write_progress(progress_path, progress)
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
    """Update progress for a specific step.

    The whole read-modify-write is held under the task's lock — the file carries
    every step, so an unlocked update loses whatever a concurrent step wrote.
    """
    progress_path = PROGRESS_DIR / f"{task_id}.json"
    with _progress_lock(task_id):
        progress = load_progress(task_id)
        if not progress:
            return

        step_key = str(step_num)
        if step_key in progress["steps"]:
            progress["steps"][step_key].update(updates)
        progress["updated_at"] = datetime.now(timezone.utc).isoformat()

        _write_progress(progress_path, progress)


def _active_group(plan: dict, settled: set) -> Optional[set]:
    """Step numbers in the earliest `parallel_groups` entry that isn't finished yet.

    Groups run in sequence; steps inside one may run together. `settled` is the set
    of steps that will never run again (completed, failed or skipped) — a group is
    done once every step in it is settled.

    Returns None when the plan has no usable grouping, so the caller falls back to
    dependency order alone. A group that doesn't cover every step is treated as
    unusable rather than partially applied: silently withholding an uncovered step
    would stall the plan with no visible cause.
    """
    groups = plan.get("parallel_groups")
    if not isinstance(groups, list) or not groups:
        return None

    covered = set()
    parsed = []
    for group in groups:
        if not isinstance(group, list):
            logging.warning("  Ignoring parallel_groups — not a list of lists")
            return None
        nums = {n for n in group if isinstance(n, int)}
        covered |= nums
        parsed.append(nums)

    all_steps = {s["step"] for s in plan.get("steps", []) if isinstance(s.get("step"), int)}
    missing = all_steps - covered
    if missing:
        logging.warning(
            f"  Ignoring parallel_groups — steps {sorted(missing)} appear in no group"
        )
        return None

    for nums in parsed:
        if nums and not nums.issubset(settled):
            return nums
    return None


def get_next_steps(task_id: str, plan: dict) -> List[dict]:
    """Get the next executable steps based on progress and dependencies.

    Returns steps whose dependencies are all completed and that haven't started yet,
    narrowed to the plan's current `parallel_groups` entry when the plan has one.
    Groups are the planner's statement about which steps may safely touch the repo
    at the same time — dependencies alone don't capture file overlap.
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

    # Permanently-failed steps must NOT be re-offered — a failed step with no deps
    # otherwise passes `deps ⊆ completed` and gets re-dispatched forever. (Retries use
    # status "pending", not "failed", so they still return here.)
    failed = set()
    for step_key, step_progress in progress["steps"].items():
        if step_progress["status"] == "failed":
            failed.add(int(step_key))

    skipped = set()
    for step_key, step_progress in progress["steps"].items():
        if step_progress["status"] == "skipped":
            skipped.add(int(step_key))

    group = _active_group(plan, completed | failed | skipped)

    runnable = []
    for step in plan.get("steps", []):
        step_num = step["step"]
        if step_num in completed or step_num in in_progress or step_num in failed:
            continue
        if group is not None and step_num not in group:
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

    The agent uses GSD Core internally for planning and execution.
    This prompt defines WHAT to achieve, not HOW to implement it.
    """
    task_title = task.get("title", "")
    description = task.get("description", "")
    ticket_id_match = re.search(r'[A-Z]+-\d+', task_title)
    ticket_id = ticket_id_match.group(0) if ticket_id_match else "TICKET"
    mc_base = os.environ.get("MISSION_CONTROL_URL", "http://localhost:18900")

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

    external_url = task.get("external_url") or task.get("linear_issue_url", "")
    external_section = f"\nExternal reference: {external_url}\n" if external_url else ""
    gsd_name = backend_label()
    gsd_plan = gsd_plan_command()
    gsd_new_project = gsd_plan_command(greenfield=True)
    gsd_execute = gsd_execute_command()
    gsd_verify = gsd_verify_command()
    gsd_gap = gsd_gap_plan_command()

    # Final step creates the PR; intermediate steps just commit and push
    if is_final_step:
        completion_section = f"""
## Mandatory Workflow ({gsd_name})

You MUST follow this exact workflow. Do NOT skip steps. Do NOT write code before planning.

### Step 1: Plan
Run `{gsd_plan}` (or `{gsd_new_project}` for greenfield).
This creates PLAN.md with task breakdown, must-haves, and verification criteria.
Your GSD plan MUST target these acceptance criteria — they are your definition of done.

### Step 2: Execute
Run `{gsd_execute}` to implement with atomic commits.

### Step 3: Verify
Run `{gsd_verify}` to verify against acceptance criteria.
Also run: `{step.get('verify_command', 'npm test')}`
Do NOT proceed until verification passes.

### Step 4: Gap Closure (if needed)
If VERIFICATION.md shows `status: gaps_found`, run `{gsd_gap}`.
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
## Mandatory Workflow ({gsd_name})

You MUST follow this exact workflow. Do NOT skip steps. Do NOT write code before planning.

### Step 1: Plan
Run `{gsd_plan}` (or `{gsd_new_project}` for greenfield).
This creates PLAN.md with task breakdown, must-haves, and verification criteria.
Your GSD plan MUST target these acceptance criteria — they are your definition of done.

### Step 2: Execute
Run `{gsd_execute}` to implement with atomic commits.

### Step 3: Verify
Run `{gsd_verify}` to verify against acceptance criteria.
Also run: `{step.get('verify_command', 'npm test')}`
Do NOT proceed until verification passes.

### Step 4: Gap Closure (if needed)
If VERIFICATION.md shows `status: gaps_found`, run `{gsd_gap}`.
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
{external_section}
## Your Mission
{step.get('description', '')}

## Acceptance Criteria (your definition of done)
{acceptance}

## Verification Command
`{step.get('verify_command', 'npm test')}`

## Codebase Info
{repo_context if repo_context else f"(explore the codebase as part of your {gsd_name} planning step)"}
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

def _verify_timeout() -> int:
    """Seconds a verify_command may run before it is treated as failed."""
    raw = _get_config().get("verify_timeout", 600)
    try:
        return max(10, min(int(raw), 3600))
    except (TypeError, ValueError):
        return 600


def _verify_by_command(command: str, cwd: str, criteria: List[str]) -> Optional[dict]:
    """Run the step's verify_command and judge by exit code.

    Returns the usual verification dict, or None if the command could not be
    run at all (missing cwd, spawn failure) so the caller can fall back.
    """
    workdir = Path(cwd)
    if not workdir.is_dir():
        logging.warning(f"  verify_command skipped — no such worktree: {cwd}")
        return None

    timeout = _verify_timeout()
    logging.info(f"  Verifying by command in {workdir.name}: {command}")
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "verified_by": "command",
            "command": command,
            "exit_code": None,
            "results": [
                {"criterion": c, "met": False, "reason": f"verify_command timed out after {timeout}s"}
                for c in criteria
            ],
        }
    except OSError as e:
        logging.warning(f"  verify_command could not be started: {e}")
        return None

    passed = proc.returncode == 0
    tail = (proc.stdout or "")[-1500:] + (proc.stderr or "")[-1500:]
    reason = "verify_command exited 0" if passed else (
        f"verify_command exited {proc.returncode}\n{tail.strip()[-800:]}"
    )
    logging.info(f"  Verify {'passed' if passed else 'FAILED'} (exit {proc.returncode})")

    # The command is the whole gate: it either proves the criteria or it doesn't.
    # Per-criterion attribution isn't available from an exit code, so every
    # criterion carries the same verdict rather than inventing a breakdown.
    return {
        "passed": passed,
        "verified_by": "command",
        "command": command,
        "exit_code": proc.returncode,
        "output_tail": tail[-2000:],
        "results": [{"criterion": c, "met": passed, "reason": reason} for c in criteria],
    }


def verify_step_completion(step: dict, agent_output: str, cwd: Optional[str] = None) -> dict:
    """Verify a step's acceptance criteria.

    Runs the step's `verify_command` and judges by exit code — deterministic,
    with no model in the loop. Falls back to an LLM judge over the agent's
    output only when there is no runnable command (no `verify_command`, or no
    worktree to run it in).

    Returns: {"passed": bool, "results": [{"criterion": str, "met": bool, "reason": str}]}
    """
    criteria = step.get("acceptance_criteria", step.get("done_when", []))
    if not criteria:
        return {"passed": True, "results": []}

    command = (step.get("verify_command") or "").strip()
    if command and cwd:
        by_command = _verify_by_command(command, cwd, criteria)
        if by_command is not None:
            return by_command

    if not agent_output:
        # No command to run and no output to judge. Failing closed is deliberate:
        # a step with acceptance criteria must not be marked done unverified.
        logging.warning("  Cannot verify — no verify_command and no agent output")
        return {
            "passed": False,
            "verified_by": "none",
            "results": [
                {"criterion": c, "met": False,
                 "reason": "Could not verify: step has no verify_command and the agent produced no output"}
                for c in criteria
            ],
        }

    logging.info("  No runnable verify_command — falling back to model judgement")
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
        parsed["verified_by"] = "model"
        return parsed

    return {
        "passed": False,
        "verified_by": "model",
        "results": [{"criterion": "verification", "met": False, "reason": "Verification call failed"}],
    }


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
