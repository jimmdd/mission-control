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
import shlex
import shutil
import socket
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
    _call_openrouter,
    _call_claude_cli,
    _call_codex_cli,
    call_openrouter_fallback,
    _post_json_with_retry,
)
from gsd_backend import (
    backend_label,
    execute_command as gsd_execute_command,
    gap_plan_command as gsd_gap_plan_command,
    planning_dir_name as gsd_planning_dir_name,
    plan_command as gsd_plan_command,
    plan_step_text as gsd_plan_step_text,
    verify_command as gsd_verify_command,
    workflow_ran as gsd_workflow_ran,
)
from worktree_env import describe, install_dependencies, looks_unprepared, seed_worktree_env
from questions import (
    add_message as question_add_message,
    all_settled as questions_all_settled,
    awaiting_decision,
    awaiting_reply,
    blocking as blocking_questions,
    merge as merge_questions,
    record_answer as question_record_answer,
    summarise as summarise_questions,
)

MC_HOME = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))
MC_BASE_URL = os.environ.get("MISSION_CONTROL_URL", "http://localhost:18900")
ENV_FILE = MC_HOME / ".env"
LIBRARIAN_DIR = MC_HOME / "librarian"
SWARM_DIR = MC_HOME / "swarm"
BRIDGE_DIR = MC_HOME / "bridge"
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
    headers = {"Content-Type": "application/json"} if payload else {}
    token = (
        os.environ.get("MISSION_CONTROL_ACCESS_TOKEN")
        or os.environ.get("MISSION_CONTROL_WRITE_TOKEN")
        or os.environ.get("MISSION_CONTROL_READ_ACCESS_TOKEN")
        or ""
    ).strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url, data=payload, method=method,
        headers=headers,
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


def mc_set_progress(task_id: str, state: str = "", phase: str = "", step_label: str = "",
                    step_index: Optional[int] = None, step_total: Optional[int] = None,
                    blocked_reason: str = ""):
    """Best-effort structured progress report. Never raises into the bridge loop —
    progress is telemetry, not control flow."""
    body: dict = {}
    if state:
        body["state"] = state
    if phase:
        body["phase"] = phase
    if step_label:
        body["step_label"] = step_label
    if step_index is not None:
        body["step_index"] = step_index
    if step_total is not None:
        body["step_total"] = step_total
    if blocked_reason:
        body["blocked_reason"] = blocked_reason
    if not body:
        return
    try:
        mc_request("PUT", f"/api/tasks/{task_id}/progress", body)
    except Exception as e:
        logging.debug(f"progress update failed for {task_id[:8]}: {e}")


def mc_add_deliverable(task_id: str, dtype: str, title: str, path: str = "", description: str = ""):
    body = {"deliverable_type": dtype, "title": title}
    if path:
        body["path"] = path
    if description:
        body["description"] = description
    mc_request("POST", f"/api/tasks/{task_id}/deliverables", body)


def bridge_owner() -> str:
    return os.environ.get("MISSION_CONTROL_BRIDGE_OWNER", f"{socket.gethostname()}:{os.getpid()}")


def bridge_lease_seconds() -> int:
    try:
        return max(30, min(int(os.environ.get("MISSION_CONTROL_BRIDGE_LEASE_SECONDS", "900")), 3600))
    except ValueError:
        return 900


_GSD_ARTIFACTS = [
    ("PLAN.md", "gsd-plan", "GSD Plan"),
    ("VERIFICATION.md", "gsd-verification", "GSD Verification"),
    ("PRD.md", "gsd-prd", "PRD"),
]


def _post_gsd_artifacts(task_id: str, worktree_paths: List[str]):
    """Post GSD artifact files from worktrees as task deliverables."""
    seen = set()  # avoid duplicates if multiple steps share a worktree
    planning_dir = gsd_planning_dir_name()
    for wt in worktree_paths:
        wt_path = Path(wt)
        if not wt_path.exists() or wt in seen:
            continue
        seen.add(wt)
        for filename, dtype, default_title in _GSD_ARTIFACTS:
            candidates = [wt_path / filename]
            if filename in {"PLAN.md", "VERIFICATION.md"}:
                suffix = filename.removesuffix(".md")
                candidates.extend(sorted((wt_path / planning_dir / "phases").glob(f"*/*-{suffix}.md")))
            artifact = next((path for path in candidates if path.exists()), None)
            if artifact is None:
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


SWARM_CONFIG_PATH = MC_HOME / "swarm" / "swarm-config.json"


def _load_triage_config() -> dict:
    """Load triage model config from swarm-config.json."""
    defaults = {
        "triage_model": "gemini-2.5-flash",
        "triage_model_deep": "gemini-2.5-pro",
        "triage_provider": "gemini",          # gemini | openrouter
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


from context_fabrica_config import (
    context_fabrica_embedding_model,
    context_fabrica_schema,
    existing_context_fabrica_schema,
    gemini_embedding_payload,
    gemini_embedding_url,
    include_existing_context_fabrica_schema,
    make_existing_context_fabrica_adapter,
    make_existing_context_fabrica_embedder,
    make_context_fabrica_adapter,
)

_triage_cfg = _load_triage_config()
EMBEDDING_MODEL = context_fabrica_embedding_model()
EMBEDDING_URL = gemini_embedding_url(EMBEDDING_MODEL)
KNOWLEDGE_MAX_RESULTS = 5
KNOWLEDGE_MAX_CHARS = 2000


def _embed_query(text: str) -> Optional[List[float]]:
    # Routed through the pluggable embedder (FastEmbed by default; no API key).
    try:
        import embeddings
        return embeddings.embed_text(text)
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

    domains = set()
    for r in repos:
        domains.add(f"{r['project']}/{r['repo']}")
        domains.add(r['project'])
    domains.add("global")

    all_results = []

    vector = _embed_query(query)
    if vector:
        try:
            adapter = make_context_fabrica_adapter(bootstrap=True)
            for domain in domains:
                results = adapter.semantic_search(vector, domain=domain, top_k=top_k * 2)
                all_results.extend((qr, context_fabrica_schema(), True) for qr in results)
        except Exception as e:
            logging.warning(f"Mission Control knowledge recall query failed: {e}")

    if include_existing_context_fabrica_schema() and existing_context_fabrica_schema() != context_fabrica_schema():
        try:
            existing_embedder = make_existing_context_fabrica_embedder()
            existing_vector = existing_embedder.embed(query)
            existing_adapter = make_existing_context_fabrica_adapter()
            for domain in domains:
                results = existing_adapter.semantic_search(existing_vector, domain=domain, top_k=top_k * 2)
                all_results.extend((qr, existing_context_fabrica_schema(), False) for qr in results)
        except Exception as e:
            logging.warning(f"Existing context-fabrica recall query skipped: {e}")

    if not all_results:
        return empty

    # Transform QueryResult objects into dict format for scoring
    rows = []
    seen_records = set()
    for qr, source_schema, feedback_enabled in all_results:
        rec = qr.record
        dedupe_key = (source_schema, rec.record_id)
        if dedupe_key in seen_records:
            continue
        seen_records.add(dedupe_key)
        rows.append({
            "id": rec.record_id,
            "text": rec.text,
            "scope": rec.metadata.get("original_scope", f"repo:{rec.domain}"),
            "category": rec.kind,
            "importance": round(rec.confidence * 5),
            "_distance": 1.0 - qr.semantic_score,  # convert similarity to distance
            "metadata": json.dumps(rec.metadata) if isinstance(rec.metadata, dict) else str(rec.metadata),
            "source_schema": source_schema,
            "feedback_enabled": feedback_enabled,
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
        if row.get("feedback_enabled", True):
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
        if row.get("feedback_enabled", True):
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
        if row.get("feedback_enabled", True):
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
    # Route to another provider when configured, keeping all triage call sites
    # unchanged. The CLI providers need no API key — they use the logged-in session.
    provider = _load_triage_config().get("triage_provider")
    if provider == "openrouter":
        return _call_openrouter(prompt, model=model, max_tokens=max_tokens)
    if provider == "claude-cli":
        return _call_claude_cli(prompt, model=model, max_tokens=max_tokens)
    if provider == "codex-cli":
        return _call_codex_cli(prompt, model=model, max_tokens=max_tokens)
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        # No Gemini key — try the OpenRouter backup before giving up.
        return call_openrouter_fallback(prompt, model=model, max_tokens=max_tokens)

    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent"
    )
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
    )

    # Retry Gemini on rate-limit/transient errors before paying for OpenRouter.
    data = _post_json_with_retry(req, label=f"Gemini triage ({model})")
    if data is not None:
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError) as e:
            logging.error(f"Gemini triage ({model}) unexpected response shape: {e}")
    # Gemini exhausted retries — fall back to OpenRouter (None if unavailable).
    return call_openrouter_fallback(prompt, model=model, max_tokens=max_tokens)


# === Librarian ===

# Label used as the "project" for repos that live directly under GITPROJECTS_DIR
# (flat layout, e.g. ~/GitProjects/backend-new-ui) rather than nested project/repo.
FLAT_REPO_PROJECT = GITPROJECTS_DIR.name


def discover_local_repos() -> List[dict]:
    """Discover git repos under GITPROJECTS_DIR, supporting both layouts:
      - flat:   <root>/<repo>            -> project=FLAT_REPO_PROJECT, repo=<repo>
      - nested: <root>/<project>/<repo>  -> project=<project>, repo=<repo>
    Returns dicts with project/repo/path/label."""
    repos: List[dict] = []
    root = GITPROJECTS_DIR
    if not root.is_dir():
        return repos
    # spawn-agent.sh stages agent worktrees under <root>/worktrees. Those are NOT
    # target repos — descending into them makes a stale task worktree (e.g.
    # MET-551-backend-new-ui) look like a repo and mis-routes dispatch to it.
    EXCLUDED_DIRS = {"worktrees"}
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if entry.name in EXCLUDED_DIRS:
            continue
        # .git may be a dir (main clone) or a file (git worktree) — both are valid targets.
        if (entry / ".git").exists():
            repos.append({
                "project": FLAT_REPO_PROJECT,
                "repo": entry.name,
                "path": entry,
                "label": f"{FLAT_REPO_PROJECT}/{entry.name}",
            })
            continue
        # Not a repo itself — look one level deeper for nested project/repo.
        for sub in sorted(entry.iterdir()):
            if sub.is_dir() and (sub / ".git").exists():
                repos.append({
                    "project": entry.name,
                    "repo": sub.name,
                    "path": sub,
                    "label": f"{entry.name}/{sub.name}",
                })
    return _dedupe_by_remote(repos)


def _origin_url(path: Path) -> str:
    try:
        out = subprocess.run(["git", "remote", "get-url", "origin"], cwd=str(path),
                             capture_output=True, text=True, timeout=15)
        return out.stdout.strip().rstrip("/").removesuffix(".git") if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _dedupe_by_remote(repos: List[dict]) -> List[dict]:
    """Collapse several local checkouts of one upstream down to a single entry.

    Two clones of the same repository are two names for one codebase, but the manifest
    listed both, so repo selection picked either — non-deterministically, on identical
    input — and worktrees landed under different parents run to run.

    The kept clone is the one whose directory name matches the repository name in the
    remote URL, so `backend` wins over a `backend-phase0` or `…-redesign` copy of it.
    Repos with no origin are left alone: nothing says they are duplicates.
    """
    by_remote: Dict[str, List[dict]] = {}
    standalone: List[dict] = []
    for r in repos:
        url = _origin_url(r["path"])
        if url:
            by_remote.setdefault(url, []).append(r)
        else:
            standalone.append(r)

    kept: List[dict] = list(standalone)
    for url, group in by_remote.items():
        if len(group) == 1:
            kept.append(group[0])
            continue
        upstream_name = url.rsplit("/", 1)[-1]

        def depth(r: dict) -> int:
            try:
                return len(Path(r["path"]).resolve().relative_to(GITPROJECTS_DIR.resolve()).parts)
            except (ValueError, OSError):
                return 99

        # Name match first, then the shallowest checkout: a top-level clone is the
        # working copy, while nested ones (external/, vendor/) are reference copies.
        group.sort(key=lambda r: (r["repo"] != upstream_name, depth(r), len(r["repo"]), r["repo"]))
        winner, dropped = group[0], group[1:]
        logging.info(f"  {len(group)} checkouts of {url} — using {winner['label']}, "
                     f"ignoring {', '.join(d['label'] for d in dropped)}")
        kept.append(winner)
    return sorted(kept, key=lambda r: r["label"])


def read_manifest() -> str:
    manifest = LIBRARIAN_DIR / "MANIFEST.md"
    if manifest.exists():
        return manifest.read_text()
    # No librarian manifest has been generated — build one from the repos on disk so
    # repo routing still works (otherwise identify_repos has no repo list and guesses).
    repos = discover_local_repos()
    if not repos:
        return ""
    lines = ["# Available Repos", ""]
    for r in repos:
        lines.append(f"- {r['project']}/{r['repo']}")
    return "\n".join(lines)


def _available_repo_options(limit: int = 20) -> List[str]:
    """List 'project/repo' labels from the repos on disk, for repo-selection prompts."""
    options = [r["label"] for r in discover_local_repos()]
    return options[:limit]


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
    """Resolve a repo to a path on disk, tolerant of flat vs nested layout and of
    however the router split project/repo. Tries nested <root>/<project>/<repo>,
    then flat <root>/<repo>, then flat <root>/<project>.

    Also tolerates the common router mistake of stuffing a full "project/repo"
    label into the repo field (e.g. project="New UI", repo="GitProjects/backend-new-ui")
    by falling back to the trailing path segment and, finally, to a name match
    against the repos actually discovered on disk."""
    project = (project or "").strip().strip("/")
    repo = (repo or "").strip().strip("/")

    def _valid(p: Path) -> bool:
        # .git may be a dir (main clone) or a file (git worktree) — both are valid.
        return p.exists() and (p / ".git").exists()

    repo_base = repo.split("/")[-1] if repo else ""
    project_base = project.split("/")[-1] if project else ""

    candidates = []
    if project and repo:
        candidates.append(GITPROJECTS_DIR / project / repo)  # nested project/repo
    if repo:
        candidates.append(GITPROJECTS_DIR / repo)            # flat, by repo name (or label path)
        if repo_base and repo_base != repo:                  # label-in-repo → try trailing segment
            candidates.append(GITPROJECTS_DIR / repo_base)
    if project:
        candidates.append(GITPROJECTS_DIR / project)         # flat, by project name
        if project_base and project_base != project:
            candidates.append(GITPROJECTS_DIR / project_base)
    for candidate in candidates:
        if _valid(candidate):
            return candidate

    # Last resort: match by repo name against the repos actually on disk. Handles
    # any remaining router split we didn't anticipate as long as the repo name is right.
    wanted = {name for name in (repo, repo_base) if name}
    if wanted:
        for r in discover_local_repos():
            if r["repo"] in wanted:
                return r["path"]
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


_TREE_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".next", "dist", "build",
                   ".turbo", "coverage", "vendor"}


def _git_paths_at_ref(repo_path: Path, ref: str) -> List[str]:
    """Every tracked path at `ref`. Empty if the ref is unknown."""
    try:
        out = subprocess.run(["git", "ls-tree", "-r", "--name-only", ref],
                             cwd=str(repo_path), capture_output=True, text=True, timeout=60)
    except OSError:
        return []
    if out.returncode != 0:
        logging.warning(f"  Cannot read {ref} in {repo_path.name}: {out.stderr.strip()[:120]}")
        return []
    return [p for p in out.stdout.splitlines() if p]


def _git_show(repo_path: Path, ref: str, rel: str, max_chars: int) -> str:
    try:
        out = subprocess.run(["git", "show", f"{ref}:{rel}"],
                             cwd=str(repo_path), capture_output=True, text=True, timeout=30)
    except OSError:
        return ""
    if out.returncode != 0:
        return ""
    content = out.stdout
    if len(content) > max_chars:
        return content[:max_chars] + f"\n... (truncated, {len(content)} total chars)"
    return content


def _tree_from_paths(paths: List[str], depth: int = 3) -> List[str]:
    """A directory listing built from git paths rather than the filesystem, so it
    describes the branch the work will target instead of whatever is checked out."""
    seen: set = set()
    for p in paths:
        parts = p.split("/")
        if any(part in _TREE_SKIP_DIRS or part.startswith(".") for part in parts[:-1]):
            continue
        for i in range(min(len(parts), depth)):
            is_dir = i < len(parts) - 1
            seen.add(("/".join(parts[: i + 1]), is_dir))

    # Fill by depth, not alphabetically. A flat cap over sorted paths spends its whole
    # budget inside the first top-level directory — in a monorepo that hides most of
    # the apps, which is exactly what the reader needs to see.
    kept: List[tuple] = []
    for level in range(depth):
        at_level = sorted(e for e in seen if e[0].count("/") == level)
        if len(kept) + len(at_level) > 150:
            kept += at_level[: max(0, 150 - len(kept))]
            break
        kept += at_level

    lines = []
    for path, is_dir in sorted(kept):
        indent = "    " * path.count("/")
        name = path.rsplit("/", 1)[-1]
        lines.append(f"{indent}{name}/" if is_dir else f"{indent}{name}")
    return lines


def _target_app_paths(description: str) -> List[str]:
    """Sub-paths a task names as its target, from a 'Target app: `apps/new-ui`' line.

    In a monorepo the interesting code sits several levels below the root, past the
    depth the general listing reaches. Without this the planner cannot tell whether
    the thing it is planning already exists.
    """
    import re
    out = []
    for m in re.finditer(r"(?im)^\s*target (?:app|package|dir(?:ectory)?)\s*:\s*`?([^`\s,]+)", description or ""):
        p = m.group(1).strip().strip("/")
        if p and ".." not in p:
            out.append(p)
    return out[:3]


def _target_app_tree(repo_path: Path, ref: str, prefixes: List[str], limit: int = 160) -> str:
    """A deeper file listing for the task's target app, so the planner can see what
    already exists there rather than planning it from scratch."""
    if not prefixes:
        return ""
    paths = _git_paths_at_ref(repo_path, ref)
    if not paths:
        return ""
    sections = []
    for prefix in prefixes:
        under = [p for p in paths if p.startswith(prefix + "/")
                 and not any(part in _TREE_SKIP_DIRS for part in p.split("/"))]
        if not under:
            continue
        # Directories first, and all of them: they carry the structure that answers
        # "does this already exist?". A flat cap over sorted files truncates
        # alphabetically, which in a SvelteKit app hides src/routes behind src/lib.
        dirs = sorted({p.rsplit("/", 1)[0] for p in under if "/" in p})
        files = sorted(under)[:limit]
        body = "\n".join(dirs)
        if len(files) < len(under):
            body += f"\n\n{len(under)} files total; first {len(files)}:\n" + "\n".join(files)
        else:
            body += "\n\n" + "\n".join(files)
        sections.append(f"### Target app: {prefix} (at {ref})\n```\n{body}\n```")
    return "\n\n".join(sections)


def read_key_source_files_at_ref(repo_path: Path, ref: str) -> str:
    """Same shape as read_key_source_files, read out of a git ref.

    Triage and planning describe the branch the work will be based on. Reading the
    checkout instead means a monorepo app that only exists on a feature branch is
    invisible — the planner then writes tasks against a codebase the agent will
    never see.
    """
    paths = _git_paths_at_ref(repo_path, ref)
    if not paths:
        return ""

    sections = [f"### Directory Structure (at {ref})\n```\n" +
                "\n".join(_tree_from_paths(paths)) + "\n```"]
    total_chars = sum(len(s) for s in sections)

    by_name = {p.rsplit("/", 1)[-1]: p for p in reversed(paths)}  # prefer shallowest
    for name in KEY_FILE_NAMES:
        if total_chars >= MAX_CONTEXT_CHARS:
            break
        rel = name if name in paths else by_name.get(name, "")
        if not rel:
            continue
        content = _git_show(repo_path, ref, rel, MAX_FILE_CHARS)
        if content:
            sections.append(f"### {rel}\n```\n{content}\n```")
            total_chars += len(content)

    key_sources = [
        p for p in paths
        if not any(part in _TREE_SKIP_DIRS for part in p.split("/"))
        and any(pat in Path(p).stem.lower() for pat in KEY_SOURCE_PATTERNS)
    ][:15]
    for rel in key_sources:
        if total_chars >= MAX_CONTEXT_CHARS:
            break
        content = _git_show(repo_path, ref, rel, 1500)
        if content:
            sections.append(f"### {rel}\n```\n{content}\n```")
            total_chars += len(content)

    return "\n\n".join(sections)


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
    # Only surface questions that still need an answer — a follow-up round shouldn't
    # re-list questions the user has already answered.
    display_qs = [q for q in questions if not q.get("answer")]
    if display_qs:
        lines = ["**Needs clarification before work can begin:**\n"]
        for i, q in enumerate(display_qs, 1):
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
            logging.info(f"  Posted {len(display_qs)} question(s) as MC activity")
        except Exception as e:
            logging.warning(f"Failed to post questions to MC: {e}")

    now = datetime.now(timezone.utc).isoformat()

    existing_repos = []
    existing_questions: List[dict] = []
    try:
        existing_state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
        if existing_state and existing_state.get("triage_repos"):
            existing_repos = existing_state["triage_repos"]
        if existing_state and existing_state.get("questions"):
            existing_questions = existing_state["questions"]
    except Exception:
        pass

    new_repos = triage_result.get("repos", []) if triage_result else []

    triage_state = {
        # Merge rather than rebuild. Listing the fields by hand dropped everything
        # this function did not know about — an agent's reasoning, a deferral, the
        # conversation that was the reason a question was still open — so a second
        # round quietly erased the first.
        "questions": merge_questions(existing_questions, questions),
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


def _extract_ticket_id(title: str) -> str:
    import re
    match = re.search(r'[A-Z]+-\d+', title)
    return match.group(0) if match else "TICKET"


def _task_ref(task: dict) -> str:
    """Short reference for branches / worktree labels / PR titles. Prefer the
    ticket id (e.g. MET-532) so nothing is named after the opaque internal id;
    fall back to the task-id prefix only when there's no ticket."""
    ticket = _extract_ticket_id(task.get("title", ""))
    if ticket and ticket != "TICKET":
        return ticket
    return task.get("id", "")[:8] or "task"


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
        prompt += f"\nExternal reference: {linear_url}\n"

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

    gsd_name = backend_label()
    gsd_plan = gsd_plan_command()
    gsd_new_project = gsd_plan_command(greenfield=True)
    gsd_execute = gsd_execute_command()
    gsd_verify = gsd_verify_command()
    gsd_gap = gsd_gap_plan_command()
    gsd_plan_step = gsd_plan_step_text()

    prompt += f"""
## Mandatory Workflow ({gsd_name} + Review Loop)

You MUST follow this exact workflow. Do NOT skip steps. Do NOT write code before planning.
The loop continues until both GSD verification AND code review pass.

### Step 1: Plan
{gsd_plan_step}
This creates PLAN.md with task breakdown, must-haves, and verification criteria.
The plan-checker agent runs automatically to validate your plan before execution.
If plan-checker finds blockers, fix them before proceeding.

### Step 2: Execute
Run `{gsd_execute}` to implement with atomic commits.
Follow the plan. Do not deviate without documenting why.

### Step 3: Verify (GUARDRAIL — source of truth)
Run `{gsd_verify}` to verify against the ORIGINAL plan's must-haves.
This creates VERIFICATION.md with pass/fail status.
Do NOT proceed until verification passes.
If VERIFICATION.md shows `status: gaps_found`, run `{gsd_gap}`.
Repeat until `status: passed`.

### Step 4: Self-Review (code-review-graph)
If the `code-review-graph` MCP server is available:
1. Use the `get_review_context` tool on your changed files to check blast radius
2. Use `query_graph` with `tests_for` to identify missing test coverage
3. Fix any issues found (missing tests, unintended impacts)
4. After fixing, RE-RUN `{gsd_verify}` — fixes must not break original acceptance criteria
5. If a fix conflicts with the original plan, DO NOT apply it. Log it as a note for human review.

### Step 5: Pre-PR Validation
Run the same checks that GitHub Actions CI will run:
1. Check `.github/workflows/` for the repo's CI configuration
2. Run equivalent checks locally (e.g. `tsc --noEmit`, `npm run lint`, `npm test`, `pytest`, etc.)
3. If any check fails, fix and re-run until all pass

### Step 6: Codex Review
Run the pre-review script to get an external Codex review on your branch diff
(reviewed against the branch you based on):
```bash
                ~/.mission-control/swarm/pre-review.sh "$(pwd)" "${{BASE_BRANCH:-origin/master}}"
```
Read the output. If VERDICT is FAIL:
1. Fix the issues identified
2. RE-RUN `{gsd_verify}` — fixes must not break original acceptance criteria
3. If a review suggestion conflicts with the plan's acceptance criteria, skip it and note: "Skipped review suggestion X — conflicts with acceptance criteria Y"
4. Re-run pre-review.sh after fixes
5. Maximum 3 review iterations. If still failing after 3, escalate to human (see below).

### Step 7: {"Finish + Report" if _pr_is_disabled(task) else "PR + Report"}
Only when GSD verification passes AND review passes (or max iterations reached):
1. Commit all changes with conventional commit messages
{'''2. Do NOT push, and do NOT open a pull request. This work stays local — leave it
   committed on your branch in the worktree. Pushing or opening a PR publishes work
   the owner has explicitly asked to keep unpublished.
3. Report completion to Mission Control:''' if _pr_is_disabled(task) else f'''2. Push your branch
3. Create a PR with `gh pr create` — title MUST start with `[{_task_ref(task)}]`
4. Report completion to Mission Control:'''}
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
Mission Control will pause this task and wait for a human response before resuming.

### Reporting Progress (encouraged)
Keep the Mission Control board accurate by reporting structured progress as you work:
```bash
curl -X PUT {MC_BASE_URL}/api/tasks/{task['id']}/progress \\
  -H "Content-Type: application/json" \\
  -d '{{"state": "running", "phase": "execute", "step_label": "WHAT_YOU_ARE_DOING_NOW"}}'
```
If you get stuck, set `"state": "blocked"` with a short `"blocked_reason"` so it shows on the board.

### Delegating a Subtask
If you are blocked on something OUTSIDE this task's scope — a separate repo, or an
unknown failure that first needs investigation — delegate a focused subtask instead
of guessing. Mission Control dispatches it as its own agent and feeds the result back:
```bash
curl -X POST {MC_BASE_URL}/api/tasks/{task['id']}/delegate \\
  -H "Content-Type: application/json" \\
  -d '{{"title": "SHORT_TITLE", "description": "WHAT_THE_SUBTASK_SHOULD_FIND_OR_DO", "task_type": "investigation", "reason": "WHY", "wait": true}}'
```
With `"wait": true` this task pauses until the subtask finishes; the subtask's result
appears in this task's activity history when it resumes. Use delegation for genuinely
separable work — not to avoid the core task.

### Requesting Approval / a Decision (checkpoint)
Before doing something risky or ambiguous (a destructive action, a design choice
with real trade-offs, anything you'd want a human to sign off on), raise a
checkpoint and STOP. The human is notified, and this task pauses until they decide:
```bash
curl -X POST {MC_BASE_URL}/api/tasks/{task['id']}/checkpoints \\
  -H "Content-Type: application/json" \\
  -d '{{"kind": "approval", "prompt": "THE_DECISION_OR_ACTION_TO_APPROVE"}}'
```
The task resumes automatically once the human resolves it; their decision
(approved / rejected / answer) appears in this task's activity history. Read it on
resume and proceed accordingly — if rejected, do NOT take the action.

## Constraints
- Do NOT modify unrelated files
- Do NOT add new dependencies without justification
- Follow existing code patterns and conventions
- Commit messages: conventional commits format
- PR title MUST start with the ticket ID in brackets (e.g. `[{_task_ref(task)}] ...`)
- GSD verification is the source of truth — review fixes must not break it
"""
    return (prompt + _image_prompt_section(task) + _design_prompt_section(task)
            + _video_prompt_section(task) + _attachment_prompt_section(task))


def generate_investigation_prompt(task: dict, repo_context: str, project: str, repo: str,
                                   knowledge: Optional[dict] = None) -> str:
    title = task["title"]
    description = task.get("description", "")
    linear_url = task.get("external_url") or task.get("linear_issue_url", "")
    ticket_id = _task_ref(task)

    prompt = f"""# Investigation: {title}

## Context
{description}
"""
    if linear_url:
        prompt += f"\nExternal reference: {linear_url}\n"

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


def _base_branch_override(task: dict) -> str:
    """The task's explicitly pinned base branch, or "" if it has none.

    Separate from _resolve_base_branch because triage needs the override WITHOUT
    the repo-default fallback: with no pin, reading the checkout is the honest
    default; with a pin, the checkout is the wrong tree to describe.

    Sources, in order:
      1) triage_state.base_branch
      2) a 'Base branch: <name>' line in the description (durable across triage)
    """
    def _norm(bb: str) -> str:
        bb = bb.strip().rstrip("/")
        return bb if bb.startswith("origin/") else f"origin/{bb}"
    try:
        raw = task.get("triage_state")
        state = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw if isinstance(raw, dict) else {})
        bb = ((state or {}).get("base_branch") or "").strip()
        if bb:
            return _norm(bb)
    except Exception:
        pass
    try:
        import re
        m = re.search(r"(?im)^\s*base[- ]?branch:\s*(\S+)\s*$", task.get("description", "") or "")
        if m:
            return _norm(m.group(1))
    except Exception:
        pass
    return ""


def _resolve_base_branch(task: dict, repo_path: Path) -> str:
    """Base branch for the worktree + PR target: the task's pin, else the repo default."""
    return _base_branch_override(task) or detect_base_branch(repo_path)


# Trusted host(s) for ticket-attachment downloads. A ticket description is
# attacker-influenceable (anyone who can edit the ticket), so downloads are locked to
# an EXACT host over https — a substring match would allow look-alikes like
# uploads.linear.app.evil.com and leak the Authorization token there.
_ALLOWED_UPLOAD_HOSTS = {"uploads.linear.app"}


class _UploadNoRedirect(urllib.request.HTTPRedirectHandler):
    # Never follow redirects: one could bounce our Authorization header to an
    # attacker host or an internal address.
    def redirect_request(self, *args, **kwargs):
        return None


def _upload_host_public(host: str) -> bool:
    """Reject a host that resolves to any non-public address (defense in depth
    against DNS-rebinding to an internal target, on top of the host allowlist)."""
    import socket as _socket
    import ipaddress as _ip
    try:
        infos = _socket.getaddrinfo(host, 443, proto=_socket.IPPROTO_TCP)
    except Exception:
        return False
    for info in infos:
        try:
            addr = _ip.ip_address(info[4][0])
        except ValueError:
            return False
        if (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_unspecified or addr.is_reserved or addr.is_multicast):
            return False
    return bool(infos)


def _fetch_trusted_upload(url: str, dest: "Path", timeout: int = 30) -> Optional[str]:
    """Securely download a ticket attachment to `dest`. Returns the response
    Content-Type on success, None otherwise. Enforces: https-only, exact trusted
    host, no redirects, non-public-IP rejection. The LINEAR_API_KEY is only ever
    sent after the host is verified."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or host not in _ALLOWED_UPLOAD_HOSTS:
            return None  # untrusted or non-https reference — skip
        if not _upload_host_public(host):
            logging.warning(f"  Skipping upload host {host} — resolves to a non-public address")
            return None
        req = urllib.request.Request(url)
        key = os.environ.get("LINEAR_API_KEY", "").strip()
        if key:  # host verified above, so the token only goes to Linear
            req.add_header("Authorization", key)
        opener = urllib.request.build_opener(_UploadNoRedirect)
        with opener.open(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type", "") or "").split(";")[0].strip()
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.read())
            return ctype
    except Exception as e:
        logging.warning(f"  Failed to download upload {url[:60]}: {e}")
        return None


def _download_task_images(task: dict) -> List[dict]:
    """Download images referenced in a task description (markdown ![](url)) so a
    vision-capable agent can actually see them. Linear-hosted uploads need the
    LINEAR_API_KEY. Saved under SWARM_DIR/assets/<task>/; best-effort."""
    import re
    desc = task.get("description", "") or ""
    matches = re.findall(r"!\[([^\]]*)\]\((https?://[^)\s]+)\)", desc)
    if not matches:
        return []
    assets_dir = SWARM_DIR / "assets" / (task.get("id", "task")[:8] or "task")
    ext_map = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
    out: List[dict] = []
    for i, (alt, url) in enumerate(matches, 1):
        tmp = assets_dir / f"img-{i}.bin"
        ctype = _fetch_trusted_upload(url, tmp)
        if not ctype or "image" not in ctype:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
            continue
        path = assets_dir / f"img-{i}.{ext_map.get(ctype, 'png')}"
        try:
            tmp.replace(path)
        except Exception:
            continue
        out.append({"alt": alt or f"image {i}", "path": str(path)})
    if out:
        logging.info(f"  Downloaded {len(out)} ticket image(s) for {task.get('id', '')[:8]}")
    return out


# Video attachments (screencasts) can't be read by the model directly, so we
# convert them to keyframes with ffmpeg and feed those images instead — the same
# "make it readable" move used for Paper/Figma designs.
_VIDEO_EXTS = (".webm", ".mp4", ".mov", ".m4v", ".avi", ".mkv")


def _ffmpeg_bin() -> Optional[str]:
    return shutil.which("ffmpeg") or next(
        (p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg")
         if os.path.exists(p)), None)


def _video_duration_secs(video_path: "Path") -> Optional[float]:
    """Clip duration via ffprobe (ships with ffmpeg), or None if unavailable."""
    probe = shutil.which("ffprobe") or next(
        (p for p in ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe")
         if os.path.exists(p)), None)
    if not probe:
        return None
    try:
        out = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(video_path)],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        return float((out.stdout or "").strip())
    except Exception:
        return None


def _gather_video_links(task: dict) -> List[Tuple[str, str]]:
    """Return (label, url) for trusted-host video attachments in the description.
    Linear renders a video as a plain markdown link [name.webm](url) — not ![]() —
    so we detect by the link-text filename extension."""
    import re
    desc = task.get("description", "") or ""
    out: List[Tuple[str, str]] = []
    seen = set()
    # [label](url) links whose visible label looks like a video filename.
    for label, url in re.findall(r"(?<!\!)\[([^\]]*)\]\((https?://[^)\s]+)\)", desc):
        if url in seen:
            continue
        if label.lower().strip().endswith(_VIDEO_EXTS):
            out.append((label.strip() or "video", url))
            seen.add(url)
    return out


def _extract_video_frames(video_path: "Path", out_dir: "Path", max_frames: int = 10) -> List["Path"]:
    """Extract keyframes evenly across a video so the whole demonstrated flow is
    covered (scene-cut detection misses visually-similar states like an empty vs.
    filled input, which matter in a spec). Returns frame paths in order. Requires
    ffmpeg; returns [] if unavailable."""
    ff = _ffmpeg_bin()
    if not ff:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("frame-*.png"):
        try:
            old.unlink()
        except Exception:
            pass

    # Spread max_frames evenly across the clip's duration; fall back to a fixed
    # cadence when the duration can't be probed.
    dur = _video_duration_secs(video_path)
    if dur and dur > 0:
        fps = min(max_frames / dur, 4.0)  # cap so a very short clip doesn't over-sample
    else:
        fps = 0.5
    vf = f"fps={fps:.4f},scale='min(1280,iw)':-2"
    try:
        subprocess.run(
            [ff, "-y", "-i", str(video_path), "-vf", vf, "-vsync", "vfr",
             "-frames:v", str(max_frames), str(out_dir / "frame-%03d.png")],
            capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
    except Exception as e:
        logging.warning(f"  ffmpeg frame extraction failed: {e}")
    return sorted(out_dir.glob("frame-*.png"))


def _gather_video_frames(task: dict) -> List[dict]:
    """Download each video attachment and extract keyframes. Returns frame dicts
    {alt, path} across all videos, cached on disk so re-runs skip re-extraction."""
    links = _gather_video_links(task)
    if not links:
        return []
    base = SWARM_DIR / "assets" / (task.get("id", "task")[:8] or "task")
    out: List[dict] = []
    for vi, (label, url) in enumerate(links, 1):
        frame_dir = base / f"video-{vi}-frames"
        frames = sorted(frame_dir.glob("frame-*.png"))
        if not frames:  # not cached yet — download + extract
            video_path = base / f"video-{vi}.mp4"
            ctype = _fetch_trusted_upload(url, video_path)
            if not ctype or "video" not in ctype:
                logging.warning(f"  Attachment {label} is not a downloadable video (ctype={ctype})")
                continue
            frames = _extract_video_frames(video_path, frame_dir)
            try:
                video_path.unlink()  # keep only the frames
            except Exception:
                pass
        for fi, fp in enumerate(frames, 1):
            out.append({"alt": f"{label} — frame {fi}/{len(frames)}", "path": str(fp)})
    if out:
        logging.info(f"  Extracted {len(out)} video frame(s) for {task.get('id', '')[:8]}")
    return out


def _claude_bin() -> str:
    return shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")


_DESIGN_LINK_RE = r"https?://(?:[a-z0-9-]+\.)?(?:paper\.design|figma\.com|figma\.design)/\S+"


def _design_links(text: str) -> List[str]:
    import re
    links = re.findall(_DESIGN_LINK_RE, text or "", re.IGNORECASE)
    return [l.rstrip(').,>]') for l in dict.fromkeys(links)]


def _gather_design_links(task_id: str, description: str) -> List[str]:
    """Design links from the task's COMMENTS (newest first) and the description.
    Designers often post — or update — the real design link in a comment rather than
    the description, so the most recent comment link should win."""
    links: List[str] = []
    try:
        acts = mc_request("GET", f"/api/tasks/{task_id}/activities") or []
        acts = sorted(acts, key=lambda a: a.get("created_at", ""), reverse=True)
        for a in acts:
            if a.get("activity_type") in ("linear_comment", "manual_feedback", "updated", "planning_answer"):
                links += _design_links(a.get("message", ""))
    except Exception:
        pass
    links += _design_links(description or "")
    return list(dict.fromkeys(links))  # dedup, newest-first


_PAPER_READ_TOOLS = [
    "open_file", "list_files", "get_basic_info", "get_selection", "get_node_info",
    "get_children", "get_screenshot", "get_jsx", "get_tree_summary", "get_computed_styles",
    "get_fill_image", "find_nodes", "get_font_family_info", "get_guide", "get_tokens",
    "finish_working_on_nodes",
]


def _mcp_tool_prefix(server_name: str) -> str:
    """Tool prefix Claude Code gives an MCP server. Plugin-provided servers are named
    `plugin:<plugin>:<server>`, and the colons become underscores in tool names —
    `plugin:paper-desktop:paper` serves `mcp__plugin_paper-desktop_paper__open_file`."""
    return f"mcp__{server_name.replace(':', '_')}__"


def _design_mcp_allowlist() -> str:
    """Read-only design tools to expose to the summarizer, resolved from the CLI's
    actually-connected servers.

    Server names are not fixed: Paper installed as a plugin is `plugin:paper-desktop:paper`,
    standalone it is `paper`. Hardcoding one spelling silently yields an allowlist that
    matches nothing — the summarizer then reports the design as unreachable and triage
    asks the user a question the tooling could have answered itself.
    """
    servers: List[str] = []
    try:
        out = subprocess.run([_claude_bin(), "mcp", "list"],
                             capture_output=True, text=True, timeout=90,
                             stdin=subprocess.DEVNULL)
        for line in (out.stdout or "").splitlines():
            name, sep, rest = line.partition(":")
            # "<name>: <url> - ✔ Connected" — only take servers reported healthy.
            if not sep or "Connected" not in rest or "Failed" in rest:
                continue
            name = line.rsplit(" - ", 1)[0].rsplit(": ", 1)[0].strip()
            if name:
                servers.append(name)
    except Exception as e:
        logging.debug(f"  Could not list MCP servers: {e}")

    allowed: List[str] = []
    for name in servers:
        low = name.lower()
        prefix = _mcp_tool_prefix(name)
        if "paper" in low:
            allowed += [prefix + t for t in _PAPER_READ_TOOLS]
        elif "figma" in low:
            allowed.append(prefix + "*")

    if not allowed:
        # Nothing resolvable — fall back to the bare names so a standalone install
        # still works, and so the summarizer can report the design as unreachable.
        allowed = [f"mcp__paper__{t}" for t in _PAPER_READ_TOOLS] + ["mcp__figma__*"]
    return ",".join(allowed)


def _design_prompt_section(task: dict) -> str:
    """If the ticket references a design (Paper or Figma) — in the description OR a
    comment — tell the agent to read the real spec AND extract its image assets via
    the matching design MCP. Injected into every design-working agent, so the asset
    protocol below applies uniformly."""
    links = _gather_design_links(task.get("id", ""), task.get("description", ""))
    if not links:
        return ""
    has_figma = any("figma." in l.lower() for l in links)
    has_paper = any("paper.design" in l.lower() for l in links)
    tools = []
    if has_paper:
        tools.append("Paper → `paper` MCP: `open_file` (at the referenced page), then "
                     "`get_jsx`/`get_computed_styles`/`get_tokens`/`get_screenshot`; `finish_working_on_nodes` when done.")
    if has_figma:
        tools.append("Figma → the `figma` MCP (Dev Mode): open the node/link, then pull code/styles/variables "
                     "and a screenshot for the referenced frame.")

    # Asset-export steps, per tool. A design is NOT matched if its imagery is faked,
    # so this is mandatory and self-reporting (gaps must be surfaced, never hidden).
    export_steps = []
    if has_paper:
        export_steps.append(
            "   - Paper: find nodes whose fill/background is an image (names often look like "
            "`magnific_*`, `freepik_*`, or reference a `file-assets/*.png`). Export EACH with "
            "`get_fill_image` and save it into the app's static assets."
        )
    if has_figma:
        export_steps.append(
            "   - Figma: every image fill / exported asset is served by Dev Mode via localhost asset "
            "URLs that appear in `get_code`/image output — fetch each and save it into the app's static assets."
        )

    return "\n\n---\n## Design source — READ THE SPEC AND EXTRACT ITS ASSETS (via the design MCP)\n" + (
        "This ticket references a design you cannot fetch over the web. Use the design MCP:\n"
        f"- Link(s), most recent first (prefer the latest — a comment link supersedes the description): {', '.join(links[:6])}\n"
        + "".join(f"- {t}\n" for t in tools)
        + "- Note Figma links carry a `node-id` — open that exact node/frame.\n"
        + "- Match the design's spacing, colors, and type via its tokens/variables where they exist.\n\n"
        "### Image assets — MANDATORY, do not skip\n"
        "The design contains real image assets (photos, 3D renders, logos, illustration/section art). "
        "Bring them into the repo and use them — the page is NOT done if its imagery is faked with a "
        "placeholder, watermark, icon, or solid color.\n"
        "1. ENUMERATE every raster/image-fill node in the referenced frame(s) — hero/background renders, "
        "section art, logos, avatars. Query the design tree for image fills; do NOT judge from the screenshot alone.\n"
        "2. EXPORT each one and save it under the app's static assets, then reference the saved file in the component:\n"
        + "\n".join(export_steps) + "\n"
        "3. Use the REAL exported assets in the built UI — never substitute a placeholder for a design image.\n"
        "4. If an asset genuinely cannot be exported (tool error, missing source in the design), DO NOT silently "
        "swap in a placeholder. List it explicitly in the PR description under a `Missing design assets:` heading "
        "(node name + where it belongs) so it's caught and followed up. A silent placeholder is a defect."
    )


def _design_context(task_id: str, description: str) -> str:
    """During triage: if the task links a design (Paper/Figma) — in the description or a
    comment — read a concise summary via the available design MCP so triage asks
    design-specific questions. Best-effort; gated by ENABLE_DESIGN_TRIAGE (default on)."""
    if os.environ.get("ENABLE_DESIGN_TRIAGE", "1") != "1":
        return ""
    links = _gather_design_links(task_id, description)
    if not links:
        return ""
    urls = links[:3]
    prompt = (
        "READ-ONLY design summary for engineering triage. Use the available design MCP "
        "(paper or figma) to open the linked design(s). Do NOT modify anything.\n"
        "Links:\n" + "\n".join(f"- {u}" for u in urls) + "\n\n"
        "Open each at the referenced page/frame, then output a CONCISE summary (under 200 words): the "
        "screens/frames present, distinct states or responsive variants (desktop/mobile, empty/error/loading), "
        "key text/labels, and anything ambiguous a human should clarify before building. "
        "If you cannot reach a design MCP for a link, note 'NOT ACCESSIBLE: <url>'.\n\n"
        "Figma tips (Dev Mode MCP): a link carries a `node-id` (e.g. 4255-18171 — dashes, not colons); "
        "open THAT exact node. `get_design_context`/`get_code` TIME OUT on large frames — do NOT call them "
        "on a whole page. Instead pull `get_metadata` + `get_screenshot` + `get_variable_defs` on the node "
        "(fast, reliable); only reach for code/context on a small child node if you need exact values. "
        "Prefer the metadata tree + screenshot to describe layout/text."
    )
    # Constrain this summarizer to ONLY the design MCP's read tools — no permission
    # bypass, no Bash/Write/Edit, no design-mutating tools. It processes untrusted
    # design content, so its tool surface must stay minimal.
    allowed = _design_mcp_allowlist()
    try:
        out = subprocess.run(
            [_claude_bin(), "-p", "--allowedTools", allowed, "--max-turns", "25", prompt],
            capture_output=True, text=True, timeout=240, stdin=subprocess.DEVNULL)
        summary = (out.stdout or "").strip()
        if summary and len(summary) > 40:
            return f"\n\n---\n\n## Linked design summary (read from the design tool)\n{summary[:2500]}"
    except Exception as e:
        logging.warning(f"  Design triage context failed: {e}")
    return ""


# File attachments other than inline images/videos — handoff packages, provided code,
# spec docs, asset zips. Images/videos are handled by their own sections.
_ATTACH_SKIP_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg") + _VIDEO_EXTS
_ATTACH_MAX_BYTES = 25 * 1024 * 1024  # skip anything larger — not a handoff, and a zip-bomb guard


def _gather_attachment_links(task: dict) -> List[Tuple[str, str]]:
    """(label, url) for trusted-host FILE attachments in the description AND comments
    (a handoff zip, provided code, a spec doc), newest comment first. Excludes inline
    images/videos, which have their own handling."""
    import re
    texts: List[str] = []
    try:
        acts = mc_request("GET", f"/api/tasks/{task.get('id','')}/activities") or []
        acts = sorted(acts, key=lambda a: a.get("created_at", ""), reverse=True)
        for a in acts:
            if a.get("activity_type") in ("linear_comment", "manual_feedback", "updated", "planning_answer"):
                texts.append(a.get("message", ""))
    except Exception:
        pass
    texts.append(task.get("description", "") or "")

    out: List[Tuple[str, str]] = []
    seen = set()
    for text in texts:
        for label, url in re.findall(r"\[([^\]]*)\]\((https?://[^)\s]+)\)", text or ""):
            if url in seen:
                continue
            name = label.strip().lower()
            if not name or name.endswith(_ATTACH_SKIP_EXTS):
                continue
            if "." not in name.split("/")[-1]:  # needs a file extension to be an attachment
                continue
            out.append((label.strip(), url))
            seen.add(url)
    return out


# Media inside a handoff is bulky and rarely what the agent needs to read. Source
# and docs are the point of the package, so they get first claim on the budget.
_BULK_MEMBER_EXTS = _VIDEO_EXTS + (".png", ".jpg", ".jpeg", ".gif", ".webp",
                                   ".woff", ".woff2", ".ttf", ".otf", ".zip", ".pdf")


def _safe_extract_zip(zip_path: "Path", dest: "Path") -> List["Path"]:
    """Extract a zip, rejecting path-traversal ('zip slip') entries and capping total
    size. Returns the extracted file paths.

    Members are taken smallest-useful-first: text and source ahead of media. A member
    that would blow the budget is skipped and extraction continues, rather than
    stopping — a couple of large videos early in the archive would otherwise consume
    the whole cap and drop the handoff doc and source the package exists to deliver.
    """
    import zipfile
    extracted: List["Path"] = []
    skipped: List[str] = []
    dest_root = dest.resolve()
    total = 0
    try:
        with zipfile.ZipFile(zip_path) as z:
            # Zips made on macOS carry a parallel __MACOSX/._name entry for every file.
            # They are resource forks, never content, and they double the manifest.
            members = [i for i in z.infolist()
                       if not i.is_dir()
                       and not i.filename.startswith("__MACOSX/")
                       and not Path(i.filename).name.startswith("._")]
            members.sort(key=lambda i: (i.filename.lower().endswith(_BULK_MEMBER_EXTS),
                                        i.file_size, i.filename))
            for info in members:
                target = (dest / info.filename).resolve()
                if not str(target).startswith(str(dest_root) + os.sep) and target != dest_root:
                    logging.warning(f"  Skipping unsafe zip entry {info.filename}")
                    continue
                if total + info.file_size > _ATTACH_MAX_BYTES:
                    skipped.append(info.filename)
                    continue
                total += info.file_size
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(target, "wb") as dst:
                    dst.write(src.read())
                extracted.append(target)
    except Exception as e:
        logging.warning(f"  Failed to extract zip {zip_path.name}: {e}")
    if skipped:
        # Never silent: an agent told to "use the provided implementation" needs to
        # know which parts of it it never received.
        logging.warning(f"  Zip size cap reached — skipped {len(skipped)} member(s): "
                        + ", ".join(skipped[:5]) + ("…" if len(skipped) > 5 else ""))
    return extracted


def _download_task_attachments(task: dict) -> List[dict]:
    """Download trusted-host file attachments (from description + comments), extracting
    zips. Returns {label, path, kind} for each usable file, cached on disk."""
    links = _gather_attachment_links(task)
    if not links:
        return []
    base = SWARM_DIR / "assets" / (task.get("id", "task")[:8] or "task") / "attachments"
    out: List[dict] = []
    for i, (label, url) in enumerate(links, 1):
        safe_name = __import__("re").sub(r"[^A-Za-z0-9._-]", "_", label) or f"file-{i}"
        is_zip = label.lower().endswith(".zip")
        marker = base / (safe_name + (".d" if is_zip else ""))
        if not marker.exists():
            tmp = base / f".dl-{i}"
            ctype = _fetch_trusted_upload(url, tmp)
            if not ctype:
                continue
            if is_zip:
                extract_dir = base / (safe_name + ".d")
                _safe_extract_zip(tmp, extract_dir)
                try:
                    tmp.unlink()
                except Exception:
                    pass
            else:
                try:
                    tmp.replace(base / safe_name)
                except Exception:
                    continue
        # Collect the resulting file(s).
        if is_zip:
            extract_dir = base / (safe_name + ".d")
            for fp in sorted(extract_dir.rglob("*")):
                if fp.is_file():
                    out.append({"label": f"{label} → {fp.name}", "path": str(fp), "kind": "zip-member"})
        else:
            fp = base / safe_name
            if fp.exists():
                out.append({"label": label, "path": str(fp), "kind": "file"})
    if out:
        logging.info(f"  Prepared {len(out)} attachment file(s) for {task.get('id', '')[:8]}")
    return out


def _attachment_prompt_section(task: dict) -> str:
    """Prompt appendix for ticket file attachments (handoff zips, provided code, docs).
    The agent must READ and USE these — a provided implementation is not to be reinvented."""
    files = _download_task_attachments(task)
    if not files:
        return ""
    lines = [
        "\n\n---\n## Ticket attachments — READ THESE (they are the reference, not the code to ship)",
        "The ticket supplies a handoff, prototype, or spec. Read every one and follow what it "
        "specifies: exact values, tokens, layout rules, interaction and motion behaviour, copy, "
        "and assets. Read any README or handoff doc first.",
        "",
        "**The repository's stack wins.** A supplied prototype shows HOW it should work, not what "
        "to install. Build it in the framework, conventions and dependencies the target app "
        "already uses — never introduce the prototype's framework, and never copy its components "
        "in verbatim when the app is written in something else. Port the behaviour.",
        "",
        "The one exception is an explicit, approved stack change: the ticket description asks for "
        "one in so many words AND a human has agreed to it in the ticket's answered questions. "
        "An attachment arriving in some other framework is NOT such a request — a prototype's "
        "choice of framework carries no authority. If you believe a stack change is needed and "
        "has not been approved, stop and raise it rather than making it.",
        "",
        "Assets and framework-agnostic files — fonts, SVGs, images, plain CSS, design tokens — "
        "should be reused directly rather than recreated.",
        "",
        "Files:",
    ]
    for i, f in enumerate(files, 1):
        lines.append(f"{i}. {f['label']} — `{f['path']}`")
    return "\n".join(lines)


# Docs inside a handoff answer scoping questions directly, so they are worth reading
# during triage. Source is not: it is what the builder needs, and it would crowd out
# everything else in a triage prompt.
_TRIAGE_DOC_EXTS = (".md", ".txt", ".rst", ".adoc")
_ATTACH_TRIAGE_MAX_CHARS = 7000


def _attachment_triage_context(task: dict) -> str:
    """Triage context for ticket attachments: the file manifest, plus the docs.

    An attached handoff is itself a strong signal — it usually settles the very
    questions triage would otherwise put to a human ("where should the tokens live?"
    when the package ships the stylesheet). Without this, triage asks the user for
    what the ticket already supplied.

    Content here is untrusted in the same way the ticket description is: anyone who
    can edit the ticket can shape it. It informs questions, never permissions.
    """
    files = _download_task_attachments(task)
    if not files:
        return ""

    names = [f["label"].split("→")[-1].strip() for f in files]
    paths = [Path(f["path"]) for f in files]
    manifest = ", ".join(sorted(set(names))[:60])

    parts = [
        f"\n\n---\n\n## Ticket attachments ({len(files)} file(s))",
        "The ticket supplies these files. Anything they specify outright is already answered "
        "— do not ask the user to repeat it.",
        # Narrow suppression, deliberately. Prototypes routinely arrive in a different
        # framework from the target app; that is settled policy, not a question. Stating
        # it loosely ("everything is settled") makes triage stop asking altogether and
        # dispatch work nobody scoped.
        "ONE thing is settled in advance: these are REFERENCE for behaviour, values and "
        "design, not the code to ship. The target app's existing stack wins and the builder "
        "ports the behaviour into it, so a prototype written in a different framework is "
        "expected. Do not raise the framework difference as a question.",
        "That settles the framework and NOTHING else. Keep asking about everything the "
        "artifacts leave genuinely open — missing assets they reference, undefined states or "
        "breakpoints, release gating, anything contradicting the repo. A supplied handoff "
        "narrows the questions; it does not remove the duty to ask them.",
        "The exception runs the other way: if the DESCRIPTION itself explicitly asks to change "
        "the target app's stack, that is a large, irreversible call — ask the human to confirm "
        "it before any work is planned. An attachment's framework is never such a request.",
        f"\n**Contents:** {manifest}",
    ]

    budget = _ATTACH_TRIAGE_MAX_CHARS
    # Shortest docs first, so one long README cannot crowd out the rest.
    docs = sorted((p for p in paths if p.suffix.lower() in _TRIAGE_DOC_EXTS
                   and not p.name.startswith(".")),
                  key=lambda p: p.stat().st_size if p.exists() else 0)
    for doc in docs:
        if budget <= 0:
            break
        try:
            text = doc.read_text(errors="replace")[:budget]
        except Exception:
            continue
        if not text.strip():
            continue
        parts.append(f"\n### {doc.name}\n{text}")
        budget -= len(text)
    return "\n".join(parts)


def _image_prompt_section(task: dict) -> str:
    """A prompt appendix listing downloaded ticket images by absolute path, so the
    agent (Claude can read image files) opens them for the visual details."""
    imgs = _download_task_images(task)
    if not imgs:
        return ""
    lines = ["\n\n---\n## Ticket screenshots (IMPORTANT — key visual detail is here)",
             "The ticket includes screenshots. Open/read each image file below (your Read"
             " tool can view images) to see the exact UI and wording being referred to:"]
    for i, im in enumerate(imgs, 1):
        lines.append(f"{i}. {im['alt']} — `{im['path']}`")
    return "\n".join(lines)


def _video_prompt_section(task: dict) -> str:
    """A prompt appendix for ticket video attachments (screencasts). The model can't
    play video, so we hand it the extracted keyframes (in order) to read."""
    links = _gather_video_links(task)
    if not links:
        return ""
    frames = _gather_video_frames(task)
    if not frames:
        # A video is attached but we couldn't turn it into frames (ffmpeg missing or
        # download failed) — tell the agent rather than let it silently miss the spec.
        names = ", ".join(l for l, _ in links)
        return ("\n\n---\n## Ticket video — COULD NOT PROCESS\n"
                f"This ticket's spec includes a screencast ({names}) that could not be "
                "converted to frames. Do NOT guess the flow — flag that the video needs "
                "a human summary or a design link before implementing.")
    has_design = bool(_gather_design_links(task.get("id", ""), task.get("description", "")))
    if has_design:
        header = ("\n\n---\n## Ticket screencast — SUPPLEMENTARY CONTEXT (flow/behavior)\n"
                  "A screen recording accompanies this ticket. The linked DESIGN is the source "
                  "of truth for layout, spacing, copy, and visuals — use the video only to "
                  "understand interaction, sequence, and dynamic behavior. Where the video and "
                  "the design disagree, FOLLOW THE DESIGN. The recording is split into ordered "
                  "keyframes; read each IN ORDER:")
    else:
        header = ("\n\n---\n## Ticket screencast — THE SPEC IS IN THIS VIDEO\n"
                  "The ticket's requirements are demonstrated in a screen recording. The model "
                  "can't play video, so the recording has been split into ordered keyframes. "
                  "Read each frame file below IN ORDER to reconstruct the exact flow, UI, and wording:")
    lines = [header]
    for i, fr in enumerate(frames, 1):
        lines.append(f"{i}. {fr['alt']} — `{fr['path']}`")
    return "\n".join(lines)


def _video_context(task_id: str, description: str) -> str:
    """During triage: if the ticket attaches a video, extract keyframes and have a
    headless vision agent summarize the demonstrated flow, so triage asks specific
    questions instead of 'what does the screencast show?'. Best-effort."""
    if os.environ.get("ENABLE_DESIGN_TRIAGE", "1") != "1":
        return ""
    task = {"id": task_id, "description": description}
    links = _gather_video_links(task)
    if not links:
        return ""
    frames = _gather_video_frames(task)
    if not frames:
        names = ", ".join(l for l, _ in links)
        return ("\n\n---\n\n## Ticket video (NOT PROCESSED)\n"
                f"A screencast ({names}) is the spec but could not be converted to frames. "
                "Ask the human to describe the flow step-by-step or link a design — do not "
                "assume the requirements.")
    frame_paths = [f["path"] for f in frames]
    prompt = (
        "READ-ONLY analysis for engineering triage. The image files below are ordered "
        "keyframes from a screen recording that IS the ticket's spec. Read them IN ORDER "
        "with your Read tool and output a CONCISE summary (under 200 words): the user flow "
        "step-by-step, the screens/states shown, key UI elements and text/labels, and "
        "anything ambiguous a human should clarify before building. Frames:\n"
        + "\n".join(f"- {p}" for p in frame_paths)
    )
    try:
        out = subprocess.run(
            [_claude_bin(), "-p", "--allowedTools", "Read", "--max-turns", "25", prompt],
            capture_output=True, text=True, timeout=240, stdin=subprocess.DEVNULL)
        summary = (out.stdout or "").strip()
        if summary and len(summary) > 40:
            note = ""
            if _gather_design_links(task_id, description):
                note = ("\n_(Supplementary: a design doc is also linked and is the source of "
                        "truth for layout/visuals — use this video only for flow/behavior.)_\n")
            return (f"\n\n---\n\n## Ticket screencast summary (read from extracted frames)"
                    f"{note}\n{summary[:2500]}")
    except Exception as e:
        logging.warning(f"  Video triage context failed: {e}")
    return ""


def _pr_is_disabled(task: dict) -> bool:
    """True when agents must not push or open a pull request for this task.

    Draft-vs-ready was the only PR control, so "do not publish this work" could not be
    expressed at all — every agent prompt ends by telling it to push and open a PR.
    Relying on a broken push URL to stop that is luck, not a control.

    Sources: MC_NO_PR=1 for a whole run, `no_pr` in the planner config, triage_state
    `no_pr: true`, or a 'PR: none' / 'No PR' line in the description for one task.
    """
    if os.environ.get("MC_NO_PR", "") == "1":
        return True
    if bool(get_planner_config().get("no_pr", False)):
        return True
    try:
        raw = task.get("triage_state")
        state = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw if isinstance(raw, dict) else {})
        if (state or {}).get("no_pr") is True:
            return True
    except Exception:
        pass
    import re as _re
    return bool(_re.search(r"(?im)^\s*(pr\s*:\s*none|no\s+pr)\s*$", task.get("description", "") or ""))


def _pr_is_draft(task: dict) -> bool:
    """Agent PRs default to DRAFT (a human marks them ready after review). Override to
    a ready PR via triage_state.pr_ready=true, or a 'PR: ready' line in the description."""
    try:
        raw = task.get("triage_state")
        state = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw if isinstance(raw, dict) else {})
        if (state or {}).get("pr_ready") is True:
            return False
    except Exception:
        pass
    try:
        import re
        if re.search(r"(?im)^\s*PR:\s*ready\s*$", task.get("description", "") or ""):
            return False
    except Exception:
        pass
    return True


def _infer_branch_prefix(title: str) -> str:
    import re
    lower = title.lower()
    if re.search(r'\b(fix|bug|broken|error|crash|patch|hotfix|resolve)\b', lower):
        return "bugfix"
    return "feature"


class _AtCapacity:
    """Falsy result meaning the spawn was refused for want of a free slot.

    Distinct from a plain False, which means the spawn is broken. A busy machine
    must not raise a checkpoint or burn a retry attempt — it just has to wait.
    """

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "AT_CAPACITY"


AT_CAPACITY = _AtCapacity()

# spawn-agent.sh exits 3 when starting this agent would cross the global ceiling.
_SPAWN_EXIT_AT_CAPACITY = 3


def spawn_agent(task_id: str, task_label: str, repo_path: Path, prompt_content: str,
                agent_type: str = "claude", mc_task_id: str = "", base_branch: str = "",
                task_title: str = "", draft_pr: bool = True, no_pr: bool = False):
    """Spawn an agent. Returns True, AT_CAPACITY (no free slot), or False (failed)."""
    # task_label becomes a git branch, worktree dir, tmux session, and prompt filename —
    # a "/" or space in it crashes the spawn (e.g. a prompt path with a phantom subdir).
    # Sanitize defensively, on top of _normalize_repos fixing the source.
    import re as _re
    task_label = _re.sub(r"[^A-Za-z0-9._-]", "-", task_label).strip("-") or "task"
    prefix = _infer_branch_prefix(task_title or task_label)
    branch_name = f"{prefix}/{task_label}"
    if not base_branch:
        base_branch = detect_base_branch(repo_path)

    # PR must target the same branch we based off (e.g. a feature branch like
    # coda/new-ui), not the repo default. gh's --base wants the bare branch name.
    pr_base = base_branch.split("/", 1)[1] if base_branch.startswith("origin/") else base_branch
    draft_flag = "--draft " if draft_pr else ""
    draft_note = ("Open it as a DRAFT so a human reviews before it's marked ready.\n"
                  if draft_pr else "Open it ready for review.\n")

    prompt_dir = SWARM_DIR / "prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = prompt_dir / f"{task_label}.md"
    if no_pr:
        footer = (
            f"\n\n---\n## Branch — do NOT publish\n"
            f"Your work is based on `{pr_base}`. Commit to your branch and stop there.\n\n"
            f"**Do not run `git push`. Do not run `gh pr create`.** This task is explicitly "
            f"marked no-PR: the work stays local for review on this machine. Ignore any "
            f"instruction elsewhere in this prompt that tells you to push or open a pull "
            f"request — this section overrides it.\n"
        )
    else:
        footer = (
            f"\n\n---\n## Branch & PR target\n"
            f"Your work is based on `{pr_base}`. When you open the pull request, it MUST "
            f"target that branch. {draft_note}"
            f"\n```\ngh pr create {draft_flag}--base {pr_base} --title \"[...] ...\" --body \"...\"\n```\n"
        )
    prompt_file.write_text(prompt_content + footer)

    env = os.environ.copy()
    env["MC_TASK_ID"] = mc_task_id or task_id
    env["BASE_BRANCH"] = base_branch
    env["PR_BASE_BRANCH"] = pr_base

    try:
        result = subprocess.run(
            [str(SWARM_DIR / "spawn-agent.sh"), task_label, str(repo_path), branch_name, agent_type, task_label],
            capture_output=True, text=True, timeout=600, env=env,
        )
        if result.returncode == 0:
            logging.info(f"  Spawned {agent_type} agent: {task_label} (mc_task_id={mc_task_id or task_id}, base={base_branch})")
            return True
        elif result.returncode == _SPAWN_EXIT_AT_CAPACITY:
            logging.info(f"  No agent slot for {task_label} — will retry: {result.stdout.strip()}")
            return AT_CAPACITY
        else:
            logging.error(f"  spawn-agent.sh failed: {result.stderr}")
            return False
    except Exception as e:
        logging.error(f"  Failed to spawn agent: {e}")
        return False


def _handle_spawn_refusal(task_id: str, outcome, what: str):
    """Route a spawn that did not start. A full machine is a wait, not a fault."""
    if outcome is AT_CAPACITY:
        _defer_spawn(task_id, what)
    else:
        _handle_spawn_failure(task_id, what)


def _defer_spawn(task_id: str, what: str):
    """No agent slot was free. Put the task back where the bridge will re-scan it and
    say nothing to the human — there is nothing to fix, and no attempt is spent."""
    logging.info(f"  Deferring {task_id[:8]} ({what}) — no agent slot free")
    try:
        mc_update_task(task_id, {"status": "planning"})
    except Exception:
        pass
    # Deliberately avoids the phrase _handle_spawn_failure counts, so waiting for a
    # slot never accumulates toward giving up and flagging a human.
    mc_log_activity(task_id, "updated", f"Waiting for a free agent slot before dispatching {what}.")


def _handle_spawn_failure(task_id: str, what: str, max_attempts: int = 3):
    """A dispatch spawn failed — never leave the task stranded in 'assigned' (a state
    no bridge loop re-scans). Return it to 'planning' so the bridge retries transient
    failures automatically, but after `max_attempts` in one triage round, stop and flag
    for a human so a permanent failure doesn't tight-loop."""
    acts = fetch_task_activities(task_id) or []
    round_start = max((a.get("created_at", "") for a in acts
                       if a.get("activity_type") == "planning_questions"), default="")
    prior_fails = sum(1 for a in acts
                      if "Agent spawn failed" in a.get("message", "")
                      and a.get("created_at", "") >= round_start)
    give_up = (prior_fails + 1) >= max_attempts

    logging.warning(f"  Spawn failed for {task_id[:8]} ({what}) — attempt {prior_fails + 1}"
                    f"{' (giving up, flagging human)' if give_up else ' (will retry)'}")
    try:
        mc_update_task(task_id, {"status": "planning"})
    except Exception:
        pass

    # Surface it as needing attention (deduped so retries don't spam checkpoints).
    try:
        existing = mc_request("GET", f"/api/tasks/{task_id}/checkpoints") or []
        has_pending = any(c.get("status") == "pending" for c in existing)
    except Exception:
        has_pending = False
    if not has_pending:
        try:
            mc_request("POST", f"/api/tasks/{task_id}/checkpoints", {
                "kind": "approval",
                "prompt": (f"Couldn't spawn an agent for {what}. Task returned to planning. "
                           "Check the swarm runtime (spawn-agent.sh in ~/.mission-control/swarm, "
                           "agent CLI logged in), then re-trigger."),
                "pause": False,
            })
        except Exception:
            pass

    # After max_attempts, include the guard phrase so process_planning_tasks stops
    # auto-re-dispatching this round and waits for a human.
    tail = (" Manual intervention needed — resolve the checkpoint and re-trigger."
            if give_up else " Will retry on the next cycle.")
    mc_log_activity(task_id, "updated", f"Agent spawn failed for {what} (attempt {prior_fails + 1}).{tail}")


# === Main Processing ===

def fetch_tasks_by_status(status: str) -> List[dict]:
    try:
        tasks: List[dict] = mc_request("GET", f"/api/tasks?status={status}")
        return tasks if tasks else []
    except Exception as e:
        logging.error(f"Failed to fetch {status} tasks: {e}")
        return []


def fetch_next_task() -> Optional[dict]:
    try:
        result = mc_request("POST", "/api/tasks/claim", {
            "owner": bridge_owner(),
            "lease_seconds": bridge_lease_seconds(),
        })
        task = result.get("task") if isinstance(result, dict) else None
        return task if task else None
    except Exception as e:
        logging.error(f"Failed to claim next inbox task: {e}")
        return None


def release_task_lease(task_id: str):
    try:
        mc_request("DELETE", f"/api/tasks/{task_id}/lease", {"owner": bridge_owner()})
    except Exception as e:
        logging.warning(f"Failed to release bridge lease for {task_id[:8]}: {e}")


def fetch_task_activities(task_id: str) -> List[dict]:
    try:
        return mc_request("GET", f"/api/tasks/{task_id}/activities")
    except Exception:
        return []


def _build_codebase_context(repos: List[dict], base_branch: str = "",
                            description: str = "") -> str:
    """Source context for triage and planning.

    Read from `base_branch` when the task pins one, since that is the tree agents
    will actually branch from. Falls back to the checkout when no base is pinned or
    the ref cannot be read. When the task names a target app, that subtree is listed
    in full — a monorepo's real code sits below the general listing's depth.
    """
    sections = []
    targets = _target_app_paths(description)
    for r in repos:
        project, repo = r["project"], r["repo"]
        repo_path = find_repo_path(project, repo)
        if not repo_path:
            continue
        code_ctx = ""
        if base_branch:
            code_ctx = read_key_source_files_at_ref(repo_path, base_branch)
            if not code_ctx:
                logging.warning(f"  Could not read {base_branch} — using the checkout instead")
            else:
                tree = _target_app_tree(repo_path, base_branch, targets)
                if tree:
                    code_ctx += "\n\n" + tree
        if not code_ctx:
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
        sections.append("## Additional Context (from external comments)\n" + "\n\n".join(lines))

    questions = ts.get("questions", []) if ts else []
    answered = [q for q in questions if q.get("answer")]

    # A follow-up answered after planning stopped is a decision, not a triage answer.
    # It is the reason planning restarts, and it binds a decision id the plan must
    # cite — folding it in with the opening Q&A buries exactly the thing that changed.
    decisions = [q for q in answered if q.get("source") == "planner"]
    triage_qa = [q for q in answered if q.get("source") != "planner"]

    if triage_qa:
        lines = []
        for q in triage_qa:
            lines.append(f"**Q:** {q.get('question', q.get('q', ''))}\n**A:** {q.get('answer', '')}")
        sections.append("## Triage Q&A\n" + "\n\n".join(lines))

    if decisions:
        lines = []
        for q in decisions:
            tag = q.get("becomes") or "decision"
            by = "you" if q.get("answered_by") != "agent" else "the agent, on your delegation"
            entry = (f"**{tag}** — {q.get('question', '')}\n"
                     f"**Decided:** {q.get('answer', '')} (by {by})")
            if q.get("reason"):
                entry += f"\n**Why:** {q['reason']}"
            lines.append(entry)
        sections.append(
            "## Decisions (binding — the plan must reflect these)\n" + "\n\n".join(lines))

    # Deferrals are load-bearing too: a question consciously postponed must not be
    # re-asked, and the plan should avoid depending on its answer.
    deferred = [q for q in questions if q.get("deferred") and not q.get("answer")]
    if deferred:
        lines = [f"- {q.get('question', '')}" for q in deferred]
        sections.append(
            "## Deferred — do not re-ask, and do not build anything that needs these\n"
            + "\n".join(lines))

    return "\n\n".join(sections)


def _gh_bin() -> str:
    return shutil.which("gh") or "/opt/homebrew/bin/gh"


def _gh_pr_list(repo_path: Path, extra_args: List[str]) -> List[dict]:
    try:
        out = subprocess.run(
            [_gh_bin(), "pr", "list", "--json", "number,title,url,isDraft,headRefName,body", *extra_args],
            cwd=str(repo_path), capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return []
        return json.loads(out.stdout or "[]")
    except Exception:
        return []


def _gh_pr_from_url(url: str) -> Optional[dict]:
    try:
        out = subprocess.run([_gh_bin(), "pr", "view", url, "--json", "url,isDraft,state"],
                             capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return None
        pr = json.loads(out.stdout or "{}")
        if (pr.get("state") or "OPEN") != "OPEN":
            return None  # merged/closed — not blocking
        return {"url": pr.get("url", url), "is_draft": bool(pr.get("isDraft")), "source": "linear"}
    except Exception:
        return None


def _linear_pr_for_task(task: dict) -> Optional[dict]:
    """Look for a GitHub PR attached to the task's Linear issue."""
    issue_id = task.get("external_id")
    if not issue_id or task.get("source") != "linear":
        return None
    key = os.environ.get("LINEAR_API_KEY", "").strip()
    if not key:
        return None
    query = '{ issue(id: "%s") { attachments { nodes { url } } } }' % issue_id
    try:
        req = urllib.request.Request(
            "https://api.linear.app/graphql",
            data=json.dumps({"query": query}).encode(),
            headers={"Authorization": key, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        nodes = (((data.get("data") or {}).get("issue") or {}).get("attachments") or {}).get("nodes") or []
    except Exception:
        return None
    for n in nodes:
        url = n.get("url", "")
        if "github.com" in url and "/pull/" in url:
            return _gh_pr_from_url(url)
    return None


def _find_existing_pr(task: dict, repos: List[dict]) -> Optional[dict]:
    """Detect a PR that already covers THIS task, to avoid conflicting with prior work.

    Must be ticket-precise: a worktree/branch can host a PR for an unrelated task
    (e.g. many tasks share one 'new-ui' branch), so matching any open PR on the
    branch causes false positives. We only match when the link is issue-specific:
      1) a GitHub PR attached to this task's Linear issue, or
      2) a PR whose title/body/branch actually references the ticket id (MET-123).
    """
    pr = _linear_pr_for_task(task)
    if pr:
        return pr
    ticket = _extract_ticket_id(task.get("title", ""))
    if not ticket or ticket == "TICKET":
        return None
    # Ownership must come from the TITLE or BRANCH (our convention: "[MET-123] ..."
    # title + "feature/MET-123-..." branch). The body is excluded: an unrelated PR
    # can merely cross-reference the ticket ("relates to MET-123", shared checklist),
    # which is not ownership and caused false positives (e.g. MET-551's PR mentioning
    # MET-531). Word-boundaried so MET-53 / MET-5310 don't match MET-531.
    import re
    tref = re.compile(rf"(?<![A-Za-z0-9]){re.escape(ticket)}(?![0-9])", re.IGNORECASE)
    for r in repos:
        repo_path = find_repo_path(r["project"], r["repo"])
        if not repo_path:
            continue
        candidates = _gh_pr_list(repo_path, ["--state", "open", "--search", ticket])
        for p in candidates:
            owner = f"{p.get('title', '')} {p.get('headRefName', '')}"
            if tref.search(owner):
                return {"url": p["url"], "is_draft": bool(p.get("isDraft")),
                        "number": p.get("number"), "branch": p.get("headRefName"), "source": "gh"}
    return None


def _pr_guard(task: dict, repos: List[dict]) -> bool:
    """Before dispatching agents, check for an existing PR. Returns True to proceed,
    False if dispatch was intercepted (open PR -> review; draft PR -> ask the human)."""
    if os.environ.get("ENABLE_PR_CHECK", "1") != "1":
        return True
    task_id = task["id"]
    try:
        pr = _find_existing_pr(task, repos)
    except Exception as e:
        logging.warning(f"  PR check errored for {task_id[:8]} (proceeding): {e}")
        return True
    if not pr:
        return True

    url = pr.get("url", "")
    if pr.get("is_draft"):
        # Dedup: only raise the checkpoint (and announce) once — otherwise every
        # bridge cycle that re-dispatches this task would stack another checkpoint.
        try:
            existing = mc_request("GET", f"/api/tasks/{task_id}/checkpoints") or []
            has_pending = any(c.get("status") == "pending" for c in existing)
        except Exception:
            has_pending = False
        if has_pending:
            # Already asked. Make sure the task is parked so the planning loop stops
            # re-dispatching it (older checkpoints may have been raised without pausing).
            try:
                if task.get("status") != "on_hold":
                    mc_update_task(task_id, {"status": "on_hold"})
            except Exception:
                pass
            return False
        logging.info(f"  Draft PR {url} already exists for {task_id[:8]} — raising checkpoint, pausing")
        try:
            # pause=True parks the task (on_hold) until you decide, which also stops the
            # planning loop from re-dispatching it every cycle.
            mc_request("POST", f"/api/tasks/{task_id}/checkpoints", {
                "kind": "choice",
                "prompt": f"A draft PR already exists for this task:\n{url}\n\nThe swarm won't touch it automatically. How do you want to proceed?",
                "options": [
                    "Move to review (I'll finish the PR myself)",
                    "Let an agent continue on top of this PR",
                    "Ignore it and dispatch a fresh agent",
                ],
                "pause": True,
            })
        except Exception as e:
            logging.warning(f"  Failed to raise draft-PR checkpoint for {task_id[:8]}: {e}")
        mc_log_activity(task_id, "updated", f"Draft PR already exists ({url}) — paused for your decision before dispatching.")
        return False

    logging.info(f"  Open PR {url} already exists for {task_id[:8]} — moving to review, not dispatching")
    mc_update_task(task_id, {"status": "review"})
    mc_log_activity(task_id, "status_changed", f"Open PR already exists ({url}) — moved to review instead of dispatching an agent.")
    return False


def _normalize_repos(repos: List[dict]) -> List[dict]:
    """Repair triage mis-splits where the repo field holds a path (e.g. repo=
    "GitProjects/backend-new-ui", project="New UI" — the Linear project name). A "/" in
    repo flows into branch/worktree/prompt-file names and crashes the spawn. Take the
    last path segment as the repo and the rest as the project."""
    out: List[dict] = []
    for r in repos or []:
        project = r.get("project", "")
        repo = r.get("repo", "")
        if "/" in str(repo):
            parts = [p for p in str(repo).split("/") if p]
            repo = parts[-1]
            if len(parts) > 1:
                project = "/".join(parts[:-1])
        out.append({**r, "project": project, "repo": repo})
    return out


def _spawn_for_repos(task: dict, repos: List[dict]):
    repos = _normalize_repos(repos)
    task_id = task["id"]
    title = task["title"]
    description = task.get("description", "")
    task_type = task.get("task_type", "implementation")

    if task_type == "implementation" and not _pr_guard(task, repos):
        return

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
        task_label = f"{_task_ref(task)}-inv-{repo}"

        outcome = spawn_agent(task_id, task_label, repo_path, prompt, mc_task_id=task_id, task_title=title,
                              base_branch=_resolve_base_branch(task, repo_path), draft_pr=_pr_is_draft(task),
                              no_pr=_pr_is_disabled(task))
        if outcome:
            mc_update_task(task_id, {"status": "in_progress"})
            mc_log_activity(task_id, "spawned", f"Investigation agent spawned for {project}/{repo}")
        else:
            _handle_spawn_refusal(task_id, outcome, f"{project}/{repo}")
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
        task_label = f"{_task_ref(task)}-{repo}"

        outcome = spawn_agent(task_id, task_label, repo_path, prompt, mc_task_id=task_id, task_title=title,
                              base_branch=_resolve_base_branch(task, repo_path), draft_pr=_pr_is_draft(task),
                              no_pr=_pr_is_disabled(task))
        if outcome:
            mc_update_task(task_id, {"status": "in_progress"})
            mc_log_activity(task_id, "spawned", f"Agent spawned for {project}/{repo}")
        else:
            _handle_spawn_refusal(task_id, outcome, f"{project}/{repo}")
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
            task_label = f"{_task_ref(child)}-{repo}"

            outcome = spawn_agent(child_id, task_label, repo_path, prompt, mc_task_id=child_id, task_title=title, no_pr=_pr_is_disabled(task))
            if outcome:
                mc_update_task(child_id, {"status": "in_progress"})
                mc_log_activity(child_id, "spawned", f"Agent spawned for {project}/{repo}")
            else:
                _handle_spawn_refusal(child_id, outcome, f"{project}/{repo}")

        mc_update_task(task_id, {"status": "in_progress"})
        mc_log_activity(task_id, "updated", f"Spawned agents across {len(repos)} repos")


def _plan_and_dispatch(task: dict, repos: List[dict]):
    """Generate a plan for the task, then dispatch the first runnable steps."""
    repos = _normalize_repos(repos)
    task_id = task["id"]
    title = task["title"]
    description = task.get("description", "")

    if task.get("task_type", "implementation") == "implementation" and not _pr_guard(task, repos):
        return

    # Multi-step orchestration is OFF by default. This is a monorepo, so a task should
    # produce ONE agent and ONE PR — not a split plan with per-step agents (which caused
    # per-step verification loops, blocked dependent steps, and confusing partial
    # "EXECUTE 1/2" states). Re-enable with ENABLE_MULTI_STEP_PLANNING=1 if ever needed.
    if os.environ.get("ENABLE_MULTI_STEP_PLANNING", "0") != "1":
        logging.info(f"  Single-PR mode — one agent for {task_id[:8]} (multi-step planning disabled)")
        _spawn_for_repos(task, repos)
        return

    # Build context for planner
    repo_indexes: Dict[str, str] = {}
    for r in repos:
        idx = read_repo_index(r["project"], r["repo"])
        if idx:
            repo_indexes[f"{r['project']}/{r['repo']}"] = idx

    codebase_context = _build_codebase_context(repos, _base_branch_override(task), description) if repos else ""
    # The plan should be written against what the ticket actually supplies. Without
    # this the planner invents a structure the handoff already specifies, and only
    # the builder ever sees the real thing.
    codebase_context += _attachment_triage_context(task)
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

    # Dispatch first runnable steps. The gate check rides on dispatch, not on
    # planning — see _enforce_gates.
    _dispatch_next_steps(task, plan, repos)


def route_plan_stage_outcome(task: dict, verdict: dict) -> bool:
    """Act on a staged planning run. True if the work may proceed.

    The point of staging planning is that its failure is reportable, so each outcome
    has to land somewhere a person or the system can act on — a verdict that only
    appears in a log is the situation this replaces.

    - `questions_raised` posts them as planner follow-ups, which is what puts them on
      the ticket and what `process_answered_followups` later resumes from.
    - `prerequisite_missing` is the system's problem, never a question. It escalates
      as a prerequisite so nobody is asked to approve a directory being created.
    - `error` escalates with the transcript path, because "the planner failed" without
      somewhere to look is the thing that made the last two runs unreadable.
    """
    task_id = task["id"]
    outcome = verdict.get("outcome")
    record_step_attempt(task_id, 0, {
        "outcome": f"plan_{outcome}",
        "attempt": 0,
        "runtime_s": verdict.get("duration_s"),
        "gsd_ran": verdict.get("gsd_ran"),
    })

    if outcome == "plan_written":
        mc_log_activity(task_id, "plan_created",
                        f"Planning wrote {verdict.get('plan_path')} "
                        f"in {verdict.get('duration_s')}s.")
        return True

    if outcome == "questions_raised":
        questions = verdict.get("questions") or []
        post_planning_questions(task_id, questions)
        mc_update_task(task_id, {"status": "planning"})
        mc_log_activity(
            task_id, "new_triage_question",
            f"Planning stopped to ask {len(questions)} question(s) only you can answer. "
            f"Answering resumes it.")
        logging.info(f"  Plan stage raised {len(questions)} question(s) for {task_id[:8]}")
        return False

    if outcome == "prerequisite_missing":
        # A missing GSD project is something the system creates, not something to ask
        # about. It reaches a human only because the attempt to create it did not work.
        mc_log_activity(
            task_id, "needs_human",
            f"Planning could not start and it is not a question: {verdict.get('reason')}\n\n"
            f"Transcript: {verdict.get('transcript_path')}")
        mc_set_progress(task_id, state="blocked", phase="planning",
                        blocked_reason=str(verdict.get("reason"))[:500])
        return False

    mc_log_activity(
        task_id, "needs_human",
        f"Planning failed: {verdict.get('reason')}\n\n"
        f"Transcript: {verdict.get('transcript_path')}\n"
        f"GSD actually ran: {verdict.get('gsd_ran')}")
    mc_set_progress(task_id, state="blocked", phase="planning",
                    blocked_reason=str(verdict.get("reason"))[:500])
    return False


def _enforce_gates(task: dict, plan: dict, repos: List[dict], steps: List[dict]) -> List[dict]:
    """Block the steps whose verify_command cannot pass. Returns the ones still runnable.

    This sits on the dispatch path rather than the planning path deliberately. It
    used to run once, inside `_plan_and_dispatch`, which covered a step's first
    outing and nothing after it: a step re-dispatched on retry went straight back
    into a broken gate and escalated `claude → codex` against a command that could
    never pass. Every dispatch is a first dispatch as far as the gate is concerned.

    The probe is cached per command so covering the retry path costs no more than
    covering the first one — a failing gate is re-probed occasionally, because the
    checkpoint asks a human to fix it and a fixed gate should recover on its own.
    """
    if not _gate_check_enabled() or not steps:
        return steps

    findings = validate_plan_gates(task, plan, repos, only_steps=[s["step"] for s in steps])
    if not findings:
        return steps

    task_id = task["id"]
    blocked = set()
    for finding in findings:
        for step_num in finding["steps"]:
            blocked.add(step_num)
            update_step_progress(task_id, step_num, {
                "status": "blocked",
                "outcome": f"verify_command unusable: {finding['reason'][:300]}",
            })
            record_step_attempt(task_id, step_num, {
                "outcome": "gate_invalid",
                "attempt": 0,
                "exit_code": finding.get("exit_code"),
                "command": finding["command"][:300],
            })
        mc_log_activity(
            task_id, "updated",
            f"Steps {finding['steps']} are blocked: their verify_command fails on unmodified "
            f"code, so it cannot tell finished work from unfinished.\n\n"
            f"`{finding['command'][:200]}`\n\n{finding['reason'][:600]}"
        )
        _raise_gate_checkpoint(task_id, finding)

    return [s for s in steps if s["step"] not in blocked]


def _dispatch_next_steps(task: dict, plan: dict, repos: List[dict]):
    """Dispatch the next runnable steps from a plan."""
    task_id = task["id"]
    title = task["title"]

    next_steps = get_next_steps(task_id, plan)
    next_steps = _enforce_gates(task, plan, repos, next_steps)
    if not next_steps:
        if is_plan_complete(task_id):
            logging.info(f"  All plan steps complete for {task_id[:8]}")
            mc_log_activity(task_id, "updated", "All plan steps completed successfully")
        else:
            logging.info(f"  No runnable steps for {task_id[:8]} — waiting for in-progress steps")
        return

    # Steps beyond the ceiling are left pending, not failed — the daemon calls this
    # again each tick, so they dispatch as slots free up.
    slots = _agent_slots_free(_load_active_tasks())
    if slots is not None and slots < len(next_steps):
        held = len(next_steps) - slots
        logging.info(
            f"  At agent limit — dispatching {slots} of {len(next_steps)} runnable steps, "
            f"{held} deferred to a later tick"
        )
        if slots == 0:
            return
        next_steps = next_steps[:slots]

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
        base_profile = step_categories.get(category, {}).get("agent", "claude")

        # Each retry climbs the ladder. A step that already failed its own check on
        # one runtime has no reason to pass on a second identical attempt.
        step_state = (load_progress(task_id) or {}).get("steps", {}).get(str(step_num), {})
        attempt = int(step_state.get("retry_count", 0) or 0)
        agent_type = _profile_for_attempt(base_profile, attempt)
        if agent_type != base_profile:
            logging.info(f"  Step {step_num} attempt {attempt + 1} — escalated {base_profile} → {agent_type}")
            mc_log_activity(task_id, "step_escalated",
                            f"Step {step_num} retrying on {agent_type} (was {base_profile}) — attempt {attempt + 1}")

        task_label = f"{_task_ref(task)}-s{step_num}-{target_repo_name}"

        # Determine base branch: if this step depends on a prior step in the same repo,
        # use that step's branch so we inherit its commits
        step_base_branch = ""
        for dep_num in step.get("depends_on", []):
            dep_step = next((s for s in plan.get("steps", []) if s["step"] == dep_num), None)
            if dep_step and dep_step.get("repo") == step.get("repo"):
                dep_label = f"{_task_ref(task)}-s{dep_num}-{target_repo_name}"
                prefix = _infer_branch_prefix(title or dep_label)
                step_base_branch = f"{prefix}/{dep_label}"
                break

        # First step in a repo (no in-repo dependency) → base off the task's chosen
        # base branch (feature-branch override or repo default).
        if not step_base_branch and target_repo:
            step_base_branch = _resolve_base_branch(task, target_repo)

        update_step_progress(task_id, step_num, {
            "status": "in_progress",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "category": category,
            "agent_id": task_label,
            # Which runtime ran this attempt, so verification can attribute the
            # result to it rather than to whatever the category maps to now.
            "agent_profile": agent_type,
            "base_profile": base_profile,
        })

        outcome = spawn_agent(task_id, task_label, target_repo, prompt,
                              agent_type=agent_type, mc_task_id=task_id, task_title=title,
                              base_branch=step_base_branch, draft_pr=_pr_is_draft(task),
                              no_pr=_pr_is_disabled(task))
        if outcome:
            mc_update_task(task_id, {"status": "in_progress"})
            mc_log_activity(
                task_id, "step_dispatched",
                f"Step {step_num}/{plan.get('total_steps', '?')}: {step['title']} → {agent_type} agent ({category})"
            )
            try:
                _step_total = int(plan.get("total_steps") or 0) or None
            except (TypeError, ValueError):
                _step_total = None
            mc_set_progress(task_id, state="running", phase="execute",
                            step_label=step.get("title", ""), step_index=step_num, step_total=_step_total)
            logging.info(f"  Dispatched step {step_num}: {step['title']} → {agent_type} ({category})")
        elif outcome is AT_CAPACITY:
            # A slot was taken between the headroom check above and this spawn.
            # Hand the step back so a later tick re-offers it; nothing is wrong.
            update_step_progress(task_id, step_num, {
                "status": "pending", "agent_id": None, "started_at": None,
            })
            logging.info(f"  No slot for step {step_num} — left pending")
            break
        else:
            update_step_progress(task_id, step_num, {"status": "failed", "outcome": "Spawn failed"})
            _handle_spawn_failure(task_id, f"step {step_num}: {step.get('title', '')}"[:80])
            logging.error(f"  Failed to spawn agent for step {step_num}")


def _step_verification_criteria(step: dict) -> list:
    criteria = step.get("acceptance_criteria", step.get("done_when", []))
    return criteria if isinstance(criteria, list) else []


# Signals that a runtime refused the work for quota reasons rather than failing at
# it. Retrying the same pool just burns the retry budget; the answer is a different
# pool, which is the same mechanism escalation uses.
_RATE_LIMIT_MARKERS = (
    "rate limit", "rate_limit", "rate-limited", "429",
    "quota exceeded", "usage limit", "too many requests",
    "overloaded_error", "insufficient_quota",
)


def _looks_rate_limited(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in _RATE_LIMIT_MARKERS)


def _escalation_ladder(base_profile: str) -> List[str]:
    """Runtimes to try for a step, in order. First entry is the starting profile."""
    cfg = get_planner_config()
    ladders = cfg.get("escalation_ladder") or {}
    ladder = ladders.get(base_profile) or cfg.get("escalation_ladder_default") or []
    ladder = [p for p in ladder if isinstance(p, str) and p]
    if not ladder:
        return [base_profile]
    # The ladder describes where to go, so the starting profile leads it either way.
    return ladder if ladder[0] == base_profile else [base_profile] + ladder


def _profile_for_attempt(base_profile: str, attempt: int) -> str:
    """Profile for attempt N (0 = first try), clamped to the top of the ladder."""
    ladder = _escalation_ladder(base_profile)
    return ladder[min(max(attempt, 0), len(ladder) - 1)]


def _require_gsd() -> bool:
    """Whether to check that the GSD workflow actually ran after each step.

    On by default: the whole point of the spec-driven approach is that tasks get
    decomposed and each carries its own check, and a run without that is a different
    experiment. Set require_gsd false for repos deliberately run without GSD.
    """
    return bool(get_planner_config().get("require_gsd", True))


def _gate_check_enabled() -> bool:
    """Gate validation costs one worktree and one command run per plan. On by default —
    the failure it prevents is silent and expensive — but a repo whose build genuinely
    cannot run locally can turn it off rather than block every plan."""
    raw = get_planner_config().get("validate_gates", True)
    return bool(raw) and os.environ.get("MC_SKIP_GATE_CHECK", "") != "1"


def _raise_gate_checkpoint(task_id: str, finding: dict):
    """Ask a human to fix the gate. Deduped: one pending checkpoint at a time."""
    try:
        existing = mc_request("GET", f"/api/tasks/{task_id}/checkpoints") or []
        if any(c.get("status") == "pending" for c in existing):
            return
        mc_request("POST", f"/api/tasks/{task_id}/checkpoints", {
            "kind": "approval",
            "prompt": (f"Steps {finding['steps']} can't be verified: `{finding['command'][:160]}` "
                       f"fails on unmodified code, so passing it would prove nothing. "
                       f"Fix the command or the environment it needs, then re-trigger."),
            "pause": False,
        })
    except Exception as e:
        logging.debug(f"  gate checkpoint failed for {task_id[:8]}: {e}")


# How long a failing gate stays condemned before it is worth probing again. The
# checkpoint asks a human to fix the command or the environment it needs; when they
# do, the plan should pick itself back up without anyone re-triggering it.
GATE_FAILURE_TTL_SECONDS = 900


def _gate_cache_path(task_id: str) -> Path:
    return MC_HOME / "bridge" / "gate-cache" / f"{task_id}.json"


def _load_gate_cache(task_id: str) -> dict:
    try:
        return json.loads(_gate_cache_path(task_id).read_text())
    except (OSError, ValueError):
        return {}


def _save_gate_cache(task_id: str, cache: dict):
    path = _gate_cache_path(task_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache))
    except OSError as e:
        logging.debug(f"  could not write gate cache for {task_id[:8]}: {e}")


def _cached_gate(cache: dict, command: str) -> Optional[dict]:
    """A usable verdict for this command, or None if it needs probing.

    A pass is kept: the base commit does not change under a plan. A failure is kept
    only briefly, so a gate someone has since repaired stops being held against them.
    """
    entry = cache.get(command)
    if not isinstance(entry, dict):
        return None
    if entry.get("runnable"):
        return entry
    try:
        checked = datetime.fromisoformat(entry.get("checked_at", ""))
    except ValueError:
        return None
    age = (datetime.now(timezone.utc) - checked).total_seconds()
    return entry if age < GATE_FAILURE_TTL_SECONDS else None


def validate_plan_gates(task: dict, plan: dict, repos: List[dict],
                        only_steps: Optional[List[int]] = None) -> List[dict]:
    """Check each distinct verify_command against unmodified code, once per plan.

    Runs in a throwaway worktree at the task's base branch — the same tree agents will
    branch from — so the check sees what they will see. Steps whose gate cannot pass
    are marked `gate_invalid`: dispatching them would spend the full retry budget and
    the top of the escalation ladder proving something the base commit already proves.

    `only_steps` narrows the check to the steps about to be dispatched, so the retry
    path pays for the gate it is about to run and not for the whole plan.

    Returns one finding per distinct broken command. An empty list means every gate is
    satisfiable.
    """
    from planner import check_verify_command_baseline

    task_id = task["id"]
    wanted = set(only_steps) if only_steps is not None else None
    commands = {}
    for step in plan.get("steps", []):
        if wanted is not None and step["step"] not in wanted:
            continue
        cmd = (step.get("verify_command") or "").strip()
        if cmd:
            commands.setdefault(cmd, []).append(step["step"])
    if not commands:
        return []

    # Answer from cache where we can. Probing on every dispatch would make the gate
    # check cost more than the retries it saves.
    cache = _load_gate_cache(task_id)
    findings: List[dict] = []
    to_probe = {}
    for cmd, steps in commands.items():
        cached = _cached_gate(cache, cmd)
        if cached is None:
            to_probe[cmd] = steps
        elif not cached["runnable"]:
            findings.append({"steps": steps, "command": cmd,
                             "runnable": False,
                             "exit_code": cached.get("exit_code"),
                             "reason": cached.get("reason", "")})
    if not to_probe:
        return findings

    repo = repos[0] if repos else None
    repo_path = find_repo_path(repo["project"], repo["repo"]) if repo else None
    if not repo_path:
        logging.warning("  Cannot validate plan gates — no repo path")
        return []

    base = _resolve_base_branch(task, repo_path)
    probe = Path(str(repo_path).rstrip("/")).parent / "worktrees" / f"gatecheck-{task['id'][:8]}"
    try:
        subprocess.run(["git", "worktree", "add", "-q", "--detach", str(probe), base],
                       cwd=str(repo_path), capture_output=True, text=True, timeout=600, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        logging.warning(f"  Could not create gate-check worktree at {base}: {e}")
        return []

    # A worktree holds tracked files only, so it starts with no `.env`. Without this
    # the probe reports every build gate as unusable and blames the base commit.
    env_report = seed_worktree_env(str(repo_path), str(probe))
    if describe(env_report):
        logging.info(f"  Gate-check worktree env: {describe(env_report)}")

    try:
        installed = False
        for cmd, steps in to_probe.items():
            result = check_verify_command_baseline(cmd, str(probe))
            # A gate that fails because the tree was never set up is not evidence
            # about the base commit. Pay for one install, once, and ask again —
            # agent worktrees get the same treatment at spawn.
            if not result["runnable"] and not installed and looks_unprepared(result):
                installed = True
                tool = install_dependencies(str(probe))
                if tool:
                    logging.info(f"  Installed probe deps with {tool} — re-checking gate")
                    result = check_verify_command_baseline(cmd, str(probe))
            cache[cmd] = {**result, "checked_at": datetime.now(timezone.utc).isoformat()}
            if result["runnable"]:
                logging.info(f"  Gate OK for steps {steps}")
            else:
                logging.warning(f"  Gate UNUSABLE for steps {steps}: {result['reason'][:200]}")
                findings.append({"steps": steps, "command": cmd, **result})
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(probe)],
                       cwd=str(repo_path), capture_output=True, text=True, timeout=300)
    _save_gate_cache(task_id, cache)
    return findings


def _step_shape(step: dict) -> dict:
    """Observable properties of a task, for correlating outcome against difficulty.

    Shape only — file count, category, whether a check exists. Never a model's
    opinion of how hard the task is: GSD forbids the planner from judging difficulty
    for the same reason, and self-rated confidence is a weak predictor.
    """
    files = step.get("files") or step.get("files_modified") or []
    return {
        "category": step.get("category", ""),
        "file_count": len(files) if isinstance(files, list) else 0,
        "criteria_count": len(_step_verification_criteria(step)),
        "has_verify_command": bool((step.get("verify_command") or "").strip()),
        "depends_on_count": len(step.get("depends_on") or []),
    }


def record_step_attempt(task_id: str, step_num: int, record: dict):
    """Append one attempt to the metrics log.

    Routing can only be tuned against measured history, and the escalation rate is
    the metric that says whether plans are good — so every attempt is recorded,
    passes included, not just the failures.

    Best effort: metrics must never break a run.
    """
    try:
        metrics_dir = MC_HOME / "bridge" / "metrics"
        metrics_dir.mkdir(parents=True, exist_ok=True)
        row = {"task_id": task_id, "step": step_num,
               "at": datetime.now(timezone.utc).isoformat(), **record}
        with (metrics_dir / "step-attempts.jsonl").open("a") as fh:
            fh.write(json.dumps(row) + "\n")
    except Exception as e:
        logging.debug(f"  metrics write failed for {task_id[:8]} step {step_num}: {e}")


def _max_step_retries() -> int:
    try:
        return int(get_planner_config().get("max_step_retries", 2))
    except Exception:
        return 2


def process_in_progress_plans():
    """Check in-progress planned tasks and dispatch next steps when previous ones complete.

    Called by the daemon loop. Looks at tasks with plans and dispatches next runnable steps.
    Includes: verification via MiniMax, retry logic for failed steps, final PR creation.
    """
    from planner import verify_step_completion

    PROGRESS_DIR = MC_HOME / "bridge" / "progress"
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

                criteria = _step_verification_criteria(step_def) if step_def else []
                max_step_retries = _max_step_retries()

                # Verify step completion by running the step's verify_command in
                # the agent's worktree; falls back to model judgement only when
                # there is no runnable command.
                if step_def and criteria:
                    worktree = _agent_worktree(step_data.get("agent_id", ""), registry)
                    # A prompt asking for the GSD workflow is a request, not a
                    # guarantee — and one naming a command that does not resolve is
                    # ignored in silence. Record whether it actually ran, so a session
                    # that skipped decomposition is visible instead of just looking fine.
                    if worktree and _require_gsd():
                        ran, why = gsd_workflow_ran(worktree)
                        # Recorded on the step, not just in metrics, so the ticket page
                        # can show whether the work was actually spec-driven.
                        update_step_progress(task_id, int(step_key),
                                             {"gsd_ran": ran, "gsd_reason": why})
                        if not ran:
                            logging.warning(f"  Step {step_key}: GSD workflow did not run — {why}")
                            mc_log_activity(task_id, "updated",
                                            f"Step {step_key} produced no GSD artifacts: {why}. "
                                            f"The work was done without task decomposition or "
                                            f"per-task automated checks.")
                            record_step_attempt(task_id, int(step_key), {
                                "outcome": "gsd_skipped",
                                "attempt": step_data.get("retry_count", 0) + 1,
                                "profile": step_data.get("agent_profile", ""),
                                "reason": why,
                                "shape": _step_shape(step_def),
                            })
                    verification = verify_step_completion(step_def, agent_output, cwd=worktree)
                    if verification.get("passed"):
                        update_step_progress(task_id, int(step_key), {
                            "status": "completed",
                            "completed_at": datetime.now(timezone.utc).isoformat(),
                            "outcome": "Verified: all criteria met",
                        })
                        mc_log_activity(task_id, "step_verified",
                                        f"Step {step_key} verified ✓: {step_data.get('title', '')}")
                        record_step_attempt(task_id, int(step_key), {
                            "outcome": "passed",
                            # 0 retries means it passed first try — the number the
                            # thesis actually turns on.
                            "attempt": step_data.get("retry_count", 0) + 1,
                            "profile": step_data.get("agent_profile", ""),
                            "base_profile": step_data.get("base_profile", ""),
                            "verified_by": verification.get("verified_by", ""),
                            "escalated": step_data.get("agent_profile") != step_data.get("base_profile"),
                            "shape": _step_shape(step_def or {}),
                        })
                        newly_completed = True
                        logging.info(f"  Step {step_key} verified ✓ for {task_id[:8]}")
                    else:
                        # Verification failed — check retry budget
                        retry_count = step_data.get("retry_count", 0)
                        failed_criteria = [
                            r["criterion"] for r in verification.get("results", [])
                            if not r.get("met")
                        ]
                        # A runtime that refused on quota never attempted the work.
                        # Charging it a retry would spend the budget on the pool
                        # being full rather than on the task being hard.
                        rate_limited = _looks_rate_limited(agent_output)
                        if rate_limited and retry_count < max_step_retries:
                            logging.info(f"  Step {step_key} hit a quota limit — switching pool without spending a retry")
                            mc_log_activity(task_id, "step_retry",
                                            f"Step {step_key} was rate-limited — moving to the next runtime")
                            update_step_progress(task_id, int(step_key), {
                                "status": "pending",
                                # retry_count still advances the LADDER (a different
                                # pool) but the outcome is recorded as not-attempted.
                                "retry_count": retry_count + 1,
                                "outcome": "Rate limited — retrying on a different runtime",
                                "agent_id": None,
                            })
                            record_step_attempt(task_id, int(step_key), {
                                "outcome": "rate_limited",
                                "attempt": retry_count + 1,
                                "profile": step_data.get("agent_profile", ""),
                                "base_profile": step_data.get("base_profile", ""),
                                "shape": _step_shape(step_def or {}),
                            })
                            newly_completed = True
                        elif retry_count < max_step_retries:
                            update_step_progress(task_id, int(step_key), {
                                "status": "pending",
                                "retry_count": retry_count + 1,
                                "outcome": f"Verification failed (attempt {retry_count + 1}): {'; '.join(failed_criteria[:3])}",
                                "agent_id": None,
                            })
                            mc_log_activity(task_id, "step_retry",
                                            f"Step {step_key} failed verification — retrying ({retry_count + 1}/{max_step_retries}): {'; '.join(failed_criteria[:2])}")
                            logging.info(f"  Step {step_key} failed verification for {task_id[:8]} — retry {retry_count + 1}")
                            record_step_attempt(task_id, int(step_key), {
                                "outcome": "failed_verification",
                                "attempt": retry_count + 1,
                                "profile": step_data.get("agent_profile", ""),
                                "base_profile": step_data.get("base_profile", ""),
                                "verified_by": verification.get("verified_by", ""),
                                "exit_code": verification.get("exit_code"),
                                "failed_criteria": failed_criteria[:5],
                                "shape": _step_shape(step_def or {}),
                            })
                            newly_completed = True  # triggers re-dispatch below
                        else:
                            update_step_progress(task_id, int(step_key), {
                                "status": "failed",
                                "completed_at": datetime.now(timezone.utc).isoformat(),
                                "outcome": f"Failed after {max_step_retries} retries: {'; '.join(failed_criteria[:3])}",
                            })
                            mc_log_activity(task_id, "step_failed",
                                            f"Step {step_key} failed after {max_step_retries} retries: {'; '.join(failed_criteria[:2])}")
                            logging.warning(f"  Step {step_key} exhausted retries for {task_id[:8]}")
                            record_step_attempt(task_id, int(step_key), {
                                "outcome": "exhausted",
                                "attempt": retry_count + 1,
                                "profile": step_data.get("agent_profile", ""),
                                "base_profile": step_data.get("base_profile", ""),
                                "verified_by": verification.get("verified_by", ""),
                                "ladder": _escalation_ladder(step_data.get("base_profile", "") or "claude"),
                                "failed_criteria": failed_criteria[:5],
                                "shape": _step_shape(step_def or {}),
                            })
                            newly_completed = True
                else:
                    # No acceptance criteria on the step — nothing to check
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

            continue

        # Check if any steps permanently failed — escalate if the plan can no longer
        # make progress. A "pending" step whose dependency chain includes a failed step
        # can never run, so counting it as "runnable" (the old check) looped forever:
        # it kept re-dispatching the failed step. Escalate when nothing is actually
        # runnable AND nothing is still in progress.
        failed_steps = [
            k for k, v in progress.get("steps", {}).items()
            if v["status"] == "failed"
        ]
        if failed_steps:
            in_progress_steps = [
                k for k, v in progress.get("steps", {}).items()
                if v["status"] == "in_progress"
            ]
            runnable_now = get_next_steps(task_id, plan)  # excludes failed steps
            if not runnable_now and not in_progress_steps:
                progress["status"] = "failed"
                progress_file.write_text(json.dumps(progress, indent=2))
                blocked = [
                    k for k, v in progress.get("steps", {}).items()
                    if v["status"] == "pending"
                ]
                detail = f"step(s) {', '.join(failed_steps)} failed permanently"
                if blocked:
                    detail += f"; step(s) {', '.join(blocked)} blocked by the failure"
                mc_log_activity(task_id, "updated",
                                f"Plan cannot complete — {detail}. Parked for manual intervention.")
                mc_update_task(task_id, {"status": "on_hold"})
                logging.warning(f"  Plan stuck for {task_id[:8]} — {detail}")
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


def _max_concurrent_agents() -> int:
    try:
        return max(0, int(get_planner_config().get("max_concurrent_agents", 0)))
    except (TypeError, ValueError):
        return 0


def _agent_slots_free(registry: list) -> Optional[int]:
    """How many more agent sessions may start right now, or None for no ceiling.

    Counts every running agent, not just this task's — the ceiling is machine
    memory, which one task's plan has no exclusive claim on.
    """
    cap = _max_concurrent_agents()
    if cap <= 0:
        return None
    running = sum(1 for entry in registry if entry.get("status") == "running")
    return max(0, cap - running)


def _agent_worktree(agent_label: str, registry: list) -> Optional[str]:
    """Worktree path for a spawned agent, so a step's verify_command can be run
    where the work actually happened. None if the entry or path is missing.

    Exact match wins outright before any prefix match is considered — a
    verify_command run in a sibling step's worktree would be checking the wrong
    tree while looking like it passed. The prefix pass mirrors _is_agent_running's
    backwards compatibility with older, suffixed registry ids.
    """
    def worktree_of(entry: dict) -> Optional[str]:
        worktree = entry.get("worktree")
        return worktree if worktree and Path(worktree).is_dir() else None

    for entry in registry:
        if entry.get("id") == agent_label:
            return worktree_of(entry)
    for entry in registry:
        if entry.get("id", "").startswith(agent_label):
            return worktree_of(entry)
    return None


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


def _run_triage(title: str, description: str, manifest: str, model: Optional[str] = None,
                task_id: str = "", base_branch: str = "") -> Tuple[dict, List[dict]]:
    """Run the 2-pass triage: identify repos (Flash), then enrich with codebase context."""
    repos = identify_repos(title, description, manifest)
    repo_labels = [r["project"] + "/" + r["repo"] for r in repos]
    logging.info(f"  Pass 1 — identified {len(repos)} target repos: {repo_labels}")

    codebase_context = ""
    if repos:
        codebase_context = _build_codebase_context(repos, base_branch, description)
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

    # If the ticket links a design (Paper/Figma), read a summary via the design MCP so
    # triage can ask design-specific questions rather than generic ones.
    design_ctx = _design_context(task_id, description)
    if design_ctx:
        codebase_context += design_ctx
        logging.info("  Loaded linked design summary into triage context")

    # If the ticket attaches a screencast, extract keyframes and summarize the flow so
    # triage asks specific questions instead of punting to the human.
    video_ctx = _video_context(task_id, description)
    if video_ctx:
        codebase_context += video_ctx
        logging.info("  Loaded ticket video summary into triage context")

    # A ticket that attaches a handoff has already answered much of what triage would
    # otherwise ask. Reading it here is the difference between asking the user where
    # the tokens live and reading the stylesheet that defines them.
    attach_ctx = _attachment_triage_context(_fetch_task(task_id) or {"id": task_id, "description": description})
    if attach_ctx:
        codebase_context += attach_ctx
        logging.info("  Loaded ticket attachments into triage context")

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
    base_pin = _base_branch_override(task)
    triage, repos = _run_triage(title, description, manifest, task_id=task_id, base_branch=base_pin)

    task_type = task.get("task_type", "implementation")
    if task_type == "investigation" and triage["ready"] and not triage.get("questions"):
        logging.info(f"  Investigation task — re-running triage to force question generation")
        description_with_hint = description + "\n\n[IMPORTANT: This is an investigation/triage task. You MUST generate questions to scope the investigation. Set ready=false and generate 4-8 questions.]"
        triage2, repos2 = _run_triage(title, description_with_hint, manifest, task_id=task_id, base_branch=base_pin)
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
            codebase_ctx = _build_codebase_context(repos, base_pin, description) if repos else ""
            knowledge = recall_knowledge(repos, f"{title}\n{description[:500]}") if repos else {}
            auto_answered = _self_answer_questions(questions, title, description, codebase_ctx, knowledge)
            unanswered = [q for q in questions if not q.get("answer")]

            logging.info(f"  Self-answered {auto_answered}/{len(questions)} questions, {len(unanswered)} remain")

            if not unanswered:
                # Even when the agent self-answered everything, don't dispatch yet — the
                # auto-answers may be wrong. Post them to planning and wait for the human
                # to review/edit and confirm (the process_planning_tasks confirmed-gate).
                logging.info(f"  All questions self-answered — awaiting human review + confirmation")
                mc_update_task(task_id, {"status": "planning"})
                mc_log_activity(task_id, "status_changed", "Moved to planning: agent self-answered all questions — review and confirm to start")
                post_planning_questions(task_id, questions, triage_result=triage)
                mc_log_activity(task_id, "updated",
                    f"Self-answered all {len(questions)} triage questions from codebase knowledge — review the answers and confirm in Mission Control to start.")
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
            mc_log_activity(task_id, "updated",
                f"Self-answered {auto_answered}/{len(questions)} questions. {len(unanswered)} require human follow-up in Mission Control.")

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
    "posted a repo-selection follow-up",
    "Could not identify target repos even after",
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

    # An ack marks feedback as already-handled. It MUST match the text that
    # _relaunch_for_change_request actually writes ("Change request received from
    # Mission Control — re-launching agent"); a stricter phrase never matched, so
    # every cycle re-detected the same note and relaunched forever (MET-537 looped
    # 8x). Match the common prefix, scoped to bridge-written "updated" activities.
    latest_ack_ts = ""
    for act in activities:
        if (
            act.get("activity_type") == "updated"
            and "Change request received" in act.get("message", "")
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


# A question outlives the status it was asked in. A follow-up raised while a step is
# blocked lives on an `in_progress` task, which is why watching only `planning` meant
# the font-licence answer was stored and then nothing happened.
QUESTION_STATUSES = ("planning", "assigned", "in_progress")


def _question_context(task: dict) -> str:
    """What the answering agent needs: the ticket, and everything already settled."""
    parts = [f"TICKET: {task.get('title', '')}"]
    if task.get("description"):
        parts.append(f"DESCRIPTION:\n{task['description'][:2000]}")
    settled = _build_triage_context(task["id"])
    if settled:
        parts.append(settled)
    return "\n\n".join(parts)


def _answer_thread(task: dict, question: dict, context: str) -> Optional[str]:
    """Reply to something the human asked back about a question.

    Answering honestly includes saying "I do not know from here" — a confident guess
    about which font licence was bought is worse than silence, because it will be
    believed and it binds a decision.
    """
    thread = "\n".join(
        f"{'YOU' if m.get('role') == 'you' else 'RESEARCH'}: {m.get('text', '')}"
        for m in question.get("thread", [])
    )
    options = question.get("options") or []
    prompt = f"""You are helping someone answer a question that is currently blocking work.
They have asked you something about it. Answer that — do not re-ask the original question.

{context}

THE QUESTION THEY ARE BEING ASKED: {question.get('question', '')}
WHY IT IS BEING ASKED: {question.get('why', '(not recorded)')}
OPTIONS OFFERED: {', '.join(options) if options else '(free text)'}

CONVERSATION SO FAR:
{thread}

Rules:
- Answer the last message. Be specific and short — a few sentences.
- If you have a recommendation, give it and say what it costs.
- If the answer depends on something only they know (a purchase, a contract, an
  internal preference), say so plainly instead of guessing.
- If it depends on something in the code that you have not been shown, say what you
  would need to look at. Do not invent what the code does.

Respond with ONLY valid JSON: {{"reply": "your answer"}}"""
    result = _parse_gemini_json(call_gemini(prompt, max_tokens=900, model=_triage_model_deep()))
    reply = (result or {}).get("reply", "").strip()
    return reply or None


def _decide_delegated(task: dict, question: dict, context: str) -> Optional[Tuple[str, str]]:
    """Make a call the human handed over. Returns (choice, reason).

    The reason is not decoration. A delegated pick shows up as "chosen by the agent"
    with its reasoning next to it, and can be taken back — so it has to be legible
    enough to disagree with.
    """
    options = question.get("options") or []
    prompt = f"""Someone has asked you to make this decision for them, because they have no
strong preference. Make it, and explain the choice well enough that they could disagree.

{context}

QUESTION: {question.get('question', '')}
WHY IT MATTERS: {question.get('why', '(not recorded)')}
OPTIONS: {', '.join(options) if options else '(free text — answer in your own words)'}

Rules:
- Pick the option that is easiest to reverse if it turns out wrong.
- {"Choose exactly one of the options offered." if options else "Give a short, concrete answer."}
- The reason must say what the choice buys and what it gives up. One or two sentences.

Respond with ONLY valid JSON: {{"choice": "...", "reason": "..."}}"""
    result = _parse_gemini_json(call_gemini(prompt, max_tokens=700, model=_triage_model_deep()))
    if not result:
        return None
    choice = str(result.get("choice", "")).strip()
    reason = str(result.get("reason", "")).strip()
    if not choice:
        return None
    # A model that answers off-menu has not made the choice that was delegated.
    if options and choice not in options:
        match = next((o for o in options if o.lower() == choice.lower()), None)
        if match:
            choice = match
        else:
            logging.warning(f"  Delegated pick {choice!r} is not one of the options — leaving open")
            return None
    return choice, reason


def _service_task_questions(task: dict) -> bool:
    """Answer replies owed and decisions delegated on one task. True if anything changed."""
    task_id = task["id"]
    try:
        state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
    except Exception:
        return False
    questions = (state or {}).get("questions") or []
    replies = awaiting_reply(questions)
    delegated = awaiting_decision(questions)
    if not replies and not delegated:
        return False

    context = _question_context(task)
    changed = False

    for q in replies:
        reply = _answer_thread(task, q, context)
        if reply:
            question_add_message(q, "research", reply)
            changed = True
            logging.info(f"  Replied in the thread on {q.get('id')} for {task_id[:8]}")
        else:
            logging.warning(f"  No reply produced for question {q.get('id')} on {task_id[:8]}")

    for q in delegated:
        decision = _decide_delegated(task, q, context)
        if decision:
            choice, reason = decision
            question_record_answer(q, choice, by="agent", reason=reason)
            changed = True
            mc_log_activity(
                task_id, "updated",
                f"Decided on your behalf: **{q.get('question', '')}** → {choice}\n\n{reason}\n\n"
                f"Marked as the agent's call — change it on the ticket if you disagree.")
            logging.info(f"  Decided delegated question {q.get('id')} for {task_id[:8]}")

    if not changed:
        return False

    try:
        mc_request("PUT", f"/api/tasks/{task_id}/triage-state", {**state, "questions": questions})
    except Exception as e:
        logging.warning(f"  Could not save question updates for {task_id[:8]}: {e}")
        return False
    return True


def process_open_questions():
    """Answer what was asked back, and decide what was handed over.

    Runs across every status a question can be open in, not just `planning` — the
    ones that matter most are raised after planning has already started.
    """
    for status in QUESTION_STATUSES:
        for task in fetch_tasks_by_status(status) or []:
            try:
                _service_task_questions(task)
            except Exception as e:
                logging.warning(f"Question servicing failed for {task['id'][:8]}: {e}")


# How many times the same question may be answered and re-raised before we stop
# re-dispatching and ask a human to look. A planner that raises a follow-up, gets an
# answer, and raises it again has not understood the answer; running that loop again
# spends quota to arrive back here.
MAX_RESUME_ROUNDS = 2


def _resume_planning_for(task: dict, state: dict, questions: List[dict]) -> bool:
    """Put a task held on follow-ups back to work. True if it was resumed."""
    task_id = task["id"]
    answered_ids = sorted(q["id"] for q in questions
                          if q.get("source") == "planner" and q.get("answer"))
    resume_log = state.get("resume_log") or []

    # Already resumed for exactly this set — nothing new has been answered since.
    if resume_log and resume_log[-1].get("question_ids") == answered_ids:
        return False

    seen_counts = {}
    for entry in resume_log:
        for qid in entry.get("question_ids", []):
            seen_counts[qid] = seen_counts.get(qid, 0) + 1
    looping = [qid for qid in answered_ids if seen_counts.get(qid, 0) >= MAX_RESUME_ROUNDS]
    if looping:
        logging.warning(f"  {task_id[:8]} has re-raised {looping} after answering — not resuming again")
        mc_log_activity(
            task_id, "needs_human",
            f"Planning has now asked about {', '.join(looping)} {MAX_RESUME_ROUNDS + 1} times, "
            f"after each answer. Re-running it would land here again — someone should read "
            f"the thread and decide whether the question is answerable as asked.")
        try:
            mc_request("POST", f"/api/tasks/{task_id}/checkpoints", {
                "kind": "approval",
                "prompt": (f"The planner keeps re-asking {', '.join(looping)} after it has been "
                           f"answered. Check the ticket's thread before re-triggering."),
                "pause": False,
            })
        except Exception:
            pass
        return False

    # Hand the work back. A blocked step is re-run rather than resumed mid-flight:
    # the answer changes the spec, not what has already been built, and the prompt
    # builder folds the decision in through _build_triage_context.
    reopened = 0
    progress = load_progress(task_id)
    if progress:
        for step_key, step_data in (progress.get("steps") or {}).items():
            if step_data.get("status") == "blocked":
                update_step_progress(task_id, int(step_key), {
                    "status": "pending",
                    "outcome": "Follow-up answered — re-planning this step against the decision",
                    "agent_id": None,
                })
                reopened += 1

    counts = summarise_questions(questions)
    mc_log_activity(
        task_id, "updated",
        f"Follow-up answered — planning resumes. "
        f"{counts['answered']}/{counts['total']} settled"
        + (f", {counts['deferred']} deferred" if counts["deferred"] else "")
        + (f". Re-planning {reopened} blocked step(s)." if reopened else "."))
    mc_set_progress(task_id, state="", phase="planning", blocked_reason="")

    state["resume_log"] = resume_log + [{
        "at": datetime.now(timezone.utc).isoformat(),
        "question_ids": answered_ids,
    }]
    try:
        mc_request("PUT", f"/api/tasks/{task_id}/triage-state", state)
    except Exception as e:
        logging.warning(f"  Could not record resume for {task_id[:8]}: {e}")
        return False

    logging.info(f"  Resumed planning for {task_id[:8]} ({len(answered_ids)} follow-up(s) answered)")
    return True


def process_answered_followups():
    """Answering a follow-up must restart the thing that stopped for it.

    Without this the whole feature is decorative: the question renders, the answer is
    stored, and the ticket sits until a human notices and re-dispatches by hand. That
    was verified live — the font-licence follow-up was answered and MET-635 did not move.
    """
    for status in QUESTION_STATUSES:
        for task in fetch_tasks_by_status(status) or []:
            try:
                state = mc_request("GET", f"/api/tasks/{task['id']}/triage-state")
            except Exception:
                continue
            questions = (state or {}).get("questions") or []
            # Only follow-ups gate this. Opening triage questions are handled by the
            # planning path that already waits on them.
            if not any(q.get("source") == "planner" and q.get("answer") for q in questions):
                continue
            if not questions_all_settled(questions):
                continue
            try:
                _resume_planning_for(task, state, questions)
            except Exception as e:
                logging.warning(f"Resume failed for {task['id'][:8]}: {e}")


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

        # Skip if we already acted on the CURRENT triage round (avoid re-logging every
        # cycle). Scope this to activities since the latest planning_questions marker —
        # a re-triage or "Reset triage" starts a fresh round, and a terminal marker from
        # a previous round must not permanently wedge the task.
        try:
            existing_acts = mc_request("GET", f"/api/tasks/{task_id}/activities")
            # A new round starts at the latest planning_questions OR the latest human
            # action (resolving a checkpoint) — so a "Manual intervention needed" marker
            # from a prior attempt stops blocking once the human has acted on it.
            round_start = ""
            for a in existing_acts:
                if a.get("activity_type") in ("planning_questions", "checkpoint_resolved"):
                    ts = a.get("created_at", "")
                    if ts > round_start:
                        round_start = ts
            already_handled = any(
                ("spawning agents" in a.get("message", "") or "Manual intervention needed" in a.get("message", ""))
                and a.get("created_at", "") >= round_start
                for a in existing_acts
            )
            if already_handled:
                continue
        except Exception:
            pass

        # Load structured triage state once; reused for the all-answered gate and repo routing.
        try:
            state = mc_request("GET", f"/api/tasks/{task_id}/triage-state")
        except Exception:
            state = None

        # Only proceed once EVERY structured question is answered AND the human has
        # confirmed. Confirmation lets the user review/edit answers (including the
        # agent's auto-suggestions) before anything dispatches. The all-answered check
        # is also what makes a follow-up question park the task here until answered.
        if state and state.get("questions"):
            unanswered = [q for q in state["questions"] if not q.get("answer")]
            if unanswered:
                logging.info(f"  {task_id[:8]} has {len(unanswered)} unanswered question(s) — waiting")
                continue
            if not state.get("confirmed"):
                logging.info(f"  {task_id[:8]} all answered but not confirmed — waiting for human confirmation")
                continue

        logging.info(f"Answers confirmed for: {title} ({task_id[:8]}) — proceeding to spawn agents")

        repos = state.get("triage_repos", []) if state else []

        if not repos:
            manifest = read_manifest()
            description = task.get("description", "")
            if answers:
                description = description + "\n\n" + answers
            repos = identify_repos(title, description, manifest)
            logging.info(f"  No repos in triage state — identified {len(repos)} from manifest + answers")

        if not repos:
            existing_qs = state.get("questions", []) if state else []
            already_asked_repo = any(q.get("id") == "repo_selection" for q in existing_qs)
            if already_asked_repo:
                # We already asked which repo to target and got an answer, but still can't
                # route — this genuinely needs a human.
                logging.warning(f"  Cannot identify target repos for {task_id[:8]} even after repo follow-up")
                mc_log_activity(task_id, "updated",
                    "Could not identify target repos even after a repo-selection follow-up. Manual intervention needed.")
                continue

            # Instead of dead-ending, ask a targeted repo-selection follow-up and keep the
            # task in planning. The all-answered gate above makes it wait until this is answered;
            # on the next pass the answer is folded into the description for identify_repos.
            options = _available_repo_options()
            repo_question = {
                "id": "repo_selection",
                "category": "repo",
                "question": "Which repo(s) should this task target? I couldn't determine this from the task and the answers so far.",
                "question_type": "multiple_choice" if options else "text",
                "options": (options + ["Other (please specify)"]) if options else None,
                "source": "planner",
                "why": ("Triage read the ticket and the answers so far and still could not tell "
                        "which repo this lands in. Planning cannot start without it."),
            }
            post_planning_questions(task_id, existing_qs + [repo_question],
                                    triage_result={"repos": [], "reasoning": "repo-selection follow-up"})
            # Dedicated activity type so the server emits a notification for the new question.
            mc_log_activity(task_id, "new_triage_question",
                "All questions answered but target repo unclear — posted a repo-selection follow-up.")
            logging.info(f"  Posted repo-selection follow-up for {task_id[:8]}")
            continue

        mc_log_activity(task_id, "updated", f"All questions answered — dispatching for {len(repos)} repo(s)")
        task_type = task.get("task_type", "implementation")
        use_planner = os.environ.get("ENABLE_PLANNER", "1") == "1"
        if use_planner and task_type == "implementation":
            _plan_and_dispatch(task, repos)
        else:
            _spawn_for_repos(task, repos)


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


def _launcher_for_entry(entry: dict) -> str:
    launcher = entry.get("launcher")
    if launcher == "codex":
        return str(SWARM_DIR / "run-codex.sh")
    if launcher == "pi":
        return str(SWARM_DIR / "run-pi.sh")
    return str(SWARM_DIR / "run-claude.sh")


def _env_exports_for_entry(entry: dict) -> str:
    exports = []
    profile = entry.get("agentProfile") or entry.get("agent")
    if profile:
        exports.append(f"export AGENT_PROFILE={shlex.quote(str(profile))};")
    model = entry.get("agentModel")
    if model:
        exports.append(f"export AGENT_MODEL={shlex.quote(str(model))};")
    provider = entry.get("agentProvider")
    if provider:
        exports.append(f"export AGENT_PROVIDER={shlex.quote(str(provider))};")
    thinking = entry.get("agentThinking")
    if thinking:
        exports.append(f"export AGENT_THINKING={shlex.quote(str(thinking))};")
    effort = entry.get("agentEffort")
    if effort:
        exports.append(f"export AGENT_EFFORT={shlex.quote(str(effort))};")
    cost_controls = entry.get("costControls") if isinstance(entry.get("costControls"), dict) else {}
    fallback = cost_controls.get("fallbackModel")
    if fallback:
        exports.append(f"export AGENT_FALLBACK_MODEL={shlex.quote(str(fallback))};")
    agent_env = entry.get("agentEnv") if isinstance(entry.get("agentEnv"), dict) else {}
    for key, value in agent_env.items():
        exports.append(f"export {key}={shlex.quote(str(value))};")
    return " ".join(exports) + (" " if exports else "")


def _relaunch_for_change_request(task: dict, change_requests_text: str, source: str = "dashboard"):
    """Re-launch an agent with change request feedback from Mission Control."""
    task_id = task["id"]

    entry = _find_agent_registry_entry(task_id)
    if not entry:
        logging.warning(f"  No agent registry entry for {task_id[:8]} — cannot re-launch")
        mc_log_activity(task_id, "updated",
                        "Change request received but no agent found to re-launch. Manual intervention needed.")
        return

    worktree = entry.get("worktree", "")
    session = entry.get("tmuxSession", "")
    agent_profile = entry.get("agentProfile", entry.get("agent", "claude"))
    reg_id = entry.get("id", "")

    if not worktree or not Path(worktree).exists():
        logging.warning(f"  Worktree not found for {task_id[:8]}: {worktree}")
        mc_log_activity(task_id, "updated",
                        "Change request received but agent worktree missing. Manual intervention needed.")
        return

    mc_update_task(task_id, {"status": "in_progress"})

    prompt_title = "Change Request from Mission Control"
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
""" + _design_prompt_section(task) + _video_prompt_section(task) + _attachment_prompt_section(task))

    try:
        subprocess.run(["tmux", "kill-session", "-t", session],
                       capture_output=True, timeout=10)
    except Exception:
        pass

    launcher = _launcher_for_entry(entry)
    env_exports = _env_exports_for_entry(entry)
    # Pass MC_TASK_ID explicitly. run-claude.sh's heartbeat loop early-exits without it,
    # and its registry fallback races the status="running" write below (the tmux session
    # starts before the write), so the relaunched agent otherwise never heartbeats and
    # the reaper false-flags it "stalled". Same reason spawn-agent.sh forwards it.
    _relaunch_mc_id = entry.get("mcTaskId") or task_id
    env_exports += f"export MC_TASK_ID={shlex.quote(str(_relaunch_mc_id))}; "

    try:
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "-c", worktree,
             f"bash -lc '{env_exports}PROMPT_OVERRIDE={shlex.quote(str(prompt_file))} exec {shlex.quote(launcher)} {shlex.quote(reg_id)}'"],
            capture_output=True, text=True, timeout=30,
        )
        logging.info(f"  Re-launched agent {reg_id} for change request ({agent_profile})")
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
                # Clear the stale heartbeat from the prior run — otherwise the reaper
                # measures heartbeat age across the relaunch and falsely flags the new
                # agent as "stalled/blocked" during its startup gap (a fresh spawn has
                # no lastHeartbeatAt and is never flagged; match that).
                e.pop("lastHeartbeatAt", None)
                break
        registry_file.write_text(json.dumps(entries, indent=2))
    except Exception:
        pass

    mc_log_activity(task_id, "updated", "Change request received from Mission Control — re-launching agent")


def _relaunch_for_investigation_followup(task: dict, followup_text: str, source: str = "dashboard"):
    task_id = task["id"]

    entry = _find_agent_registry_entry(task_id)
    if not entry:
        logging.warning(f"  No agent registry entry for {task_id[:8]} — cannot re-launch investigation follow-up")
        mc_log_activity(task_id, "updated",
                        "Investigation follow-up received but no agent found to re-launch. Manual intervention needed.")
        return

    worktree = entry.get("worktree", "")
    session = entry.get("tmuxSession", "")
    agent_profile = entry.get("agentProfile", entry.get("agent", "claude"))
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

    launcher = _launcher_for_entry(entry)
    env_exports = _env_exports_for_entry(entry)
    # Pass MC_TASK_ID explicitly. run-claude.sh's heartbeat loop early-exits without it,
    # and its registry fallback races the status="running" write below (the tmux session
    # starts before the write), so the relaunched agent otherwise never heartbeats and
    # the reaper false-flags it "stalled". Same reason spawn-agent.sh forwards it.
    _relaunch_mc_id = entry.get("mcTaskId") or task_id
    env_exports += f"export MC_TASK_ID={shlex.quote(str(_relaunch_mc_id))}; "

    try:
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "-c", worktree,
             f"bash -lc '{env_exports}PROMPT_OVERRIDE={shlex.quote(str(prompt_file))} exec {shlex.quote(launcher)} {shlex.quote(reg_id)}'"],
            capture_output=True, text=True, timeout=30,
        )
        logging.info(f"  Re-launched investigation agent {reg_id} for follow-up ({agent_profile})")
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
                e.pop("lastHeartbeatAt", None)  # avoid false "stalled" across relaunch (see change-request path)
                break
        registry_file.write_text(json.dumps(entries, indent=2))
    except Exception:
        pass

    mc_log_activity(task_id, "updated", "Investigation follow-up received from Mission Control — re-launching investigation agent")


def _capture_pr_for_task(task: dict):
    """Record the PR an agent opened for this task (once), so the UI can link to it.
    The agent runs `gh pr create` in its worktree but nothing pulls the URL back —
    look it up by the task's branch and store it as a 'pr' deliverable."""
    task_id = task["id"]
    try:
        delivs = mc_request("GET", f"/api/tasks/{task_id}/deliverables") or []
        if any(d.get("deliverable_type") == "pr" for d in delivs):
            return  # already captured
    except Exception:
        return
    entry = _find_agent_registry_entry(task_id)
    if not entry:
        return
    branch = entry.get("branch", "")
    worktree = entry.get("worktree", "")
    repo_path = Path(worktree) if worktree and Path(worktree).exists() else None
    if not repo_path or not branch:
        return
    prs = _gh_pr_list(repo_path, ["--state", "all", "--head", branch])
    if not prs:
        return
    p = prs[0]
    url = p.get("url", "")
    if not url:
        return
    try:
        mc_request("POST", f"/api/tasks/{task_id}/deliverables", {
            "deliverable_type": "pr",
            "title": f"PR #{p.get('number', '?')}: {p.get('title', '')}"[:120],
            "path": url,
        })
        mc_log_activity(task_id, "updated", f"PR ready for review: {url}")
        logging.info(f"  Recorded PR for {task_id[:8]}: {url}")
    except Exception as e:
        logging.warning(f"  Failed to record PR for {task_id[:8]}: {e}")


def _gh_pr_state(url: str) -> Optional[str]:
    """Return a PR's state (OPEN / MERGED / CLOSED), or None on error. Uses --repo
    parsed from the URL so it works regardless of the current directory."""
    import re
    m = re.match(r"https?://github\.com/([^/]+/[^/]+)/pull/(\d+)", url or "")
    if not m:
        return None
    repo, num = m.group(1), m.group(2)
    try:
        out = subprocess.run([_gh_bin(), "pr", "view", num, "--repo", repo, "--json", "state"],
                             capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return None
        return (json.loads(out.stdout or "{}") or {}).get("state")
    except Exception:
        return None


def _check_pr_status_for_task(task: dict) -> bool:
    """Close the loop on a review task by its captured PR: merged -> mark the task
    done; closed-without-merge -> note it once. Returns True if the task was closed out."""
    task_id = task["id"]
    try:
        delivs = mc_request("GET", f"/api/tasks/{task_id}/deliverables") or []
    except Exception:
        return False
    pr_url = next((d.get("path") for d in delivs
                   if d.get("deliverable_type") == "pr" and d.get("path")), None)
    if not pr_url:
        return False
    state = _gh_pr_state(pr_url)
    if state == "MERGED":
        mc_update_task(task_id, {"status": "done"})
        mc_log_activity(task_id, "status_changed", f"PR merged ({pr_url}) — task done.")
        logging.info(f"  {task_id[:8]} PR merged — marked done")
        return True
    if state == "CLOSED":
        try:
            acts = mc_request("GET", f"/api/tasks/{task_id}/activities") or []
            if not any("closed without merging" in a.get("message", "") for a in acts):
                mc_log_activity(task_id, "updated", f"PR was closed without merging ({pr_url}) — still in review.")
        except Exception:
            pass
    return False


# --- Auto-monitors for review-state PRs -------------------------------------------
# Automatically relaunch the agent to fix an open PR: merge conflicts, failing CI/lint,
# or new review comments. Guarded against loops by per-condition dedup markers (fire
# once per new head SHA / new comment id) and a hard per-task cap. Instruction text
# mirrors FOLLOWUP_ACTIONS in src/routes.ts — keep the two in sync.
_REVIEW_MONITOR_FILE = SWARM_DIR / "review-monitor.json"
_MAX_AUTO_FIX_PER_TASK = int(os.environ.get("MC_REVIEW_AUTOFIX_MAX", "5"))
_FOLLOWUP = {
    "merge_conflicts": "Auto follow-up: this PR has merge conflicts with its base branch. Fetch latest, "
        "merge/rebase the base branch in, resolve ALL conflicts (preserve both your change and the incoming "
        "base changes), run build + tests, then commit and push.",
    "ci_lint": "Auto follow-up: this PR's CI is failing. Run `gh pr checks`, reproduce locally, fix "
        "build/type/lint/test errors (run the repo's lint/format), then commit and push. Repeat until green.",
    "review_comments": "Auto follow-up: this PR has new review comments (human and/or bots like Greptile). "
        "Fetch them (`gh pr view <n> --comments` and `gh api repos/{owner}/{repo}/pulls/{n}/comments`), address "
        "every actionable one, then commit and push. Skip only comments that conflict with the ticket's "
        "acceptance criteria, and note why.",
}


def _load_review_monitor() -> dict:
    try:
        return json.loads(_REVIEW_MONITOR_FILE.read_text())
    except Exception:
        return {}


def _save_review_monitor(d: dict) -> None:
    try:
        _REVIEW_MONITOR_FILE.write_text(json.dumps(d, indent=2))
    except Exception:
        pass


_GH_SELF_LOGIN: Optional[str] = None


def _gh_self_login() -> str:
    """The GitHub login the agent pushes/comments as — so the monitor ignores the
    agent's own PR comments and doesn't react to itself."""
    global _GH_SELF_LOGIN
    if _GH_SELF_LOGIN is None:
        try:
            out = subprocess.run([_gh_bin(), "api", "user", "--jq", ".login"],
                                 capture_output=True, text=True, timeout=20)
            _GH_SELF_LOGIN = (out.stdout or "").strip().lower() if out.returncode == 0 else ""
        except Exception:
            _GH_SELF_LOGIN = ""
    return _GH_SELF_LOGIN


def _gh_pr_meta(url: str) -> Optional[dict]:
    import re
    m = re.match(r"https?://github\.com/([^/]+/[^/]+)/pull/(\d+)", url or "")
    if not m:
        return None
    repo, num = m.group(1), m.group(2)
    try:
        out = subprocess.run(
            [_gh_bin(), "pr", "view", num, "--repo", repo, "--json",
             "headRefOid,mergeable,state,statusCheckRollup"],
            capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return None
        d = json.loads(out.stdout or "{}")
        d["_repo"], d["_num"] = repo, num
        return d
    except Exception:
        return None


def _pr_ci_failing(meta: dict) -> bool:
    for c in meta.get("statusCheckRollup") or []:
        concl = (c.get("conclusion") or "").upper()
        state = (c.get("state") or "").upper()
        if concl in ("FAILURE", "TIMED_OUT", "STARTUP_FAILURE") or state in ("FAILURE", "ERROR"):
            return True
    return False


def _pr_comment_signals(meta: dict) -> dict:
    """Scan a PR's comments (inline review + issue) once and return two signals:
      - "ext": latest comment id NOT authored by our own account (a reviewer weighing in)
      - "mention": latest comment id whose body @-mentions the owner handle (a directive
        to the agent — fires regardless of author, since a mention is explicit; the agent
        won't @-mention itself, so no self-loop)."""
    self_login = _gh_self_login()
    owner = (os.environ.get("MC_REVIEW_OWNER_HANDLE") or self_login or "").lower()
    tag = f"@{owner}" if owner else None
    ext, mention = 0, 0
    for endpoint in (f"repos/{meta['_repo']}/pulls/{meta['_num']}/comments",
                     f"repos/{meta['_repo']}/issues/{meta['_num']}/comments"):
        try:
            out = subprocess.run(
                [_gh_bin(), "api", endpoint, "--jq", "[.[] | {id: .id, login: .user.login, body: .body}]"],
                capture_output=True, text=True, timeout=30)
            if out.returncode != 0:
                continue
            for c in json.loads(out.stdout or "[]"):
                cid = int(c.get("id") or 0)
                login = (c.get("login") or "").lower()
                body = (c.get("body") or "").lower()
                if self_login and login != self_login:
                    ext = max(ext, cid)
                if tag and tag in body:
                    mention = max(mention, cid)
        except Exception:
            continue
    return {"ext": ext, "mention": mention}


def _auto_review_monitor(task: dict) -> bool:
    """Relaunch the agent to fix a review-state PR (conflicts / CI / new review comments).
    Returns True if it triggered a relaunch. Dedup + a per-task cap prevent loops."""
    if os.environ.get("ENABLE_REVIEW_AUTOFIX", "1") != "1":
        return False
    if task.get("task_type", "implementation") != "implementation":
        return False
    task_id = task["id"]
    try:
        delivs = mc_request("GET", f"/api/tasks/{task_id}/deliverables") or []
    except Exception:
        return False
    pr_url = next((d.get("path") for d in delivs
                   if d.get("deliverable_type") == "pr" and d.get("path")), None)
    if not pr_url:
        return False
    meta = _gh_pr_meta(pr_url)
    if not meta or meta.get("state") != "OPEN":
        return False

    state = _load_review_monitor()
    head = meta.get("headRefOid") or ""

    # First time we see this PR: record a baseline (existing bot comments, any
    # pre-existing conflict/CI state) and fire NOTHING — so enabling the monitor doesn't
    # relaunch every open PR at once. Only conditions that appear AFTER this trigger.
    if task_id not in state:
        sig = _pr_comment_signals(meta)
        base = {"autoCount": 0, "lastCommentId": sig["ext"], "lastMentionId": sig["mention"]}
        if str(meta.get("mergeable", "")).upper() == "CONFLICTING":
            base["conflictHead"] = head
        if _pr_ci_failing(meta):
            base["ciHead"] = head
        state[task_id] = base
        _save_review_monitor(state)
        logging.info(f"  Auto-review-monitor: baselined {task_id[:8]} (no action on pre-existing state)")
        return False

    mk = state[task_id]
    if mk.get("autoCount", 0) >= _MAX_AUTO_FIX_PER_TASK:
        return False

    kind = None
    if str(meta.get("mergeable", "")).upper() == "CONFLICTING" and mk.get("conflictHead") != head:
        kind, mk["conflictHead"] = "merge_conflicts", head
    elif _pr_ci_failing(meta) and mk.get("ciHead") != head:
        kind, mk["ciHead"] = "ci_lint", head
    else:
        sig = _pr_comment_signals(meta)
        # An @owner mention is an explicit directive (fires from any author); a new
        # reviewer comment also fires. Update both markers so next cycle compares fresh.
        if sig["mention"] > mk.get("lastMentionId", 0) or sig["ext"] > mk.get("lastCommentId", 0):
            kind = "review_comments"
        mk["lastMentionId"] = sig["mention"]
        mk["lastCommentId"] = sig["ext"]

    if not kind:
        state[task_id] = mk
        _save_review_monitor(state)
        return False

    mk["autoCount"] = mk.get("autoCount", 0) + 1
    state[task_id] = mk
    _save_review_monitor(state)
    logging.info(f"  Auto-review-monitor: {task_id[:8]} → {kind} "
                 f"(relaunch {mk['autoCount']}/{_MAX_AUTO_FIX_PER_TASK})")
    mc_log_activity(task_id, "updated",
                    f"Auto follow-up: {kind.replace('_', ' ')} detected on the PR — relaunching agent.")
    _relaunch_for_change_request(task, _FOLLOWUP[kind], source="auto-monitor")
    return True


def process_review_tasks():
    """Watch for Mission Control feedback on tasks in review/testing status."""
    review_tasks = fetch_tasks_by_status("review") + fetch_tasks_by_status("testing")
    if not review_tasks:
        return

    logging.info(f"Checking {len(review_tasks)} review/testing tasks for Mission Control feedback")

    for task in review_tasks:
        task_id = task["id"]
        title = task["title"]
        task_type = task.get("task_type", "implementation")

        _capture_pr_for_task(task)
        if _check_pr_status_for_task(task):
            continue  # PR merged -> task done; nothing more to do

        dashboard_feedback = _collect_dashboard_feedback(task_id)
        if dashboard_feedback:
            logging.info(f"Dashboard feedback found for: {title} ({task_id[:8]}) — re-launching")
            if task_type == "investigation":
                _relaunch_for_investigation_followup(task, dashboard_feedback, source="dashboard")
            else:
                _relaunch_for_change_request(task, dashboard_feedback, source="dashboard")
            continue

        # No manual feedback — run the auto-monitors (merge conflicts / CI / review comments).
        _auto_review_monitor(task)


def process_human_escalations():
    """Detect needs_human activities on in-progress tasks and move them back to planning."""
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
        mc_set_progress(task_id, state="blocked", phase="escalation",
                        blocked_reason=escalation_msg[:500])

        # Raised after planning, by an agent that stopped — so it leads the ticket
        # rather than sitting among the opening triage questions.
        questions = [{
            "id": "agent_escalation",
            "question": escalation_msg,
            "category": "technical",
            "question_type": "text",
            "source": "planner",
            "why": "An agent stopped here rather than guess. Work is halted until this is settled.",
        }]
        post_planning_questions(task_id, questions)
        logging.info(f"  Recorded escalation in Mission Control for {task_id[:8]}")


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
        finally:
            release_task_lease(task["id"])
    else:
        logging.info("No inbox tasks to process")

    process_open_questions()
    process_answered_followups()
    process_planning_tasks()
    process_in_progress_plans()
    process_review_tasks()
    process_human_escalations()

    # Autopilot / Objective mode (fuzzy-goal autonomous runs). Best-effort —
    # never let it break the core bridge loop.
    try:
        import autopilot
        autopilot.process_objectives()
    except Exception as e:
        logging.error(f"autopilot loop error: {e}")
    # External review/ticket integrations should react to Mission Control state externally.

    # Signal whether an inbox task was claimed this cycle so the daemon can drain
    # a backlog promptly instead of waiting a full poll interval per task.
    return task is not None


def run_daemon(interval: int = 60):
    logging.info(f"Bridge daemon started (base poll {interval}s)")
    busy_interval = min(5, interval)
    max_backoff = max(interval * 10, 600)
    consecutive_failures = 0

    while True:
        did_work = False
        try:
            did_work = run_once()
            consecutive_failures = 0
        except Exception as e:
            consecutive_failures += 1
            logging.error(f"Bridge error (failure #{consecutive_failures}): {e}")

        if consecutive_failures:
            # Exponential backoff so a down Mission Control API is not hammered.
            delay = min(interval * (2 ** (consecutive_failures - 1)), max_backoff)
        elif did_work:
            # Keep draining while there is a backlog to dispatch.
            delay = busy_interval
        else:
            delay = interval
        time.sleep(delay)


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
