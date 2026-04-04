#!/usr/bin/env python3
"""
Swarm Bridge — Orchestrator Glue

Picks tasks from Mission Control, triages them (detailed vs vague),
generates repo-aware prompts using librarian indexes, spawns agents,
and manages the full task lifecycle.

Run modes:
  python3 bridge.py              # Process next inbox task
  python3 bridge.py --daemon      # Loop every 60s
  python3 bridge.py --task <id>   # Process specific task
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from planner import (
    generate_plan, save_plan, init_progress, load_progress,
    update_step_progress, get_next_steps, build_step_prompt,
    get_completed_steps_summary, is_plan_complete, classify_step,
    _get_config as get_planner_config,
)

MC_BASE_URL = os.environ.get("MISSION_CONTROL_URL", "http://localhost:18789/ext/mission-control")
ENV_FILE = Path.home() / ".openclaw" / ".env"
LIBRARIAN_DIR = Path.home() / ".openclaw" / "librarian"
SWARM_DIR = Path.home() / ".openclaw" / "swarm"
BRIDGE_DIR = Path.home() / ".openclaw" / "bridge"
GITPROJECTS_DIR = Path.home() / "GitProjects"
LOG_DIR = BRIDGE_DIR / "logs"

TRIAGE_THRESHOLD_CHARS = 100
NOTION_API_URL = "https://api.notion.com/v1"
NOTION_URL_PATTERN = r'https?://(?:www\.)?notion\.(?:so|site)/[^\s)>\]]+' 
import re


def resolve_notion_urls(text: str) -> str:
    """Detect Notion URLs in text and append fetched page content."""
    notion_token = os.environ.get("NOTION_TOKEN", "")
    if not notion_token:
        return text

    urls = re.findall(NOTION_URL_PATTERN, text)
    if not urls:
        return text

    appended: List[str] = []
    for url in urls[:3]:
        page_id_match = re.search(r'([a-f0-9]{32}|[a-f0-9-]{36})(?:\?|$)', url)
        if not page_id_match:
            continue

        page_id = page_id_match.group(1).replace("-", "")
        content = _fetch_notion_page(page_id, notion_token)
        if content:
            appended.append(f"\n---\n**Notion page content** ({url}):\n\n{content}\n---")
            logging.info(f"  Resolved Notion URL: {url} ({len(content)} chars)")

    if appended:
        return text + "\n".join(appended)
    return text


def _fetch_notion_page(page_id: str, token: str) -> Optional[str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
    }

    try:
        req = urllib.request.Request(
            f"{NOTION_API_URL}/pages/{page_id}",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            page = json.loads(resp.read())

        title = "Untitled"
        props = page.get("properties", {})
        for prop in props.values():
            if prop.get("type") == "title":
                title = "".join(t.get("plain_text", "") for t in prop.get("title", []))
                break

        req = urllib.request.Request(
            f"{NOTION_API_URL}/blocks/{page_id}/children?page_size=100",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            blocks = json.loads(resp.read())

        lines = [f"# {title}\n"]
        for block in blocks.get("results", []):
            btype = block.get("type", "")
            content = block.get(btype, {})
            rich_text = content.get("rich_text", [])
            text = "".join(t.get("plain_text", "") for t in rich_text)

            if btype.startswith("heading_"):
                level = "#" * (int(btype[-1]) + 1)
                lines.append(f"\n{level} {text}")
            elif btype == "bulleted_list_item":
                lines.append(f"• {text}")
            elif btype == "numbered_list_item":
                lines.append(f"1. {text}")
            elif btype == "to_do":
                mark = "☑" if content.get("checked") else "☐"
                lines.append(f"{mark} {text}")
            elif btype == "code":
                lines.append(f"```{content.get('language', '')}\n{text}\n```")
            elif btype in ("quote", "callout"):
                lines.append(f"> {text}")
            elif btype == "divider":
                lines.append("---")
            elif text:
                lines.append(text)

        return "\n".join(lines)[:8000]
    except Exception as e:
        logging.warning(f"  Failed to fetch Notion page {page_id}: {e}")
        return None


def setup_logging():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / f"bridge-{datetime.now().strftime('%Y%m%d')}.log"
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(message)s",
        datefmt="%H:%M:%S",
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(sys.stdout),
        ],
    )


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip()
                if key and not os.environ.get(key):
                    os.environ[key] = value


# === API Helpers ===

def mc_request(method: str, path: str, body: Optional[dict] = None):
    url = f"{MC_BASE_URL}{path}"
    payload = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url, data=payload, method=method,
        headers={"Content-Type": "application/json"} if payload else {},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def mc_update_task(task_id: str, updates: dict):
    mc_request("PATCH", f"/api/tasks/{task_id}", updates)


def mc_log_activity(task_id: str, activity_type: str, message: str, agent_id: Optional[str] = None):
    body = {"activity_type": activity_type, "message": message}
    if agent_id:
        body["agent_id"] = agent_id
    mc_request("POST", f"/api/tasks/{task_id}/activities", body)


def mc_add_deliverable(task_id: str, dtype: str, title: str, path: str = "", description: str = ""):
    body = {"deliverable_type": dtype, "title": title}
    if path:
        body["path"] = path
    if description:
        body["description"] = description
    mc_request("POST", f"/api/tasks/{task_id}/deliverables", body)


_GSD_ARTIFACTS = [
    ("PLAN.md", "gsd-plan", "GSD Plan"),
    ("VERIFICATION.md", "gsd-verification", "GSD Verification"),
    ("PRD.md", "gsd-prd", "PRD"),
]


def _post_gsd_artifacts(task_id: str, worktree_paths: List[str]):
    """Post GSD artifact files from worktrees as task deliverables."""
    seen = set()  # avoid duplicates if multiple steps share a worktree
    for wt in worktree_paths:
        wt_path = Path(wt)
        if not wt_path.exists() or wt in seen:
            continue
        seen.add(wt)
        for filename, dtype, default_title in _GSD_ARTIFACTS:
            artifact = wt_path / filename
            if not artifact.exists():
                continue
            try:
                content = artifact.read_text()
                # Extract title from first heading line
                title = default_title
                for line in content.splitlines():
                    line = line.strip()
                    if line.startswith("# "):
                        title = line.lstrip("# ").strip()
                        break
                mc_add_deliverable(task_id, dtype, title, path=str(artifact), description=content)
                logging.info(f"  Posted {filename} as deliverable for {task_id[:8]}")
            except Exception as e:
                logging.warning(f"  Failed to post {filename} for {task_id[:8]}: {e}")


SWARM_CONFIG_PATH = Path.home() / ".openclaw" / "swarm" / "swarm-config.json"


def _load_triage_config() -> dict:
    """Load triage model config from swarm-config.json."""
    defaults = {
        "triage_model": "gemini-2.5-flash",
        "triage_model_deep": "gemini-2.5-pro",
        "embedding_model": "gemini-embedding-001",
    }
    if SWARM_CONFIG_PATH.exists():
        try:
            full = json.loads(SWARM_CONFIG_PATH.read_text())
            triage_cfg = full.get("triage", {})
            defaults.update(triage_cfg)
        except Exception:
            pass
    return defaults


def _triage_model() -> str:
    return _load_triage_config()["triage_model"]


def _triage_model_deep() -> str:
    return _load_triage_config()["triage_model_deep"]


CONTEXT_FABRICA_DSN = os.environ.get("CONTEXT_FABRICA_DSN", "postgresql://mm@localhost/context_fabrica")

from context_fabrica.storage import PostgresPgvectorAdapter
from context_fabrica.config import PostgresSettings

_pg_settings = PostgresSettings(dsn=CONTEXT_FABRICA_DSN, embedding_dimensions=3072)
_triage_cfg = _load_triage_config()
EMBEDDING_MODEL = _triage_cfg["embedding_model"]
EMBEDDING_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBEDDING_MODEL}:embedContent"
KNOWLEDGE_MAX_RESULTS = 5
KNOWLEDGE_MAX_CHARS = 2000


def _embed_query(text: str) -> Optional[List[float]]:
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        return None
    try:
        payload = json.dumps({
            "model": f"models/{EMBEDDING_MODEL}",
            "content": {"parts": [{"text": text}]},
        }).encode()
        req = urllib.request.Request(
            f"{EMBEDDING_URL}?key={api_key}",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        return data["embedding"]["values"]
    except Exception as e:
        logging.warning(f"Embedding query failed: {e}")
        return None


def _parse_source(row: dict) -> str:
    """Extract source from metadata JSON, defaulting to 'auto'."""
    try:
        meta = json.loads(row.get("metadata", "{}") or "{}")
        return meta.get("source", "auto")
    except (json.JSONDecodeError, TypeError):
        return "auto"


def recall_knowledge(repos: List[dict], query: str, top_k: int = KNOWLEDGE_MAX_RESULTS) -> dict:
    """Query context-fabrica (PostgreSQL) for past learnings relevant to the given repos and query.

    Returns a dict with keys:
      - developer_notes: str — human-injected knowledge (always surfaces, priority boost)
      - skills: str — procedural skills (structured how-to procedures)
      - past_learnings: str — auto-distilled atomic facts
      - recalled_ids: list — IDs of recalled entries (for feedback tracking)

    Uses progressive disclosure: skills get full content, facts get one-liners.
    Feedback-aware scoring: entries that helped past tasks score higher.
    """
    empty = {"developer_notes": "", "skills": "", "past_learnings": "", "recalled_ids": []}

    vector = _embed_query(query)
    if not vector:
        return empty

    # Query context-fabrica via PostgresPgvectorAdapter
    try:
        adapter = PostgresPgvectorAdapter(_pg_settings)
        domains = set()
        for r in repos:
            domains.add(f"{r['project']}/{r['repo']}")
            domains.add(r['project'])
        domains.add("global")

        all_results = []
        for domain in domains:
            results = adapter.semantic_search(vector, domain=domain, top_k=top_k * 2)
            all_results.extend(results)
    except Exception as e:
        logging.warning(f"Knowledge recall query failed: {e}")
        return empty

    if not all_results:
        return empty

    # Transform QueryResult objects into dict format for scoring
    rows = []
    for qr in all_results:
        rec = qr.record
        rows.append({
            "id": rec.record_id,
            "text": rec.text,
            "scope": rec.metadata.get("original_scope", f"repo:{rec.domain}"),
            "category": rec.kind,
            "importance": round(rec.confidence * 5),
            "_distance": 1.0 - qr.semantic_score,  # convert similarity to distance
            "metadata": json.dumps(rec.metadata) if isinstance(rec.metadata, dict) else str(rec.metadata),
        })

    # Categorize and score results
    human_entries = []
    skill_entries = []
    fact_entries = []

    for row in rows:
        importance = row.get("importance", 3)
        dist = row.get("_distance", 1.0)
        source = _parse_source(row)
        category = row.get("category", "")
        is_human = source in ("human", "manual", "gateway")

        # Feedback-aware scoring: entries that helped before score higher
        meta = {}
        try:
            meta = json.loads(row.get("metadata", "{}") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass

        recall_count = meta.get("recall_count", 0)
        helped_count = meta.get("helped_count", 0)
        # Help ratio boost: if recalled 5 times and helped 4, that's 80% — big boost
        help_boost = 1.0
        if recall_count > 0:
            help_ratio = helped_count / recall_count
            help_boost = 1.0 + (help_ratio * 0.5)  # up to 1.5x boost

        source_boost = 1.5 if is_human else 1.0
        score = (1.0 / (1.0 + dist)) * (importance / 5.0) * source_boost * help_boost

        if is_human:
            human_entries.append((score, row))
        elif category == "skill":
            skill_entries.append((score, row))
        else:
            fact_entries.append((score, row))

    human_entries.sort(key=lambda x: -x[0])
    skill_entries.sort(key=lambda x: -x[0])
    fact_entries.sort(key=lambda x: -x[0])

    recalled_ids = []

    # Developer notes (human-injected, always surface)
    dev_lines = []
    dev_chars = 0
    for score, row in human_entries[:top_k]:
        text = row.get("text", "")
        scope = row.get("scope", "")
        entry = f"- ({scope}) {text}"
        if dev_chars + len(entry) > KNOWLEDGE_MAX_CHARS:
            break
        dev_lines.append(entry)
        dev_chars += len(entry)
        recalled_ids.append(row.get("id", ""))

    # Skills — full content (progressive disclosure: these are worth the tokens)
    skill_lines = []
    skill_chars = 0
    SKILL_MAX_CHARS = 3000
    for score, row in skill_entries[:3]:  # max 3 skills
        text = row.get("text", "")
        if skill_chars + len(text) > SKILL_MAX_CHARS:
            # Progressive disclosure level 2: just the title + summary
            lines = text.split("\n")
            title = lines[0] if lines else "Skill"
            summary = ""
            for line in lines[1:5]:
                if line.strip() and not line.startswith("#"):
                    summary = line.strip()
                    break
            entry = f"{title}\n{summary}\n(full skill available — {len(text)} chars)"
            skill_lines.append(entry)
        else:
            skill_lines.append(text)
        skill_chars += len(text)
        recalled_ids.append(row.get("id", ""))

    # Facts — one-liners (compact)
    learn_lines = []
    learn_chars = 0
    for score, row in fact_entries[:top_k]:
        text = row.get("text", "")
        category = row.get("category", "")
        scope = row.get("scope", "")
        entry = f"- [{category}] ({scope}) {text}"
        if learn_chars + len(entry) > KNOWLEDGE_MAX_CHARS:
            break
        learn_lines.append(entry)
        learn_chars += len(entry)
        recalled_ids.append(row.get("id", ""))

    dev_notes = "\n".join(dev_lines) if dev_lines else ""
    skills = "\n\n".join(skill_lines) if skill_lines else ""
    learnings = "\n".join(learn_lines) if learn_lines else ""

    total = len(dev_lines) + len(skill_lines) + len(learn_lines)
    if total:
        logging.info(f"  Recalled {len(dev_lines)} dev notes + {len(skill_lines)} skills + {len(learn_lines)} facts")

    return {
        "developer_notes": dev_notes,
        "skills": skills,
        "past_learnings": learnings,
        "recalled_ids": recalled_ids,
    }


def call_gemini(prompt: str, max_tokens: int = 2048, model: Optional[str] = None) -> Optional[str]:
    if model is None:
        model = _triage_model()
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        return None

    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent?key={api_key}"
    )
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        logging.error(f"Gemini API error ({model}): {e}")
        return None


# === Librarian ===

def read_manifest() -> str:
    manifest = LIBRARIAN_DIR / "MANIFEST.md"
    if manifest.exists():
        return manifest.read_text()
    return ""


def read_repo_index(project: str, repo: str) -> str:
    index_file = LIBRARIAN_DIR / "indexes" / project / f"{repo}.md"
    if index_file.exists():
        return index_file.read_text()
    return ""


def extract_api_summary(repo_index: str, repo_label: str) -> str:
    """Extract API Surface and Integration Points from a repo index for sibling context injection."""
    import re

    section_pattern = r"^## {header}\s*\n(.*?)(?=^## |\Z)"
    sections = []

    for header, label in [("API Surface", "API Surface"), ("Integration Points", "Integration Points")]:
        match = re.search(
            section_pattern.format(header=header),
            repo_index, re.MULTILINE | re.DOTALL,
        )
        if match:
            content = match.group(1).strip()
            if content and "internal only" not in content.lower():
                sections.append(f"**{label}:**\n{content}")

    cmd_match = re.search(
        section_pattern.format(header="Available Commands"),
        repo_index, re.MULTILINE | re.DOTALL,
    )
    if cmd_match:
        content = cmd_match.group(1).strip()
        if content:
            sections.append(f"**Key Commands:**\n{content[:500]}")

    if not sections:
        purpose_match = re.search(
            section_pattern.format(header="Purpose"),
            repo_index, re.MULTILINE | re.DOTALL,
        )
        if purpose_match:
            sections.append(f"**Purpose:**\n{purpose_match.group(1).strip()[:300]}")
        elif repo_index:
            sections.append(f"*No detailed API info indexed yet for {repo_label}.*")

    return "\n\n".join(sections)


def find_repo_path(project: str, repo: str) -> Optional[Path]:
    candidate = GITPROJECTS_DIR / project / repo
    if candidate.exists() and (candidate / ".git").exists():
        return candidate
    return None


# === Codebase Deep-Read ===

MAX_FILE_CHARS = 2000
MAX_CONTEXT_CHARS = 10000

KEY_FILE_NAMES = [
    "README.md", "package.json", "pyproject.toml", "Cargo.toml",
    "tsconfig.json", "docker-compose.yml", "Makefile",
]

KEY_SOURCE_PATTERNS = [
    "schema", "types", "models", "routes", "middleware",
    "config", "constants", "index", "main", "app",
]


def _tree(directory: Path, prefix: str = "", depth: int = 3) -> List[str]:
    if depth <= 0 or not directory.is_dir():
        return []
    lines = []
    try:
        entries = sorted(directory.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        return []
    skip_dirs = {".git", "node_modules", "__pycache__", ".next", "dist", "build", ".turbo", "coverage", "vendor"}
    visible = [e for e in entries if e.name not in skip_dirs and not e.name.startswith(".")]
    for i, entry in enumerate(visible[:30]):
        connector = "└── " if i == len(visible) - 1 else "├── "
        if entry.is_dir():
            lines.append(f"{prefix}{connector}{entry.name}/")
            extension = "    " if i == len(visible) - 1 else "│   "
            lines.extend(_tree(entry, prefix + extension, depth - 1))
        else:
            lines.append(f"{prefix}{connector}{entry.name}")
    return lines


def _read_truncated(path: Path, max_chars: int = MAX_FILE_CHARS) -> str:
    try:
        content = path.read_text(errors="replace")
        if len(content) > max_chars:
            return content[:max_chars] + f"\n... (truncated, {len(content)} total chars)"
        return content
    except Exception:
        return ""


def _find_key_source_files(src_dir: Path) -> List[Path]:
    found = []
    if not src_dir.is_dir():
        return found
    skip_dirs = {".git", "node_modules", "__pycache__", ".next", "dist", "build", "coverage"}
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for f in files:
            stem = Path(f).stem.lower()
            if any(pat in stem for pat in KEY_SOURCE_PATTERNS):
                found.append(Path(root) / f)
        if len(found) >= 15:
            break
    return found


def read_key_source_files(repo_path: Path) -> str:
    sections = []
    total_chars = 0

    tree_lines = _tree(repo_path, depth=3)
    tree_str = "\n".join(tree_lines)
    sections.append(f"### Directory Structure\n```\n{tree_str}\n```")
    total_chars += len(tree_str)

    for name in KEY_FILE_NAMES:
        fpath = repo_path / name
        if fpath.exists() and total_chars < MAX_CONTEXT_CHARS:
            content = _read_truncated(fpath)
            if content:
                sections.append(f"### {name}\n```\n{content}\n```")
                total_chars += len(content)

    src_dir = repo_path / "src"
    if not src_dir.exists():
        src_dir = repo_path / "server" / "src"
    if not src_dir.exists():
        src_dir = repo_path / "lib"

    key_files = _find_key_source_files(src_dir)
    for fpath in key_files:
        if total_chars >= MAX_CONTEXT_CHARS:
            break
        rel = fpath.relative_to(repo_path)
        content = _read_truncated(fpath, max_chars=1500)
        if content:
            sections.append(f"### {rel}\n```\n{content}\n```")
            total_chars += len(content)

    return "\n\n".join(sections)


# === Triage ===

def _parse_gemini_json(response: Optional[str]) -> Optional[dict]:
    if not response:
        return None
    response = response.strip()
    if response.startswith("```"):
        response = response.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        logging.error(f"Gemini returned invalid JSON: {response[:200]}")
        return None


TRIAGE_FAIL = {"ready": False, "repos": [], "questions": [], "reasoning": "Triage failed"}


def identify_repos(title: str, description: str, manifest: str) -> List[dict]:
    prompt = f"""You are a repo-routing agent. Given a task and list of available repos, identify which repos are involved.

TASK: {title}
DESCRIPTION: {description or "(none)"}

AVAILABLE REPOS:
{manifest or "(none)"}

Respond with ONLY valid JSON (no markdown fences):
{{ "repos": [{{"project": "project-name", "repo": "repo-name"}}], "reasoning": "why these repos" }}
"""
    result = _parse_gemini_json(call_gemini(prompt, max_tokens=1024))
    return result.get("repos", []) if result else []


def triage_task(title: str, description: str, manifest: str, codebase_context: str = "", model: Optional[str] = None) -> dict:
    if model is None:
        model = _triage_model()
    context_section = ""
    if codebase_context:
        context_section = f"""
CODEBASE CONTEXT (actual source files from target repos):
{codebase_context}

Use this codebase context to:
- Understand existing patterns, APIs, and data models
- Ask questions about SPECIFIC implementation choices (e.g., "Should the new endpoint follow the existing pattern in src/app/api/tasks/route.ts?")
- Reference actual file paths, function names, and types in your questions
- Identify potential conflicts with existing code
"""

    prompt = f"""You are a task triage agent for an AI agent swarm. Analyze this task and decide if it's ready for execution.

TASK TITLE: {title}
TASK DESCRIPTION:
{description or "(no description)"}

AVAILABLE REPOS:
{manifest or "(no repo manifest available)"}
{context_section}
Respond with ONLY valid JSON (no markdown fences):
{{
  "ready": true/false,
  "repos": [{{"project": "project-name", "repo": "repo-name"}}],
  "questions": [
    {{
      "category": "scope|technical|design|requirements",
      "question": "The clarifying question",
      "question_type": "multiple_choice|text|yes_no",
      "options": ["Option A", "Option B", "Option C"]
    }}
  ],
  "reasoning": "Brief explanation of your assessment"
}}

Rules:
- "ready" = true if there's enough detail to write code (clear requirements, identifiable target repo)
- "ready" = false if ambiguous requirements, unclear scope, or missing critical decisions
- "repos" = which repos from the manifest are affected (can be multiple for cross-repo tasks)
- "questions" = only populated when ready=false. Generate up to 8 focused questions that would unblock execution. Ask ALL questions you need in a single round — do not hold back questions for later.
- Each question MUST reference specific files, patterns, or APIs from the codebase context when available.
- DO NOT ask generic questions like "what framework?" when the codebase context already shows the answer.
- For multiple_choice questions, provide 2-4 concrete options grounded in the existing codebase. ALWAYS include "Other (please specify)" as the last option so the user can provide a custom answer if none of the choices fit.
"""

    result = _parse_gemini_json(call_gemini(prompt, max_tokens=4096, model=model))
    if model != _triage_model():
        logging.info(f"  Triage used model: {model}")
    return result if result else TRIAGE_FAIL


def post_planning_questions(task_id: str, questions: List[dict], triage_result: Optional[dict] = None):
    """Post planning questions as activity and save structured triage state."""
    lines = ["**Needs clarification before work can begin:**\n"]
    for i, q in enumerate(questions, 1):
        lines.append(f"{i}. **[{q.get('category', 'scope')}]** {q['question']}")
        if q.get("options"):
            for opt in q["options"]:
                lines.append(f"   - {opt}")
            if not any("other" in o.lower() for o in q["options"]):
                lines.append(f"   - Other (please specify)")
        lines.append("")
    message = "\n".join(lines)

    try:
        mc_log_activity(task_id, "planning_questions", message)
        logging.info(f"  Posted {len(questions)} questions as MC activity")
    except Exception as e:
        logging.warning(f"Failed to post questions to MC: {e}")

    now = datetime.now(timezone.utc).isoformat()

    existing_repos = []
    try:
        existing_state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
        if existing_state and existing_state.get("triage_repos"):
            existing_repos = existing_state["triage_repos"]
    except Exception:
        pass

    new_repos = triage_result.get("repos", []) if triage_result else []

    triage_state = {
        "questions": [
            {
                "id": q.get("id", f"q{i}"),
                "question": q.get("question", q.get("q", "")),
                "category": q.get("category", "scope"),
                "question_type": q.get("question_type", "text"),
                "options": q.get("options"),
                "answer": q.get("answer"),
                "answered_at": None,
                "answered_by": q.get("answered_by"),
            }
            for i, q in enumerate(questions, 1)
        ],
        "triage_reasoning": triage_result.get("reasoning", "") if triage_result else "",
        "triage_repos": existing_repos if existing_repos else new_repos,
        "created_at": now,
        "updated_at": now,
    }

    try:
        mc_request("PUT", f"/api/tasks/{task_id}/triage-state", triage_state)
        logging.info(f"  Saved structured triage state ({len(questions)} questions, repos={len(triage_state['triage_repos'])})")
    except Exception as e:
        logging.warning(f"Failed to save triage state: {e}")


def _linear_gql(api_key: str, query: str, variables: dict) -> Optional[dict]:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        logging.warning(f"  Linear GraphQL error: {e}")
        return None


def sync_questions_to_linear(task: dict, questions: List[dict]):
    linear_issue_id = task.get("external_id") or task.get("linear_issue_id")
    if not linear_issue_id:
        return

    api_key = os.environ.get("LINEAR_API_KEY", "")
    if not api_key:
        return

    task_id = task["id"]
    mutation = """
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success comment { id }
      }
    }
    """

    posted = 0
    for i, q in enumerate(questions, 1):
        qtext = q.get("question", q.get("q", ""))
        lines = [f"**Q{i}.** {qtext}"]
        if q.get("options"):
            lines.append("")
            for j, opt in enumerate(q["options"]):
                label = chr(ord('a') + j)
                lines.append(f"  {label}) {opt}")
        lines.append("\n_Reply in this thread to answer._")
        body = "\n".join(lines)

        result = _linear_gql(api_key, mutation, {"issueId": linear_issue_id, "body": body})
        if result:
            comment_data = result.get("data", {}).get("commentCreate", {})
            comment_id = comment_data.get("comment", {}).get("id")
            if comment_id:
                q["linear_comment_id"] = comment_id
                posted += 1

    if posted:
        logging.info(f"  Posted {posted}/{len(questions)} questions as individual Linear comments")
        try:
            triage_state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
            if triage_state and triage_state.get("questions"):
                all_qs = triage_state["questions"]
                q_by_id = {q.get("id"): q for q in questions if q.get("linear_comment_id")}
                for tq in all_qs:
                    if tq.get("id") in q_by_id:
                        tq["linear_comment_id"] = q_by_id[tq["id"]]["linear_comment_id"]
                mc_request("PUT", f"/api/tasks/{task_id}/triage-state", triage_state)
                logging.info(f"  Saved Linear comment IDs to triage state")
        except Exception as e:
            logging.warning(f"  Failed to save comment IDs to triage state: {e}")


def _extract_ticket_id(title: str) -> str:
    import re
    match = re.search(r'[A-Z]+-\d+', title)
    return match.group(0) if match else "TICKET"


# === Prompt Generation ===

def generate_prompt(task: dict, repo_context: str, project: str, repo: str,
                    sibling_contexts: Optional[Dict[str, str]] = None,
                    knowledge: Optional[dict] = None) -> str:
    title = task["title"]
    description = task.get("description", "")
    linear_url = task.get("external_url") or task.get("linear_issue_url", "")

    prompt = f"""# Task: {title}

## Context
{description}
"""
    if linear_url:
        prompt += f"\nLinear ticket: {linear_url}\n"

    prompt += f"""
## Codebase Info ({project}/{repo})
{repo_context}
"""

    if sibling_contexts:
        prompt += "\n## Related Repos (Shared Context)\n\n"
        prompt += "These repos are also part of this task. They may expose APIs or services your code interacts with.\n\n"
        for sibling_label, sibling_summary in sibling_contexts.items():
            prompt += f"### {sibling_label}\n{sibling_summary}\n\n"

    if knowledge:
        dev_notes = knowledge.get("developer_notes", "")
        skills = knowledge.get("skills", "")
        past_learnings = knowledge.get("past_learnings", "")

        if dev_notes:
            prompt += f"\n## Developer Notes (MUST FOLLOW)\n\n"
            prompt += "These are instructions from your team. Treat them as ground truth.\n\n"
            prompt += f"{dev_notes}\n"

        if skills:
            prompt += f"\n## Procedural Skills (proven workflows for this repo)\n\n"
            prompt += "These are battle-tested procedures from agents who completed similar work. Follow these steps and heed the pitfalls.\n\n"
            prompt += f"{skills}\n"

        if past_learnings:
            prompt += f"\n## Past Learnings (from previous tasks on this repo)\n\n"
            prompt += "These are insights from agents who previously worked on this repo. Use them to avoid repeating mistakes.\n\n"
            prompt += f"{past_learnings}\n"

    prompt += f"""
## Mandatory Workflow (GSD + Review Loop)

You MUST follow this exact workflow. Do NOT skip steps. Do NOT write code before planning.
The loop continues until both GSD verification AND code review pass.

### Step 1: Plan
Run `/gsd:plan-phase --prd` (or `/gsd:new-project --auto` for greenfield).
This creates PLAN.md with task breakdown, must-haves, and verification criteria.
The plan-checker agent runs automatically to validate your plan before execution.
If plan-checker finds blockers, fix them before proceeding.

### Step 2: Execute
Run `/gsd:execute-phase` to implement with atomic commits.
Follow the plan. Do not deviate without documenting why.

### Step 3: Verify (GUARDRAIL — source of truth)
Run `/gsd:verify-work` to verify against the ORIGINAL plan's must-haves.
This creates VERIFICATION.md with pass/fail status.
Do NOT proceed until verification passes.
If VERIFICATION.md shows `status: gaps_found`, run `/gsd:plan-phase --gaps`.
Repeat until `status: passed`.

### Step 4: Self-Review (code-review-graph)
If the `code-review-graph` MCP server is available:
1. Use the `get_review_context` tool on your changed files to check blast radius
2. Use `query_graph` with `tests_for` to identify missing test coverage
3. Fix any issues found (missing tests, unintended impacts)
4. After fixing, RE-RUN `/gsd:verify-work` — fixes must not break original acceptance criteria
5. If a fix conflicts with the original plan, DO NOT apply it. Log it as a note for human review.

### Step 5: Pre-PR Validation
Run the same checks that GitHub Actions CI will run:
1. Check `.github/workflows/` for the repo's CI configuration
2. Run equivalent checks locally (e.g. `tsc --noEmit`, `npm run lint`, `npm test`, `pytest`, etc.)
3. If any check fails, fix and re-run until all pass

### Step 6: Codex Review
Run the pre-review script to get an external Codex review on your branch diff:
```bash
~/.openclaw/swarm/pre-review.sh "$(pwd)" origin/main
```
Read the output. If VERDICT is FAIL:
1. Fix the issues identified
2. RE-RUN `/gsd:verify-work` — fixes must not break original acceptance criteria
3. If a review suggestion conflicts with the plan's acceptance criteria, skip it and note: "Skipped review suggestion X — conflicts with acceptance criteria Y"
4. Re-run pre-review.sh after fixes
5. Maximum 3 review iterations. If still failing after 3, escalate to human (see below).

### Step 7: PR + Report
Only when GSD verification passes AND review passes (or max iterations reached):
1. Commit all changes with conventional commit messages
2. Push your branch
3. Create a PR with `gh pr create` — title MUST start with `[{_extract_ticket_id(title)}]`
4. Report completion to Mission Control:
   curl -X POST {MC_BASE_URL}/api/webhooks/agent-completion \\
     -H "Content-Type: application/json" \\
     -d '{{"task_id": "{task['id']}", "summary": "YOUR_SUMMARY_HERE"}}'

### Human Escalation
If you encounter ANY of these situations, DO NOT guess — escalate to human:
- A review suggestion conflicts with the plan's acceptance criteria
- You've iterated 3 times on review feedback and it's still failing
- You need a design decision not covered by the task description
- You need access to a system, API key, or config you don't have

To escalate, post to Mission Control and STOP:
```bash
curl -X POST {MC_BASE_URL}/api/tasks/{task['id']}/activities \\
  -H "Content-Type: application/json" \\
  -d '{{"activity_type": "needs_human", "message": "DESCRIBE THE BLOCKER AND WHAT YOU NEED"}}'
```
The bridge will post this to Linear and wait for a human response. Your session will be resumed when the answer arrives.

## Constraints
- Do NOT modify unrelated files
- Do NOT add new dependencies without justification
- Follow existing code patterns and conventions
- Commit messages: conventional commits format
- PR title MUST start with the ticket ID in brackets (e.g. `[{_extract_ticket_id(title)}] ...`)
- GSD verification is the source of truth — review fixes must not break it
"""
    return prompt


def generate_investigation_prompt(task: dict, repo_context: str, project: str, repo: str,
                                   knowledge: Optional[dict] = None) -> str:
    title = task["title"]
    description = task.get("description", "")
    linear_url = task.get("external_url") or task.get("linear_issue_url", "")
    ticket_id = _extract_ticket_id(title)

    prompt = f"""# Investigation: {title}

## Context
{description}
"""
    if linear_url:
        prompt += f"\nLinear ticket: {linear_url}\n"

    prompt += f"""
## Codebase Info ({project}/{repo})
{repo_context}
"""

    if knowledge:
        dev_notes = knowledge.get("developer_notes", "")
        skills = knowledge.get("skills", "")
        past_learnings = knowledge.get("past_learnings", "")
        if dev_notes:
            prompt += f"\n## Developer Notes\n{dev_notes}\n"
        if skills:
            prompt += f"\n## Procedural Skills\n{skills}\n"
        if past_learnings:
            prompt += f"\n## Past Learnings\n{past_learnings}\n"

    prompt += f"""
## Investigation Workflow

This is an INVESTIGATION task — NOT an implementation task. Your goal is to research, diagnose, and report findings. Do NOT write code fixes or create PRs.

### Step 1: Understand the Problem
Read the ticket description carefully. Identify what needs to be investigated.

### Step 2: Research
- Search the codebase for relevant code paths, configurations, logs
- Trace the flow of data or execution related to the issue
- Check for known patterns, error handling, edge cases
- Look at recent changes that might be related (git log)
- Check configuration files, environment variables, dependencies

### Step 3: Document Findings
Write a detailed findings report. Include:
- **Root cause analysis** (or hypotheses if unclear)
- **Evidence** — specific files, line numbers, log patterns
- **Impact assessment** — how widespread is the issue
- **Recommendations** — what should be done (but do NOT implement)
- **Related issues** — other tickets or areas affected

### Step 4: Report
Post your findings to Mission Control:
curl -X POST {MC_BASE_URL}/api/tasks/{task['id']}/activities \\
  -H "Content-Type: application/json" \\
  -d '{{"activity_type": "investigation_findings", "message": "YOUR_FINDINGS_HERE"}}'

Then mark the task complete:
curl -X POST {MC_BASE_URL}/api/webhooks/agent-completion \\
  -H "Content-Type: application/json" \\
  -d '{{"task_id": "{task['id']}", "summary": "Investigation complete: YOUR_SUMMARY"}}'

## Constraints
- READ ONLY — do NOT modify any source code
- Do NOT create branches, PRs, or commits
- Do NOT install dependencies or run build commands
- Focus on research and documentation only
- Be thorough — check multiple angles
"""
    return prompt


# === Agent Spawning ===

def detect_base_branch(repo_path: Path) -> str:
    """Detect the default branch for a repo (main, master, or other)."""
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
            capture_output=True, text=True, cwd=str(repo_path),
        )
        if result.returncode == 0:
            ref = result.stdout.strip()
            return ref.replace("refs/remotes/", "")
    except Exception:
        pass
    for candidate in ["origin/main", "origin/master"]:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", candidate],
                capture_output=True, text=True, cwd=str(repo_path),
            )
            if result.returncode == 0:
                return candidate
        except Exception:
            continue
    return "origin/main"


def _infer_branch_prefix(title: str) -> str:
    import re
    lower = title.lower()
    if re.search(r'\b(fix|bug|broken|error|crash|patch|hotfix|resolve)\b', lower):
        return "bugfix"
    return "feature"


def spawn_agent(task_id: str, task_label: str, repo_path: Path, prompt_content: str,
                agent_type: str = "claude", mc_task_id: str = "", base_branch: str = "",
                task_title: str = "") -> bool:
    prompt_dir = SWARM_DIR / "prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = prompt_dir / f"{task_label}.md"
    prompt_file.write_text(prompt_content)

    prefix = _infer_branch_prefix(task_title or task_label)
    branch_name = f"{prefix}/{task_label}"
    if not base_branch:
        base_branch = detect_base_branch(repo_path)

    env = os.environ.copy()
    env["MC_TASK_ID"] = mc_task_id or task_id
    env["BASE_BRANCH"] = base_branch

    try:
        result = subprocess.run(
            [str(SWARM_DIR / "spawn-agent.sh"), task_label, str(repo_path), branch_name, agent_type, task_label],
            capture_output=True, text=True, timeout=120, env=env,
        )
        if result.returncode == 0:
            logging.info(f"  Spawned {agent_type} agent: {task_label} (mc_task_id={mc_task_id or task_id}, base={base_branch})")
            return True
        else:
            logging.error(f"  spawn-agent.sh failed: {result.stderr}")
            return False
    except Exception as e:
        logging.error(f"  Failed to spawn agent: {e}")
        return False


# === Main Processing ===

def fetch_tasks_by_status(status: str) -> List[dict]:
    try:
        tasks: List[dict] = mc_request("GET", f"/api/tasks?status={status}")
        return tasks if tasks else []
    except Exception as e:
        logging.error(f"Failed to fetch {status} tasks: {e}")
        return []


def fetch_next_task() -> Optional[dict]:
    tasks = fetch_tasks_by_status("inbox")
    if not tasks:
        return None
    priority_order = {"urgent": 0, "high": 1, "normal": 2, "low": 3}
    tasks.sort(key=lambda t: (priority_order.get(t.get("priority", "normal"), 2), t.get("created_at", "")))
    return tasks[0]


def fetch_task_activities(task_id: str) -> List[dict]:
    try:
        return mc_request("GET", f"/api/tasks/{task_id}/activities")
    except Exception:
        return []


def _build_codebase_context(repos: List[dict]) -> str:
    sections = []
    for r in repos:
        project, repo = r["project"], r["repo"]
        repo_path = find_repo_path(project, repo)
        if not repo_path:
            continue
        code_ctx = read_key_source_files(repo_path)
        if code_ctx:
            sections.append(f"## {project}/{repo}\n\n{code_ctx}")
    return "\n\n---\n\n".join(sections)


def _build_triage_context(task_id: str) -> str:
    try:
        ts = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
    except Exception:
        return ""

    sections = []
    context_comments = ts.get("context_comments", []) if ts else []
    if context_comments:
        lines = []
        for cc in context_comments:
            lines.append(f"**{cc.get('author', '?')}**: {cc.get('body', '')}")
        sections.append("## Additional Context (from Linear comments)\n" + "\n\n".join(lines))

    questions = ts.get("questions", []) if ts else []
    answered = [q for q in questions if q.get("answer")]
    if answered:
        lines = []
        for q in answered:
            lines.append(f"**Q:** {q.get('question', q.get('q', ''))}\n**A:** {q.get('answer', '')}")
        sections.append("## Triage Q&A\n" + "\n\n".join(lines))

    return "\n\n".join(sections)


def _spawn_for_repos(task: dict, repos: List[dict]):
    task_id = task["id"]
    title = task["title"]
    description = task.get("description", "")
    task_type = task.get("task_type", "implementation")

    if task_type == "implementation":
        activities = fetch_task_activities(task_id)
        has_investigation_findings = any(a.get("activity_type") == "investigation_findings" for a in activities)
        triage_state_raw = task.get("triage_state")
        triage_state = None
        if isinstance(triage_state_raw, str) and triage_state_raw.strip():
            try:
                triage_state = json.loads(triage_state_raw)
            except Exception:
                triage_state = None

        promotion = triage_state.get("promotion") if isinstance(triage_state, dict) else None
        has_explicit_promotion = isinstance(promotion, dict) and promotion.get("mode") == "implementation"
        if has_investigation_findings and not has_explicit_promotion:
            logging.warning(f"  Blocking implementation spawn for {task_id[:8]}: investigation history without explicit promotion")
            mc_update_task(task_id, {"status": "planning"})
            mc_log_activity(
                task_id,
                "updated",
                "Implementation dispatch blocked — investigation tasks require explicit Promote-to-Coding action in Mission Control.",
            )
            return

    triage_ctx = _build_triage_context(task_id)
    if triage_ctx:
        description = description + "\n\n---\n\n" + triage_ctx
        task = {**task, "description": description}

    mc_update_task(task_id, {"status": "assigned"})
    mc_log_activity(task_id, "status_changed",
                    f"Task triaged as ready ({task_type}) — assigning to agents")

    repo_indexes: Dict[str, str] = {}
    for r in repos:
        idx = read_repo_index(r["project"], r["repo"])
        if idx:
            repo_indexes[f"{r['project']}/{r['repo']}"] = idx

    knowledge_query = f"{title}\n{description[:500]}"

    if task_type == "investigation":
        r = repos[0]
        project, repo = r["project"], r["repo"]
        repo_path = find_repo_path(project, repo)
        if not repo_path:
            logging.error(f"  Repo not found: {project}/{repo}")
            mc_log_activity(task_id, "updated", f"Repo not found on disk: {project}/{repo}")
            return

        repo_context = repo_indexes.get(f"{project}/{repo}", "")
        knowledge = recall_knowledge([r], knowledge_query)
        prompt = generate_investigation_prompt(task, repo_context, project, repo, knowledge=knowledge)
        task_label = f"{task_id[:8]}-inv-{repo}"

        if spawn_agent(task_id, task_label, repo_path, prompt, mc_task_id=task_id, task_title=title):
            mc_update_task(task_id, {"status": "in_progress"})
            mc_log_activity(task_id, "spawned", f"Investigation agent spawned for {project}/{repo}")
        return

    if len(repos) == 1:
        r = repos[0]
        project, repo = r["project"], r["repo"]
        repo_path = find_repo_path(project, repo)
        if not repo_path:
            logging.error(f"  Repo not found: {project}/{repo}")
            mc_log_activity(task_id, "updated", f"Repo not found on disk: {project}/{repo}")
            return

        repo_context = repo_indexes.get(f"{project}/{repo}", "")
        knowledge = recall_knowledge([r], knowledge_query)
        prompt = generate_prompt(task, repo_context, project, repo, knowledge=knowledge)
        task_label = f"{task_id[:8]}-{repo}"

        if spawn_agent(task_id, task_label, repo_path, prompt, mc_task_id=task_id, task_title=title):
            mc_update_task(task_id, {"status": "in_progress"})
            mc_log_activity(task_id, "spawned", f"Agent spawned for {project}/{repo}")
    else:
        mc_log_activity(task_id, "updated", f"Multi-repo task detected ({len(repos)} repos). Creating child tasks.")

        for r in repos:
            project, repo = r["project"], r["repo"]
            repo_path = find_repo_path(project, repo)
            if not repo_path:
                logging.warning(f"  Skipping {project}/{repo} — not found on disk")
                continue

            repo_label = f"{project}/{repo}"
            sibling_contexts: Dict[str, str] = {}
            for sib_label, sib_index in repo_indexes.items():
                if sib_label != repo_label:
                    sibling_contexts[sib_label] = extract_api_summary(sib_index, sib_label)

            child_title = f"[{task_id[:8]}] {title} — {repo}"
            child = mc_request("POST", "/api/tasks", {
                "title": child_title,
                "description": f"Child task of [{title}].\n\nScope: {project}/{repo}\n\n{description}",
                "priority": task.get("priority", "normal"),
                "parent_task_id": task_id,
                "source": "swarm-bridge",
            })
            child_id = child.get("id", "")
            logging.info(f"  Created child task: {child_id[:8]} for {project}/{repo}")

            repo_context = repo_indexes.get(repo_label, "")
            knowledge = recall_knowledge([r], knowledge_query)
            prompt = generate_prompt(task, repo_context, project, repo,
                                     sibling_contexts=sibling_contexts, knowledge=knowledge)
            task_label = f"{child_id[:8]}-{repo}"

            if spawn_agent(child_id, task_label, repo_path, prompt, mc_task_id=child_id, task_title=title):
                mc_update_task(child_id, {"status": "in_progress"})
                mc_log_activity(child_id, "spawned", f"Agent spawned for {project}/{repo}")

        mc_update_task(task_id, {"status": "in_progress"})
        mc_log_activity(task_id, "updated", f"Spawned agents across {len(repos)} repos")


def _plan_and_dispatch(task: dict, repos: List[dict]):
    """Generate a plan for the task, then dispatch the first runnable steps."""
    task_id = task["id"]
    title = task["title"]
    description = task.get("description", "")

    # Build context for planner
    repo_indexes: Dict[str, str] = {}
    for r in repos:
        idx = read_repo_index(r["project"], r["repo"])
        if idx:
            repo_indexes[f"{r['project']}/{r['repo']}"] = idx

    codebase_context = _build_codebase_context(repos) if repos else ""
    knowledge_query = f"{title}\n{description[:500]}"
    knowledge = recall_knowledge(repos, knowledge_query) if repos else {}
    triage_ctx = _build_triage_context(task_id)

    mc_log_activity(task_id, "updated", "Generating execution plan via Sonnet...")

    plan = generate_plan(
        title=title,
        description=description,
        repos=repos,
        codebase_context=codebase_context,
        knowledge=knowledge,
        triage_qa=triage_ctx,
    )

    if not plan:
        logging.warning(f"  Plan generation failed for {task_id[:8]} — falling back to direct dispatch")
        mc_log_activity(task_id, "updated", "Plan generation failed — falling back to direct agent dispatch")
        _spawn_for_repos(task, repos)
        return

    # If planner says single-step / no orchestration needed, go direct with GSD
    if not plan.get("needs_orchestration", True) or len(plan.get("steps", [])) <= 1:
        logging.info(f"  Planner says no orchestration needed — direct dispatch with GSD")
        mc_log_activity(task_id, "updated",
                        f"Plan assessment: {plan.get('reasoning', 'single-step task')} — dispatching directly")
        _spawn_for_repos(task, repos)
        return

    # Save plan and initialize progress — multi-step orchestration
    save_plan(task_id, plan)
    init_progress(task_id, plan)

    step_count = len(plan.get("steps", []))
    complexity = plan.get("estimated_complexity", "unknown")
    mc_log_activity(
        task_id, "plan_created",
        f"Execution plan created: {step_count} steps, complexity={complexity}\n\n"
        f"Summary: {plan.get('summary', '')}"
    )
    mc_update_task(task_id, {"status": "assigned"})

    # Dispatch first runnable steps
    _dispatch_next_steps(task, plan, repos)


def _dispatch_next_steps(task: dict, plan: dict, repos: List[dict]):
    """Dispatch the next runnable steps from a plan."""
    task_id = task["id"]
    title = task["title"]

    next_steps = get_next_steps(task_id, plan)
    if not next_steps:
        if is_plan_complete(task_id):
            logging.info(f"  All plan steps complete for {task_id[:8]}")
            mc_log_activity(task_id, "updated", "All plan steps completed successfully")
        else:
            logging.info(f"  No runnable steps for {task_id[:8]} — waiting for in-progress steps")
        return

    knowledge_query = f"{title}\n{task.get('description', '')[:500]}"
    knowledge = recall_knowledge(repos, knowledge_query) if repos else {}
    completed_summary = get_completed_steps_summary(task_id, plan)

    for step in next_steps:
        step_num = step["step"]
        category = classify_step(step)
        step["category"] = category

        # Find the right repo for this step
        step_repo_str = step.get("repo", "")
        target_repo = None
        target_project = ""
        target_repo_name = ""

        for r in repos:
            repo_label = f"{r['project']}/{r['repo']}"
            if repo_label == step_repo_str or r["repo"] == step_repo_str:
                target_repo = find_repo_path(r["project"], r["repo"])
                target_project = r["project"]
                target_repo_name = r["repo"]
                break

        if not target_repo and repos:
            r = repos[0]
            target_repo = find_repo_path(r["project"], r["repo"])
            target_project = r["project"]
            target_repo_name = r["repo"]

        if not target_repo:
            logging.warning(f"  No repo found for step {step_num} — skipping")
            update_step_progress(task_id, step_num, {"status": "skipped", "outcome": "No repo found"})
            continue

        # Build step-specific context
        repo_context = read_repo_index(target_project, target_repo_name)

        # Check if this is the final step (last in dependency chain)
        total_steps = plan.get("total_steps", len(plan.get("steps", [])))
        is_final = (step_num == total_steps) or _is_final_step_for_repo(step, plan, task_id)

        prompt = build_step_prompt(
            task=task,
            step=step,
            plan=plan,
            repo_context=repo_context,
            knowledge=knowledge,
            completed_steps_summary=completed_summary,
            is_final_step=is_final,
        )

        step_categories = get_planner_config()["step_categories"]
        agent_type = step_categories.get(category, {}).get("agent", "claude")
        task_label = f"{task_id[:8]}-s{step_num}-{target_repo_name}"

        # Determine base branch: if this step depends on a prior step in the same repo,
        # use that step's branch so we inherit its commits
        step_base_branch = ""
        for dep_num in step.get("depends_on", []):
            dep_step = next((s for s in plan.get("steps", []) if s["step"] == dep_num), None)
            if dep_step and dep_step.get("repo") == step.get("repo"):
                dep_label = f"{task_id[:8]}-s{dep_num}-{target_repo_name}"
                prefix = _infer_branch_prefix(title or dep_label)
                step_base_branch = f"{prefix}/{dep_label}"
                break

        update_step_progress(task_id, step_num, {
            "status": "in_progress",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "category": category,
            "agent_id": task_label,
        })

        if spawn_agent(task_id, task_label, target_repo, prompt,
                       agent_type=agent_type, mc_task_id=task_id, task_title=title,
                       base_branch=step_base_branch):
            mc_update_task(task_id, {"status": "in_progress"})
            mc_log_activity(
                task_id, "step_dispatched",
                f"Step {step_num}/{plan.get('total_steps', '?')}: {step['title']} → {agent_type} agent ({category})"
            )
            logging.info(f"  Dispatched step {step_num}: {step['title']} → {agent_type} ({category})")
        else:
            update_step_progress(task_id, step_num, {"status": "failed", "outcome": "Spawn failed"})
            logging.error(f"  Failed to spawn agent for step {step_num}")


def process_in_progress_plans():
    """Check in-progress planned tasks and dispatch next steps when previous ones complete.

    Called by the daemon loop. Looks at tasks with plans and dispatches next runnable steps.
    Includes: verification via MiniMax, retry logic for failed steps, final PR creation.
    """
    from planner import verify_step_completion

    PROGRESS_DIR = Path.home() / ".openclaw" / "bridge" / "progress"
    if not PROGRESS_DIR.exists():
        return

    for progress_file in PROGRESS_DIR.glob("*.json"):
        try:
            progress = json.loads(progress_file.read_text())
        except Exception:
            continue

        task_id = progress.get("task_id")
        if not task_id or progress.get("status") != "in_progress":
            continue

        plan_file = Path(progress.get("plan_file", ""))
        if not plan_file.exists():
            continue
        plan = json.loads(plan_file.read_text())

        # Check if any in_progress steps have completed (via check-agents / registry)
        newly_completed = False
        registry = _load_active_tasks()

        for step_key, step_data in progress.get("steps", {}).items():
            if step_data["status"] == "in_progress":
                agent_id = step_data.get("agent_id")
                if not agent_id:
                    continue
                if _is_agent_running(agent_id, registry):
                    continue

                # Agent finished — read log for verification
                log_file = SWARM_DIR / "logs" / f"agent-{agent_id}.log"
                agent_output = ""
                if log_file.exists():
                    try:
                        agent_output = log_file.read_text()[-5000:]
                    except Exception:
                        pass

                # Find the plan step for verification
                step_def = next(
                    (s for s in plan.get("steps", []) if str(s["step"]) == step_key),
                    None,
                )

                # Verify step completion via MiniMax (free)
                if step_def and agent_output and step_def.get("done_when"):
                    verification = verify_step_completion(step_def, agent_output)
                    if verification.get("passed"):
                        update_step_progress(task_id, int(step_key), {
                            "status": "completed",
                            "completed_at": datetime.now(timezone.utc).isoformat(),
                            "outcome": "Verified: all criteria met",
                        })
                        mc_log_activity(task_id, "step_verified",
                                        f"Step {step_key} verified ✓: {step_data.get('title', '')}")
                        newly_completed = True
                        logging.info(f"  Step {step_key} verified ✓ for {task_id[:8]}")
                    else:
                        # Verification failed — check retry budget
                        retry_count = step_data.get("retry_count", 0)
                        failed_criteria = [
                            r["criterion"] for r in verification.get("results", [])
                            if not r.get("met")
                        ]
                        if retry_count < MAX_STEP_RETRIES:
                            update_step_progress(task_id, int(step_key), {
                                "status": "pending",
                                "retry_count": retry_count + 1,
                                "outcome": f"Verification failed (attempt {retry_count + 1}): {'; '.join(failed_criteria[:3])}",
                                "agent_id": None,
                            })
                            mc_log_activity(task_id, "step_retry",
                                            f"Step {step_key} failed verification — retrying ({retry_count + 1}/{MAX_STEP_RETRIES}): {'; '.join(failed_criteria[:2])}")
                            logging.info(f"  Step {step_key} failed verification for {task_id[:8]} — retry {retry_count + 1}")
                            newly_completed = True  # triggers re-dispatch below
                        else:
                            update_step_progress(task_id, int(step_key), {
                                "status": "failed",
                                "completed_at": datetime.now(timezone.utc).isoformat(),
                                "outcome": f"Failed after {MAX_STEP_RETRIES} retries: {'; '.join(failed_criteria[:3])}",
                            })
                            mc_log_activity(task_id, "step_failed",
                                            f"Step {step_key} failed after {MAX_STEP_RETRIES} retries: {'; '.join(failed_criteria[:2])}")
                            logging.warning(f"  Step {step_key} exhausted retries for {task_id[:8]}")
                            newly_completed = True
                else:
                    # No verification criteria or no output — trust the agent
                    update_step_progress(task_id, int(step_key), {
                        "status": "completed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "outcome": "Agent completed (no verification criteria)",
                    })
                    newly_completed = True
                    logging.info(f"  Step {step_key} completed for {task_id[:8]} (no verification)")

        if not newly_completed:
            continue

        # Reload progress after updates
        progress = load_progress(task_id)
        if not progress:
            continue

        # Check plan completion
        if is_plan_complete(task_id):
            progress["status"] = "completed"
            progress_file.write_text(json.dumps(progress, indent=2))

            # Create final PR from the last step's branch
            _create_final_pr(task_id, plan, progress)

            # Post GSD artifacts as deliverables
            worktree_paths = []
            for entry in registry:
                if entry.get("task_id") == task_id and entry.get("worktree"):
                    worktree_paths.append(entry["worktree"])
            _post_gsd_artifacts(task_id, worktree_paths)

            mc_log_activity(task_id, "updated", "All plan steps completed — PR created, task in review")
            mc_update_task(task_id, {"status": "review"})
            logging.info(f"  Plan complete for {task_id[:8]} — PR created, moved to review")

            # Post completion comment to Linear so process_review_tasks can detect human replies
            task = _fetch_task(task_id)
            if task:
                linear_issue_id = task.get("external_id") or task.get("linear_issue_id")
                if linear_issue_id:
                    _post_linear_comment(linear_issue_id,
                        "**Completed by bridge**\n\nWork complete — PR opened. Task is now in review.")
            continue

        # Check if any steps permanently failed — escalate
        failed_steps = [
            k for k, v in progress.get("steps", {}).items()
            if v["status"] == "failed"
        ]
        if failed_steps:
            pending_or_running = [
                k for k, v in progress.get("steps", {}).items()
                if v["status"] in ("pending", "in_progress")
            ]
            if not pending_or_running:
                progress["status"] = "failed"
                progress_file.write_text(json.dumps(progress, indent=2))
                mc_log_activity(task_id, "updated",
                                f"Plan cannot complete — steps {', '.join(failed_steps)} failed permanently")
                mc_update_task(task_id, {"status": "on_hold"})
                logging.warning(f"  Plan stuck for {task_id[:8]} — failed steps: {failed_steps}")
                continue

        # Dispatch next runnable steps (includes retried steps that went back to pending)
        task = _fetch_task(task_id)
        if task:
            repos = _extract_repos_from_plan(plan)
            _dispatch_next_steps(task, plan, repos)


def _create_final_pr(task_id: str, plan: dict, progress: dict):
    """Create a PR from the last completed step's branch.

    For sequential plans on a single repo, the last step's branch has all commits.
    For multi-repo, each repo gets its own PR.
    """
    # Collect the last completed step per repo — its branch has all accumulated commits
    repo_branches: Dict[str, Tuple[str, str, str]] = {}  # repo_label -> (branch, worktree, task_title)

    steps_sorted = sorted(plan.get("steps", []), key=lambda s: s["step"])
    registry = _load_active_tasks()

    for step in steps_sorted:
        step_key = str(step["step"])
        step_progress = progress.get("steps", {}).get(step_key, {})
        if step_progress.get("status") != "completed":
            continue

        agent_id = step_progress.get("agent_id", "")
        if not agent_id:
            continue

        # Find this agent's entry to get branch and worktree
        for entry in registry:
            if entry.get("id") == agent_id or entry.get("id", "").startswith(agent_id):
                repo_label = step.get("repo", "unknown")
                repo_branches[repo_label] = (
                    entry.get("branch", ""),
                    entry.get("worktree", ""),
                    entry.get("description", ""),
                )
                break

    task = _fetch_task(task_id)
    title = task.get("title", "") if task else ""
    ticket_id_match = re.search(r'[A-Z]+-\d+', title)
    ticket_id = ticket_id_match.group(0) if ticket_id_match else ""
    plan_summary = plan.get("summary", "Implementation complete")

    for repo_label, (branch, worktree, desc) in repo_branches.items():
        if not branch or not worktree or not Path(worktree).exists():
            continue

        pr_title = f"[{ticket_id}] {title}" if ticket_id else title
        pr_body = (
            f"## Summary\n{plan_summary}\n\n"
            f"## Plan Steps\n"
        )
        for step in steps_sorted:
            if step.get("repo") == repo_label:
                step_key = str(step["step"])
                sp = progress.get("steps", {}).get(step_key, {})
                status_icon = "✅" if sp.get("status") == "completed" else "❌"
                pr_body += f"- {status_icon} Step {step['step']}: {step['title']}\n"

        pr_body += "\n---\n🤖 Generated by Mission Control Planner"

        try:
            result = subprocess.run(
                ["gh", "pr", "create", "--title", pr_title, "--body", pr_body, "--head", branch],
                capture_output=True, text=True, timeout=30, cwd=worktree,
            )
            if result.returncode == 0:
                pr_url = result.stdout.strip()
                logging.info(f"  PR created for {repo_label}: {pr_url}")
                mc_log_activity(task_id, "pr_created", f"PR created for {repo_label}: {pr_url}")
                mc_add_deliverable(task_id, "pull_request", f"PR: {repo_label}", path=pr_url)
            else:
                logging.warning(f"  PR creation failed for {repo_label}: {result.stderr}")
                mc_log_activity(task_id, "updated", f"PR creation failed for {repo_label}: {result.stderr[:200]}")
        except Exception as e:
            logging.error(f"  PR creation error for {repo_label}: {e}")
            mc_log_activity(task_id, "updated", f"PR creation error: {e}")


def _load_active_tasks() -> list:
    registry_file = SWARM_DIR / "active-tasks.json"
    if not registry_file.exists():
        return []
    try:
        return json.loads(registry_file.read_text())
    except Exception:
        return []


MAX_STEP_RETRIES = 2


def _is_agent_running(agent_label: str, registry: list) -> bool:
    for entry in registry:
        if entry.get("id") == agent_label:
            return entry.get("status") == "running"
    # Fallback: prefix match for backwards compat
    for entry in registry:
        if entry.get("id", "").startswith(agent_label):
            return entry.get("status") == "running"
    return False


def _fetch_task(task_id: str) -> Optional[dict]:
    try:
        return mc_request("GET", f"/api/tasks/{task_id}")
    except Exception:
        return None


def _is_final_step_for_repo(step: dict, plan: dict, task_id: str) -> bool:
    """Check if no other step in this repo depends on or follows this one."""
    step_num = step["step"]
    step_repo = step.get("repo", "")
    for other in plan.get("steps", []):
        if other["step"] == step_num:
            continue
        if other.get("repo") == step_repo and step_num in other.get("depends_on", []):
            return False  # something depends on us
    # Also check: are we the highest step number for this repo?
    repo_steps = [s["step"] for s in plan.get("steps", []) if s.get("repo") == step_repo]
    return step_num == max(repo_steps) if repo_steps else True


def _extract_repos_from_plan(plan: dict) -> List[dict]:
    """Extract unique repo references from plan steps."""
    repos = []
    seen = set()
    for step in plan.get("steps", []):
        repo_str = step.get("repo", "")
        if "/" in repo_str and repo_str not in seen:
            parts = repo_str.split("/", 1)
            repos.append({"project": parts[0], "repo": parts[1]})
            seen.add(repo_str)
    return repos


def _run_triage(title: str, description: str, manifest: str, model: Optional[str] = None) -> Tuple[dict, List[dict]]:
    """Run the 2-pass triage: identify repos (Flash), then enrich with codebase context."""
    repos = identify_repos(title, description, manifest)
    repo_labels = [r["project"] + "/" + r["repo"] for r in repos]
    logging.info(f"  Pass 1 — identified {len(repos)} target repos: {repo_labels}")

    codebase_context = ""
    if repos:
        codebase_context = _build_codebase_context(repos)
        if codebase_context:
            logging.info(f"  Pass 2 — loaded {len(codebase_context)} chars of codebase context")

        knowledge = recall_knowledge(repos, f"{title}\n{description[:500]}")
        dev_notes = knowledge.get("developer_notes", "")
        skills = knowledge.get("skills", "")
        past_learnings = knowledge.get("past_learnings", "")
        if dev_notes:
            codebase_context += f"\n\n---\n\n## Developer Notes (MUST FOLLOW)\n{dev_notes}"
        if skills:
            codebase_context += f"\n\n---\n\n## Procedural Skills\n{skills}"
        if past_learnings:
            codebase_context += f"\n\n---\n\n## Past Learnings (from previous tasks)\n{past_learnings}"
        total_knowledge = len(dev_notes) + len(skills) + len(past_learnings)
        if total_knowledge:
            logging.info(f"  Pass 3 — recalled {total_knowledge} chars of knowledge")

    triage = triage_task(title, description, manifest, codebase_context, model=model)

    if triage.get("repos") and not repos:
        repos = triage["repos"]

    return triage, repos


def _self_answer_questions(questions: List[dict], title: str, description: str,
                           codebase_context: str, knowledge: dict) -> int:
    knowledge_ctx = ""
    if knowledge.get("developer_notes"):
        knowledge_ctx += f"\n## Developer Notes\n{knowledge['developer_notes']}"
    if knowledge.get("past_learnings"):
        knowledge_ctx += f"\n## Past Learnings\n{knowledge['past_learnings']}"

    questions_block = ""
    for i, q in enumerate(questions):
        qid = q.get("id", f"q{i+1}")
        q.setdefault("id", qid)
        opts = ""
        if q.get("options"):
            opts = " Options: " + ", ".join(q["options"])
        questions_block += f'- id="{qid}" question="{q.get("question", q.get("q", ""))}" {opts}\n'

    prompt = (
        "You are a senior engineer triaging a task. Using ONLY the codebase context and knowledge below, "
        "try to answer each triage question. Only answer if you are CONFIDENT from the code/docs — "
        "do not guess or speculate. Leave questions unanswered if they require human judgment, "
        "business decisions, or information not present in the codebase.\n\n"
        f"## Task\n{title}\n{description[:2000]}\n\n"
    )
    if codebase_context:
        prompt += f"## Codebase Context\n{codebase_context[:8000]}\n\n"
    if knowledge_ctx:
        prompt += f"## Knowledge Base\n{knowledge_ctx[:4000]}\n\n"

    prompt += (
        f"## Triage Questions\n{questions_block}\n"
        "## Instructions\n"
        "Return a JSON array. For each question you CAN answer from the codebase/knowledge, "
        "include {\"id\": \"<question_id>\", \"answer\": \"<your_answer>\"}. "
        "Omit questions you cannot confidently answer. Return [] if none can be answered.\n"
        "Return raw JSON only — no markdown fencing."
    )

    result = call_gemini(prompt, max_tokens=4096, model=_triage_model())
    if not result:
        return 0

    result = result.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        matches = json.loads(result)
        if not isinstance(matches, list):
            return 0
    except (json.JSONDecodeError, ValueError):
        logging.warning(f"  Self-answer returned unparseable JSON: {result[:200]}")
        return 0

    answered = 0
    q_by_id = {q["id"]: q for q in questions if q.get("id")}
    for match in matches:
        qid = match.get("id", "")
        answer = match.get("answer", "").strip()
        if qid in q_by_id and answer:
            q_by_id[qid]["answer"] = answer
            q_by_id[qid]["answered"] = True
            q_by_id[qid]["answered_by"] = "agent"
            answered += 1

    return answered


def process_task(task: dict):
    task_id = task["id"]
    title = task["title"]
    description = task.get("description", "")

    logging.info(f"Processing: {title} ({task_id[:8]})")
    mc_log_activity(task_id, "updated", "Bridge picked up task for triage")

    description = resolve_notion_urls(description)

    manifest = read_manifest()
    triage, repos = _run_triage(title, description, manifest)

    task_type = task.get("task_type", "implementation")
    if task_type == "investigation" and triage["ready"] and not triage.get("questions"):
        logging.info(f"  Investigation task — re-running triage to force question generation")
        description_with_hint = description + "\n\n[IMPORTANT: This is an investigation/triage task. You MUST generate questions to scope the investigation. Set ready=false and generate 4-8 questions.]"
        triage2, repos2 = _run_triage(title, description_with_hint, manifest)
        if triage2.get("questions"):
            triage = triage2
            if repos2:
                repos = repos2
        triage["ready"] = False

    logging.info(f"  Triage: ready={triage['ready']}, repos={len(repos)}, reasoning={triage.get('reasoning', '')[:80]}")

    if not triage["ready"]:
        logging.info(f"  Task needs clarification — generating codebase-aware questions")

        questions = triage.get("questions", [])
        if questions:
            codebase_ctx = _build_codebase_context(repos) if repos else ""
            knowledge = recall_knowledge(repos, f"{title}\n{description[:500]}") if repos else {}
            auto_answered = _self_answer_questions(questions, title, description, codebase_ctx, knowledge)
            unanswered = [q for q in questions if not q.get("answer")]

            logging.info(f"  Self-answered {auto_answered}/{len(questions)} questions, {len(unanswered)} remain")

            if not unanswered:
                logging.info(f"  All questions self-answered — skipping planning, proceeding to dispatch")
                post_planning_questions(task_id, questions, triage_result=triage)
                mc_log_activity(task_id, "updated", f"Self-answered all {len(questions)} triage questions from codebase knowledge")
                repos = triage.get("repos", repos)
                if repos:
                    task_type = task.get("task_type", "implementation")
                    use_planner = os.environ.get("ENABLE_PLANNER", "1") == "1"
                    if use_planner and task_type == "implementation":
                        _plan_and_dispatch(task, repos)
                    else:
                        _spawn_for_repos(task, repos)
                return

            for i, q in enumerate(questions, 1):
                status = "✓" if q.get("answer") else "?"
                logging.info(f"  {status} Q{i} [{q.get('category')}]: {q['question'][:80]}")
                if q.get("options") and not q.get("answer"):
                    for opt in q["options"]:
                        logging.info(f"      - {opt}")

            mc_update_task(task_id, {"status": "planning"})
            mc_log_activity(task_id, "status_changed", f"Moved to planning: {triage.get('reasoning', 'needs clarification')}")
            post_planning_questions(task_id, questions, triage_result=triage)
            sync_questions_to_linear(task, [q for q in questions if not q.get("answer")])
            mc_log_activity(task_id, "updated",
                f"Self-answered {auto_answered}/{len(questions)} questions. Posted {len(unanswered)} to Linear for human input.")

        return

    repos = triage.get("repos", repos)
    if not repos:
        logging.warning(f"  Triage identified no repos — cannot proceed")
        mc_log_activity(task_id, "updated", "Triage could not identify target repos. Manual intervention needed.")
        return

    # Route through planner for implementation tasks, direct for investigations
    task_type = task.get("task_type", "implementation")
    use_planner = os.environ.get("ENABLE_PLANNER", "1") == "1"

    if use_planner and task_type == "implementation":
        logging.info(f"  Routing to planner for plan generation")
        _plan_and_dispatch(task, repos)
    else:
        _spawn_for_repos(task, repos)


# === Answer Detection & Re-triage ===

BRIDGE_COMMENT_MARKERS = [
    "Bridge needs clarification",
    "Bridge picked up",
    "Completed by bridge",
    "Bridge agent completed",
    "Bridge agent acknowledged",
    "Needs clarification before work",
    "Change request received",
    "Self-answered",
    "All questions answered — spawning agents",
    "Triage could not identify target repos",
    "Repo not found on disk",
    "Multi-repo task detected",
    "Spawned agents across",
    "Agent heartbeat:",
    "Generating execution plan",
    "Execution plan created",
    "Plan generation failed",
    "All plan steps completed",
    "Routing to planner",
]


def _is_bridge_generated(message: str) -> bool:
    return any(marker in message for marker in BRIDGE_COMMENT_MARKERS)


def _collect_dashboard_feedback(task_id: str) -> Optional[str]:
    activities = fetch_task_activities(task_id)
    if not activities:
        return None

    latest_ack_ts = ""
    for act in activities:
        if (
            act.get("activity_type") == "updated"
            and "Change request received from dashboard note" in act.get("message", "")
        ):
            ts = act.get("created_at", "")
            if ts > latest_ack_ts:
                latest_ack_ts = ts

    feedback = []
    for act in activities:
        atype = act.get("activity_type", "")
        if atype != "manual_feedback":
            continue

        msg = act.get("message", "")
        ts = act.get("created_at", "")
        if not msg or _is_bridge_generated(msg):
            continue
        if latest_ack_ts and ts <= latest_ack_ts:
            continue
        feedback.append(act)

    if not feedback:
        return None

    feedback.sort(key=lambda a: a.get("created_at", ""))
    return "\n\n---\n\n".join(
        f"**Dashboard note** ({a.get('created_at', '')}):\n{a.get('message', '')}"
        for a in feedback
    )


def check_for_answers(task_id: str) -> Optional[str]:
    """Check structured triage state for answered questions.

    Returns formatted Q&A pairs for answered questions, or falls back
    to activity-based detection if no triage state exists.
    """
    try:
        state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
    except Exception:
        state = None

    if state and state.get("questions"):
        answered = [q for q in state["questions"] if q.get("answer")]
        if answered:
            lines = []
            for q in answered:
                lines.append(f"**Q ({q.get('category', 'scope')}):** {q['question']}")
                lines.append(f"**A:** {q['answer']}")
                lines.append("")
            return "\n".join(lines)

    # Fallback: activity-based detection for tasks without triage state
    activities = fetch_task_activities(task_id)
    if not activities:
        return None

    question_time = None
    for act in activities:
        if act.get("activity_type") == "planning_questions":
            ts = act.get("created_at", "")
            if not question_time or ts > question_time:
                question_time = ts

    if not question_time:
        return None

    answers = []
    for act in activities:
        ts = act.get("created_at", "")
        if ts <= question_time:
            continue

        atype = act.get("activity_type", "")
        msg = act.get("message", "")

        if atype in ("planning_answer", "linear_comment", "manual_feedback", "updated"):
            if not _is_bridge_generated(msg):
                answers.append(msg)

    return "\n\n".join(answers) if answers else None


def process_planning_tasks():
    planning_tasks = fetch_tasks_by_status("planning")
    if not planning_tasks:
        return

    logging.info(f"Checking {len(planning_tasks)} planning tasks for answers")

    for task in planning_tasks:
        task_id = task["id"]
        title = task["title"]

        answers = check_for_answers(task_id)
        if not answers:
            continue

        # Skip if already processed (avoid re-logging every cycle)
        try:
            existing_acts = mc_request("GET", f"/api/tasks/{task_id}/activities")
            already_handled = any(
                "spawning agents" in a.get("message", "") or "Manual intervention needed" in a.get("message", "")
                for a in existing_acts
            )
            if already_handled:
                continue
        except Exception:
            pass

        logging.info(f"Answers found for: {title} ({task_id[:8]}) — proceeding to spawn agents")

        try:
            state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
        except Exception:
            state = None

        repos = state.get("triage_repos", []) if state else []

        if not repos:
            manifest = read_manifest()
            description = task.get("description", "")
            if answers:
                description = description + "\n\n" + answers
            repos = identify_repos(title, description, manifest)
            logging.info(f"  No repos in triage state — identified {len(repos)} from manifest + answers")

        if not repos:
            logging.warning(f"  Cannot identify target repos for {task_id[:8]}")
            mc_log_activity(task_id, "updated", "All questions answered but could not identify target repos. Manual intervention needed.")
            continue

        mc_log_activity(task_id, "updated", f"All questions answered — dispatching for {len(repos)} repo(s)")
        task_type = task.get("task_type", "implementation")
        use_planner = os.environ.get("ENABLE_PLANNER", "1") == "1"
        if use_planner and task_type == "implementation":
            _plan_and_dispatch(task, repos)
        else:
            _spawn_for_repos(task, repos)


# === Linear Reply Watching (Post-PR Change Requests) ===

def _extract_issue_tag(linear_url: str) -> Optional[str]:
    """Extract issue tag (e.g. CAP-85) from Linear issue URL."""
    match = re.search(r'([A-Z]+-\d+)', linear_url)
    return match.group(1) if match else None


def _lookup_linear_issue_id(issue_tag: str) -> Optional[str]:
    """Look up Linear issue UUID from tag (e.g. CAP-85)."""
    api_key = os.environ.get("LINEAR_API_KEY", "")
    if not api_key:
        return None

    match = re.match(r'([A-Z]+)-(\d+)', issue_tag)
    if not match:
        return None
    team_key, issue_num = match.group(1), int(match.group(2))

    query = """
    query($num: Float!, $teamKey: String!) {
        issues(filter: { number: { eq: $num }, team: { key: { eq: $teamKey } } }) {
            nodes { id }
        }
    }
    """
    payload = json.dumps({
        "query": query,
        "variables": {"num": issue_num, "teamKey": team_key}
    }).encode()

    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            nodes = data.get("data", {}).get("issues", {}).get("nodes", [])
            return nodes[0]["id"] if nodes else None
    except Exception as e:
        logging.warning(f"  Failed to look up Linear issue {issue_tag}: {e}")
        return None


def _fetch_linear_comments(issue_id: str) -> List[dict]:
    """Fetch comments from a Linear issue."""
    api_key = os.environ.get("LINEAR_API_KEY", "")
    if not api_key:
        return []

    query = """
    query($id: String!) {
        issue(id: $id) {
            comments(first: 50) {
                nodes {
                    id
                    body
                    createdAt
                    user { name }
                }
            }
        }
    }
    """
    payload = json.dumps({
        "query": query,
        "variables": {"id": issue_id}
    }).encode()

    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            return data.get("data", {}).get("issue", {}).get("comments", {}).get("nodes", [])
    except Exception as e:
        logging.warning(f"  Failed to fetch comments for {issue_id[:8]}: {e}")
        return []


def _find_agent_registry_entry(mc_task_id: str) -> Optional[dict]:
    """Find agent entry in active-tasks.json by MC task ID."""
    registry_file = SWARM_DIR / "active-tasks.json"
    if not registry_file.exists():
        return None
    try:
        entries = json.loads(registry_file.read_text())
        for entry in entries:
            if entry.get("mcTaskId") == mc_task_id or entry.get("id", "").startswith(mc_task_id[:8]):
                return entry
        return None
    except Exception:
        return None


def _post_linear_comment(linear_issue_id: str, body: str):
    api_key = os.environ.get("LINEAR_API_KEY", "")
    if not api_key or not linear_issue_id:
        return
    mutation = """
    mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }
    """
    payload = json.dumps({"query": mutation, "variables": {"issueId": linear_issue_id, "body": body}}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=15):
            logging.info(f"  Posted reply to Linear issue {linear_issue_id[:8]}")
    except Exception as e:
        logging.warning(f"  Failed to post to Linear: {e}")


def _relaunch_for_change_request(task: dict, change_requests_text: str, linear_issue_id: str = "", source: str = "linear"):
    """Re-launch an agent with change request feedback from Linear."""
    task_id = task["id"]

    entry = _find_agent_registry_entry(task_id)
    if not entry:
        logging.warning(f"  No agent registry entry for {task_id[:8]} — cannot re-launch")
        mc_log_activity(task_id, "updated",
                        "Change request received from Linear but no agent found to re-launch. Manual intervention needed.")
        return

    worktree = entry.get("worktree", "")
    session = entry.get("tmuxSession", "")
    agent_type = entry.get("agent", "claude")
    reg_id = entry.get("id", "")

    if not worktree or not Path(worktree).exists():
        logging.warning(f"  Worktree not found for {task_id[:8]}: {worktree}")
        mc_log_activity(task_id, "updated",
                        "Change request received but agent worktree missing. Manual intervention needed.")
        return

    mc_update_task(task_id, {"status": "in_progress"})

    prompt_title = "Change Request from Linear Review" if source == "linear" else "Change Request from Mission Control"
    prompt_file = SWARM_DIR / "prompts" / f"{reg_id}-change-request.md"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    prompt_file.write_text(f"""# {prompt_title}

The reviewer has requested changes on your PR. Address ALL feedback below.

## Reviewer Feedback
{change_requests_text}

## Instructions
1. Read the reviewer feedback carefully
2. Make ALL requested changes in your code
3. Run tests to verify your changes work
4. Commit with message: "fix: address reviewer feedback"
5. Push to update the existing PR

Do NOT create a new PR. Fix the existing code and push.
Do NOT ask for confirmation. Complete all steps autonomously.
""")

    try:
        subprocess.run(["tmux", "kill-session", "-t", session],
                       capture_output=True, timeout=10)
    except Exception:
        pass

    launcher = str(SWARM_DIR / ("run-codex.sh" if agent_type == "codex" else "run-claude.sh"))

    try:
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "-c", worktree,
             f"PROMPT_OVERRIDE={prompt_file} {launcher} {reg_id}"],
            capture_output=True, text=True, timeout=30,
        )
        logging.info(f"  Re-launched agent {reg_id} for change request")
    except Exception as e:
        logging.error(f"  Failed to re-launch agent: {e}")
        mc_log_activity(task_id, "updated", f"Failed to re-launch agent for change request: {e}")
        return

    registry_file = SWARM_DIR / "active-tasks.json"
    try:
        entries = json.loads(registry_file.read_text())
        for e in entries:
            if e.get("id") == reg_id:
                e["status"] = "running"
                e["changeRequestAt"] = datetime.now(timezone.utc).isoformat()
                e.pop("completionSyncedAt", None)
                break
        registry_file.write_text(json.dumps(entries, indent=2))
    except Exception:
        pass

    if source == "linear":
        mc_log_activity(task_id, "updated", "Change request received from Linear reviewer — re-launching agent")
    else:
        mc_log_activity(task_id, "updated", "Change request received from dashboard note — re-launching agent")

    if linear_issue_id:
        _post_linear_comment(linear_issue_id,
                             "**Bridge agent acknowledged** — working on the requested changes. "
                             "I'll update the PR and reply here when done.")


def _relaunch_for_investigation_followup(task: dict, followup_text: str, source: str = "dashboard", linear_issue_id: str = ""):
    task_id = task["id"]

    entry = _find_agent_registry_entry(task_id)
    if not entry:
        logging.warning(f"  No agent registry entry for {task_id[:8]} — cannot re-launch investigation follow-up")
        mc_log_activity(task_id, "updated",
                        "Investigation follow-up received but no agent found to re-launch. Manual intervention needed.")
        return

    worktree = entry.get("worktree", "")
    session = entry.get("tmuxSession", "")
    agent_type = entry.get("agent", "claude")
    reg_id = entry.get("id", "")

    if not worktree or not Path(worktree).exists():
        logging.warning(f"  Worktree not found for {task_id[:8]}: {worktree}")
        mc_log_activity(task_id, "updated",
                        "Investigation follow-up received but agent worktree missing. Manual intervention needed.")
        return

    mc_update_task(task_id, {"status": "in_progress"})

    prompt_file = SWARM_DIR / "prompts" / f"{reg_id}-investigation-followup.md"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    prompt_file.write_text(f"""# Investigation Follow-up

This task is investigation-only. You received new follow-up context/questions.

## Follow-up Input
{followup_text}

## Instructions
1. Revisit your investigation based on the follow-up input above
2. Gather additional evidence and refine findings
3. Post updated findings to Mission Control as activity_type `investigation_findings`
4. Mark the task complete via Mission Control webhook (status `review`)

## Constraints (MUST FOLLOW)
- READ ONLY — do NOT modify source code
- Do NOT create branches, commits, or pull requests
- Do NOT push any code changes
- Focus on diagnosis, evidence, and recommendations only
""")

    try:
        subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True, timeout=10)
    except Exception:
        pass

    launcher = str(SWARM_DIR / ("run-codex.sh" if agent_type == "codex" else "run-claude.sh"))

    try:
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "-c", worktree,
             f"PROMPT_OVERRIDE={prompt_file} {launcher} {reg_id}"],
            capture_output=True, text=True, timeout=30,
        )
        logging.info(f"  Re-launched investigation agent {reg_id} for follow-up")
    except Exception as e:
        logging.error(f"  Failed to re-launch investigation follow-up agent: {e}")
        mc_log_activity(task_id, "updated", f"Failed to re-launch investigation follow-up agent: {e}")
        return

    registry_file = SWARM_DIR / "active-tasks.json"
    try:
        entries = json.loads(registry_file.read_text())
        for e in entries:
            if e.get("id") == reg_id:
                e["status"] = "running"
                e["changeRequestAt"] = datetime.now(timezone.utc).isoformat()
                e.pop("completionSyncedAt", None)
                break
        registry_file.write_text(json.dumps(entries, indent=2))
    except Exception:
        pass

    if source == "linear":
        mc_log_activity(task_id, "updated", "Investigation follow-up received from Linear — re-launching investigation agent")
    else:
        mc_log_activity(task_id, "updated", "Investigation follow-up received from dashboard note — re-launching investigation agent")

    if linear_issue_id:
        _post_linear_comment(linear_issue_id,
                             "**Bridge investigation follow-up acknowledged** — gathering more evidence and findings. "
                             "I will post updated investigation results here.")


def process_review_tasks():
    """Watch for human replies on Linear for tasks in review/testing status.

    When a human replies after the bot's completion comment, treat it as a
    change request and re-launch the agent with an iteration prompt.
    """
    review_tasks = fetch_tasks_by_status("review") + fetch_tasks_by_status("testing")
    if not review_tasks:
        return

    logging.info(f"Checking {len(review_tasks)} review/testing tasks for Linear change requests")

    for task in review_tasks:
        task_id = task["id"]
        title = task["title"]
        task_type = task.get("task_type", "implementation")

        dashboard_feedback = _collect_dashboard_feedback(task_id)
        if dashboard_feedback:
            logging.info(f"Dashboard feedback found for: {title} ({task_id[:8]}) — re-launching")
            if task_type == "investigation":
                _relaunch_for_investigation_followup(task, dashboard_feedback, source="dashboard")
            else:
                _relaunch_for_change_request(task, dashboard_feedback, source="dashboard")
            continue

        # Find Linear issue URL (check parent if child task)
        linear_url = task.get("external_url") or task.get("linear_issue_url", "")
        if not linear_url and task.get("parent_task_id"):
            try:
                parent = mc_request("GET", f"/api/tasks/{task['parent_task_id']}")
                linear_url = parent.get("external_url") or parent.get("linear_issue_url", "")
            except Exception:
                pass

        if not linear_url:
            continue

        # Extract issue tag and look up Linear ID
        issue_tag = _extract_issue_tag(linear_url)
        if not issue_tag:
            continue

        linear_id = _lookup_linear_issue_id(issue_tag)
        if not linear_id:
            continue

        # Fetch comments on the Linear issue
        comments = _fetch_linear_comments(linear_id)
        if not comments:
            continue

        # Find the bot's LATEST completion comment timestamp
        completion_time = None
        for c in comments:
            body = c.get("body", "")
            if _is_bridge_generated(body):
                ts = c.get("createdAt", "")
                if not completion_time or ts > completion_time:
                    completion_time = ts

        if not completion_time:
            continue  # No bot completion comment found yet

        # Find human replies AFTER the completion comment
        change_requests = []
        for c in comments:
            ts = c.get("createdAt", "")
            body = c.get("body", "")
            if ts > completion_time and not _is_bridge_generated(body):
                change_requests.append(c)

        if not change_requests:
            continue

        # Format the change request text
        request_text = "\n\n---\n\n".join([
            f"**{c.get('user', {}).get('name', 'Unknown')}** ({c['createdAt']}):\n{c['body']}"
            for c in change_requests
        ])

        logging.info(f"Change request found for: {title} ({task_id[:8]}) — {len(change_requests)} reply(ies)")
        if task_type == "investigation":
            _relaunch_for_investigation_followup(task, request_text, source="linear", linear_issue_id=linear_id)
        else:
            _relaunch_for_change_request(task, request_text, linear_issue_id=linear_id)


def process_human_escalations():
    """Detect needs_human activities on in-progress tasks and escalate to Linear.

    When an agent posts activity_type=needs_human, this:
    1. Moves task to planning status (pauses further agent work)
    2. Posts the blocker to Linear as a comment
    3. When human replies, process_planning_tasks picks it up and resumes
    """
    in_progress = fetch_tasks_by_status("in_progress")
    if not in_progress:
        return

    for task in in_progress:
        task_id = task["id"]
        activities = fetch_task_activities(task_id)

        # Find unhandled needs_human activities
        has_escalation = False
        escalation_msg = ""
        for act in activities:
            if act.get("activity_type") == "needs_human":
                # Check if we already handled this (look for our ack)
                ack_exists = any(
                    a.get("activity_type") == "updated"
                    and "Escalated to human" in a.get("message", "")
                    and a.get("created_at", "") > act.get("created_at", "")
                    for a in activities
                )
                if not ack_exists:
                    has_escalation = True
                    escalation_msg = act.get("message", "Agent needs human input")
                    break

        if not has_escalation:
            continue

        logging.info(f"Human escalation detected for {task_id[:8]}: {escalation_msg[:80]}")

        # Move to planning (pauses dispatch)
        mc_update_task(task_id, {"status": "planning"})
        mc_log_activity(task_id, "updated",
                        f"Escalated to human: {escalation_msg}")

        # Post to Linear if linked
        questions = [{
            "id": "agent_escalation",
            "question": escalation_msg,
            "category": "technical",
            "question_type": "text",
        }]
        post_planning_questions(task_id, questions)
        sync_questions_to_linear(task, questions)

        logging.info(f"  Posted escalation to Linear for {task_id[:8]}")


def run_once():
    task = fetch_next_task()
    if task:
        try:
            process_task(task)
        except Exception as e:
            logging.error(f"Bridge failed processing {task['id'][:8]}: {e}", exc_info=True)
            try:
                mc_update_task(task["id"], {"status": "planning"})
                mc_log_activity(task["id"], "failed", f"Bridge error: {e}")
            except Exception:
                pass
    else:
        logging.info("No inbox tasks to process")

    process_planning_tasks()
    process_in_progress_plans()
    process_human_escalations()
    process_review_tasks()


def run_daemon(interval: int = 60):
    logging.info(f"Bridge daemon started (polling every {interval}s)")
    while True:
        try:
            run_once()
        except Exception as e:
            logging.error(f"Bridge error: {e}")
        time.sleep(interval)


if __name__ == "__main__":
    setup_logging()
    load_env()

    parser = argparse.ArgumentParser(description="Bridge — Task Orchestrator")
    parser.add_argument("--daemon", action="store_true", help="Run as daemon (poll every 60s)")
    parser.add_argument("--interval", type=int, default=60, help="Daemon poll interval in seconds")
    parser.add_argument("--task", type=str, help="Process a specific task ID")
    args = parser.parse_args()

    if args.task:
        logging.info(f"Processing specific task: {args.task}")
        task = mc_request("GET", f"/api/tasks/{args.task}")
        process_task(task)
    elif args.daemon:
        run_daemon(args.interval)
    else:
        run_once()
