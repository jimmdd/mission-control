#!/usr/bin/env python3
"""
Distills task completion artifacts into knowledge entries stored in LanceDB.
Called by check-agents.sh after an agent completes a task.

Produces TWO types of knowledge:
  1. Procedural Skills — structured SKILL entries with steps, pitfalls, verification
     (triggered when task had 5+ commits, errors overcome, or multi-step work)
  2. Atomic Facts — single-line reusable facts (same as before, for simpler tasks)

Also supports:
  - Skill patching: if a skill already exists for this repo+domain, patches it
  - Lineage tracking: records task_id so feedback can trace which knowledge helped
  - Outcome tagging: marks entries with task success/failure for quality scoring

Shares the same LanceDB database as the OpenClaw memory-lancedb-pro plugin.
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional
from uuid import uuid4

import lancedb
import pyarrow as pa

# === Config ===

LANCEDB_PATH = os.path.expanduser("~/.openclaw/memory/lancedb-pro")
SWARM_CONFIG_PATH = Path.home() / ".openclaw" / "swarm" / "swarm-config.json"
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIM = 3072
EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
GITPROJECTS_DIR = Path.home() / "GitProjects"

# Thresholds for skill creation vs flat facts
SKILL_COMMIT_THRESHOLD = 5       # 5+ commits suggests complex work worth a skill
SKILL_FILE_THRESHOLD = 4         # 4+ files changed
SKILL_ERROR_KEYWORDS = ["retry", "fix:", "revert", "workaround", "failed", "flaky"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [knowledge-distill] %(message)s",
    datefmt="%H:%M:%S",
)


def _load_distill_model() -> str:
    """Load distillation model from swarm-config.json."""
    default = "gemini-2.5-flash"
    if SWARM_CONFIG_PATH.exists():
        try:
            cfg = json.loads(SWARM_CONFIG_PATH.read_text())
            return cfg.get("knowledge", {}).get("distill_model", default)
        except Exception:
            pass
    return default


def get_gemini_key() -> str:
    key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not key:
        env_file = Path.home() / ".openclaw" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("GOOGLE_GENERATIVE_AI_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
    return key


# === Embedding ===

def embed_text(text: str, api_key: str) -> List[float]:
    payload = json.dumps({
        "model": EMBEDDING_MODEL,
        "input": text,
    }).encode()

    req = urllib.request.Request(
        f"{EMBEDDING_BASE_URL}?key={api_key}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["data"][0]["embedding"]


# === Gemini Distillation ===

def call_gemini(prompt: str, api_key: str) -> str:
    model = _load_distill_model()
    url = f"{GEMINI_API_BASE}/models/{model}:generateContent?key={api_key}"
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
    }).encode()

    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    return data["candidates"][0]["content"]["parts"][0]["text"]


# === Complexity Detection ===

def _count_commits(worktree: str, branch: str) -> int:
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", "main..HEAD"],
            capture_output=True, text=True, timeout=10, cwd=worktree,
        )
        return len(result.stdout.strip().splitlines()) if result.stdout.strip() else 0
    except Exception:
        return 0


def _count_files_changed(worktree: str) -> int:
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "main", "--", ".", ":(exclude)*.lock"],
            capture_output=True, text=True, timeout=10, cwd=worktree,
        )
        return len(result.stdout.strip().splitlines()) if result.stdout.strip() else 0
    except Exception:
        return 0


def _has_error_recovery(artifacts: dict) -> bool:
    """Check if the task involved error recovery (suggests hard-won knowledge)."""
    text = " ".join(str(v) for v in artifacts.values()).lower()
    return any(kw in text for kw in SKILL_ERROR_KEYWORDS)


def should_create_skill(worktree: str, branch: str, artifacts: dict) -> bool:
    """Determine if this task warrants a procedural skill vs flat facts."""
    commits = _count_commits(worktree, branch)
    files = _count_files_changed(worktree)
    errors = _has_error_recovery(artifacts)

    reasons = []
    if commits >= SKILL_COMMIT_THRESHOLD:
        reasons.append(f"{commits} commits")
    if files >= SKILL_FILE_THRESHOLD:
        reasons.append(f"{files} files changed")
    if errors:
        reasons.append("error recovery detected")

    if reasons:
        logging.info(f"  Skill creation triggered: {', '.join(reasons)}")
        return True

    logging.info(f"  Flat facts mode ({commits} commits, {files} files, errors={errors})")
    return False


# === Skill Distillation ===

def distill_skill(artifacts: dict, project: str, repo: str) -> Optional[dict]:
    """Extract a structured procedural skill from complex task artifacts."""
    context_parts = []

    if artifacts.get("summary_md"):
        context_parts.append(f"## SUMMARY.md\n{artifacts['summary_md'][:3000]}")
    if artifacts.get("verification_md"):
        context_parts.append(f"## VERIFICATION.md\n{artifacts['verification_md'][:2000]}")
    if artifacts.get("git_log"):
        context_parts.append(f"## Git Log\n{artifacts['git_log'][:2000]}")
    if artifacts.get("git_diff"):
        context_parts.append(f"## Git Diff (truncated)\n{artifacts['git_diff'][:4000]}")
    if artifacts.get("codex_review"):
        context_parts.append(f"## Codex Review\n{artifacts['codex_review'][:2000]}")
    if artifacts.get("agent_summary"):
        context_parts.append(f"## Agent Summary\n{artifacts['agent_summary']}")

    if not context_parts:
        return None

    context = "\n\n---\n\n".join(context_parts)

    prompt = f"""You are extracting a PROCEDURAL SKILL from a completed task on repo {project}/{repo}.

A skill is a reusable procedure that teaches future agents HOW to accomplish a type of work in this repo.
It should capture the workflow that worked, the pitfalls encountered, and how to verify success.

Given these task artifacts, produce a skill in this JSON format:
{{
  "skill_title": "Short title (e.g. 'Adding API endpoints to odc-api')",
  "skill_domain": "Domain tag (e.g. 'api', 'testing', 'deployment', 'database', 'frontend', 'config')",
  "summary": "1-2 sentence summary of what this skill teaches",
  "steps": [
    "Step 1: What to do first",
    "Step 2: What to do next",
    "..."
  ],
  "pitfalls": [
    "Common mistake or gotcha and how to avoid it"
  ],
  "verification": [
    "How to verify the work is correct (specific commands or checks)"
  ],
  "key_files": ["src/relevant/file.ts"],
  "importance": 4
}}

Rules:
- Steps should be specific to THIS repo, not generic advice
- Include actual file paths, commands, and patterns from the artifacts
- Pitfalls should be things that actually went wrong or almost went wrong
- Verification should be runnable commands or checkable criteria
- importance: 5=essential for anyone doing this type of work, 3=helpful, 1=minor
- If the task was trivial and there's nothing worth teaching, return {{"skip": true}}

## Artifacts

{context}"""

    api_key = get_gemini_key()
    if not api_key:
        logging.error("No Gemini API key found")
        return None

    try:
        response = call_gemini(prompt, api_key)
    except Exception as e:
        logging.error(f"Gemini skill distillation failed: {e}")
        return None

    # Parse JSON response
    response = response.strip()
    if response.startswith("```"):
        response = response.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        skill = json.loads(response)
        if skill.get("skip"):
            logging.info("  Gemini says task too trivial for skill — falling back to facts")
            return None
        if "skill_title" not in skill or "steps" not in skill:
            logging.warning("  Invalid skill format from Gemini")
            return None
        return skill
    except json.JSONDecodeError:
        logging.warning(f"  Failed to parse skill JSON: {response[:200]}")
        return None


def format_skill_text(skill: dict) -> str:
    """Format a skill dict into a structured text for embedding and retrieval."""
    lines = [
        f"# Skill: {skill['skill_title']}",
        f"Domain: {skill.get('skill_domain', 'general')}",
        f"",
        skill.get("summary", ""),
        "",
        "## Steps",
    ]
    for i, step in enumerate(skill.get("steps", []), 1):
        lines.append(f"{i}. {step}")

    if skill.get("pitfalls"):
        lines.append("")
        lines.append("## Pitfalls")
        for pitfall in skill["pitfalls"]:
            lines.append(f"- {pitfall}")

    if skill.get("verification"):
        lines.append("")
        lines.append("## Verification")
        for v in skill["verification"]:
            lines.append(f"- {v}")

    if skill.get("key_files"):
        lines.append("")
        lines.append("## Key Files")
        for f in skill["key_files"]:
            lines.append(f"- {f}")

    return "\n".join(lines)


# === Flat Fact Distillation (existing, unchanged logic) ===

def distill_learnings(artifacts: dict, project: str, repo: str) -> List[dict]:
    """Call Gemini Flash to extract atomic knowledge entries from task artifacts."""
    context_parts = []

    if artifacts.get("summary_md"):
        context_parts.append(f"## SUMMARY.md\n{artifacts['summary_md'][:3000]}")
    if artifacts.get("verification_md"):
        context_parts.append(f"## VERIFICATION.md\n{artifacts['verification_md'][:2000]}")
    if artifacts.get("git_diff"):
        context_parts.append(f"## Git Diff (truncated)\n{artifacts['git_diff'][:4000]}")
    if artifacts.get("codex_review"):
        context_parts.append(f"## Codex Review\n{artifacts['codex_review'][:2000]}")
    if artifacts.get("agent_summary"):
        context_parts.append(f"## Agent Summary\n{artifacts['agent_summary']}")

    if not context_parts:
        logging.warning("No artifacts to distill")
        return []

    context = "\n\n---\n\n".join(context_parts)

    prompt = f"""You are a knowledge extraction system. Given the following task completion artifacts from repo {project}/{repo}, extract atomic knowledge entries.

Each entry should be ONE specific, reusable piece of knowledge that would help a FUTURE agent working on this repo or related repos. Think: what would I wish I knew before starting this task?

Categories:
- "fact": API contracts, endpoint details, data formats, env requirements
- "decision": Architectural choices, why X was chosen over Y
- "entity": Important files, services, configs that matter
- "other": Gotchas, workarounds, test requirements, build quirks

For each entry, output JSON (one per line, no wrapping array):
{{"text": "the knowledge", "category": "fact|decision|entity|other", "importance": 1-5}}

Rules:
- Be specific and actionable, not vague ("odc-api requires NODE_ENV=test for tests" not "tests need env vars")
- Skip trivial things (typo fixes, formatting changes)
- Max 8 entries per task — quality over quantity
- importance 5 = critical for anyone touching this repo, 1 = minor nice-to-know
- If there's nothing worth remembering, output nothing

## Artifacts

{context}"""

    api_key = get_gemini_key()
    if not api_key:
        logging.error("No Gemini API key found")
        return []

    try:
        response = call_gemini(prompt, api_key)
    except Exception as e:
        logging.error(f"Gemini distillation failed: {e}")
        return []

    entries = []
    for line in response.strip().splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        line = re.sub(r"^```json\s*", "", line)
        line = re.sub(r"\s*```$", "", line)
        try:
            entry = json.loads(line)
            if "text" in entry and "category" in entry:
                if entry["category"] not in ("preference", "fact", "decision", "entity", "other"):
                    entry["category"] = "other"
                entry["importance"] = max(1, min(5, int(entry.get("importance", 3))))
                entries.append(entry)
        except (json.JSONDecodeError, ValueError):
            continue

    logging.info(f"Distilled {len(entries)} knowledge entries")
    return entries


# === Skill Patching ===

def find_existing_skill(project: str, repo: str, domain: str) -> Optional[dict]:
    """Search LanceDB for an existing skill in the same repo+domain."""
    api_key = get_gemini_key()
    if not api_key:
        return None

    try:
        db = lancedb.connect(LANCEDB_PATH)
        table = db.open_table("memories")
    except Exception:
        return None

    scope = f"repo:{project}/{repo}"
    try:
        results = (
            table.search()
            .where(f"scope = '{scope}' AND category = 'skill'")
            .limit(50)
            .to_list()
        )
    except Exception:
        return None

    # Find skill with matching domain
    for row in results:
        text = row.get("text", "")
        if f"Domain: {domain}" in text:
            return row

    return None


def patch_skill(existing: dict, new_skill: dict, api_key: str) -> str:
    """Merge new learnings into an existing skill via targeted patching."""
    prompt = f"""You are patching an existing procedural skill with new learnings.

## Existing Skill
{existing.get('text', '')}

## New Learnings to Incorporate
{format_skill_text(new_skill)}

Produce the UPDATED skill text incorporating the new steps, pitfalls, and verifications.
Keep the existing content that's still valid. Add new content. Remove anything contradicted by the new learnings.
Output the complete updated skill text (not JSON, just the formatted skill text starting with "# Skill:")."""

    try:
        return call_gemini(prompt, api_key)
    except Exception as e:
        logging.warning(f"Skill patching failed: {e}")
        return format_skill_text(new_skill)


# === Artifact Harvesting ===

def harvest_artifacts(worktree: str, repo_path: str, branch: str,
                      codex_review: str = "", agent_summary: str = "") -> dict:
    artifacts = {}
    wt = Path(worktree) if worktree else Path(repo_path)

    summary_candidates = [
        wt / "SUMMARY.md",
        wt / ".planning" / "SUMMARY.md",
    ]
    for f in summary_candidates:
        if f.exists():
            artifacts["summary_md"] = f.read_text()[:4000]
            break

    verification_candidates = list(wt.glob(".planning/phases/*/*-VERIFICATION.md"))
    if verification_candidates:
        latest = max(verification_candidates, key=lambda p: p.stat().st_mtime)
        artifacts["verification_md"] = latest.read_text()[:3000]

    try:
        diff = subprocess.run(
            ["git", "diff", "main", "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json"],
            capture_output=True, text=True, timeout=30, cwd=str(wt),
        )
        if diff.stdout:
            artifacts["git_diff"] = diff.stdout[:6000]
    except Exception:
        pass

    # Also harvest git log for skill creation
    try:
        log = subprocess.run(
            ["git", "log", "--oneline", "main..HEAD"],
            capture_output=True, text=True, timeout=10, cwd=str(wt),
        )
        if log.stdout:
            artifacts["git_log"] = log.stdout[:2000]
    except Exception:
        pass

    if codex_review:
        artifacts["codex_review"] = codex_review
    if agent_summary:
        artifacts["agent_summary"] = agent_summary

    logging.info(f"Harvested artifacts: {list(artifacts.keys())}")
    return artifacts


# === LanceDB Storage ===

MEMORIES_SCHEMA = pa.schema([
    pa.field("id", pa.utf8()),
    pa.field("text", pa.utf8()),
    pa.field("vector", pa.list_(pa.float32(), EMBEDDING_DIM)),
    pa.field("category", pa.utf8()),
    pa.field("scope", pa.utf8()),
    pa.field("importance", pa.int32()),
    pa.field("timestamp", pa.int64()),
    pa.field("metadata", pa.utf8()),
])


def store_entries(entries: List[dict], project: str, repo: str, task_id: str,
                  task_outcome: str = "success"):
    api_key = get_gemini_key()
    if not api_key:
        logging.error("No Gemini API key — cannot embed")
        return

    db = lancedb.connect(LANCEDB_PATH)

    try:
        table = db.open_table("memories")
    except Exception:
        table = db.create_table("memories", schema=MEMORIES_SCHEMA)

    now_ms = int(time.time() * 1000)
    rows = []

    for entry in entries:
        try:
            vector = embed_text(entry["text"], api_key)
        except Exception as e:
            logging.warning(f"Embedding failed for entry, skipping: {e}")
            continue

        metadata = json.dumps({
            "source": entry.get("source", "knowledge-distill"),
            "task_id": task_id,
            "project": project,
            "repo": repo,
            "task_outcome": task_outcome,
            "recall_count": 0,
            "helped_count": 0,
        })

        rows.append({
            "id": str(uuid4()),
            "text": entry["text"],
            "vector": vector,
            "category": entry["category"],
            "scope": f"repo:{project}/{repo}",
            "importance": entry["importance"],
            "timestamp": now_ms,
            "metadata": metadata,
        })

    if rows:
        table.add(rows)
        logging.info(f"Stored {len(rows)} entries in LanceDB (scope: repo:{project}/{repo})")
    else:
        logging.warning("No entries to store")


def store_skill(skill: dict, project: str, repo: str, task_id: str,
                task_outcome: str = "success"):
    """Store a procedural skill, patching existing if found."""
    api_key = get_gemini_key()
    if not api_key:
        logging.error("No Gemini API key — cannot embed")
        return

    domain = skill.get("skill_domain", "general")
    existing = find_existing_skill(project, repo, domain)

    if existing:
        logging.info(f"  Found existing skill for {domain} — patching")
        updated_text = patch_skill(existing, skill, api_key)
        # Delete old entry and store updated
        try:
            db = lancedb.connect(LANCEDB_PATH)
            table = db.open_table("memories")
            table.delete(f"id = '{existing['id']}'")
            logging.info(f"  Deleted old skill {existing['id'][:8]}")
        except Exception as e:
            logging.warning(f"  Failed to delete old skill: {e}")
    else:
        updated_text = format_skill_text(skill)

    try:
        vector = embed_text(updated_text, api_key)
    except Exception as e:
        logging.error(f"Embedding failed for skill: {e}")
        return

    metadata = json.dumps({
        "source": "knowledge-distill",
        "entry_type": "skill",
        "skill_domain": domain,
        "skill_title": skill["skill_title"],
        "task_id": task_id,
        "project": project,
        "repo": repo,
        "task_outcome": task_outcome,
        "patched": existing is not None,
        "recall_count": 0,
        "helped_count": 0,
    })

    row = {
        "id": str(uuid4()),
        "text": updated_text,
        "vector": vector,
        "category": "skill",
        "scope": f"repo:{project}/{repo}",
        "importance": max(1, min(5, skill.get("importance", 4))),
        "timestamp": int(time.time() * 1000),
        "metadata": metadata,
    }

    db = lancedb.connect(LANCEDB_PATH)
    try:
        table = db.open_table("memories")
    except Exception:
        table = db.create_table("memories", schema=MEMORIES_SCHEMA)

    table.add([row])
    action = "patched" if existing else "created"
    logging.info(f"  Skill {action}: '{skill['skill_title']}' (domain: {domain})")


# === Repo Path Parsing ===

def parse_repo_info(repo_path: str) -> tuple:
    rp = Path(repo_path).resolve()
    gp = GITPROJECTS_DIR.resolve()

    try:
        relative = rp.relative_to(gp)
        parts = relative.parts
        if len(parts) >= 2:
            return parts[0], parts[1]
    except ValueError:
        pass

    return "unknown", rp.name


# === Main ===

def main():
    parser = argparse.ArgumentParser(description="Distill task artifacts into knowledge entries")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--worktree", default="")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--branch", default="main")
    parser.add_argument("--codex-review", default="")
    parser.add_argument("--agent-summary", default="")
    parser.add_argument("--mc-task-id", default="")
    parser.add_argument("--task-outcome", default="success",
                        help="Task outcome: success|failure|partial")
    args = parser.parse_args()

    project, repo_name = parse_repo_info(args.repo)
    logging.info(f"Distilling task {args.task_id} for {project}/{repo_name} (outcome: {args.task_outcome})")

    artifacts = harvest_artifacts(
        worktree=args.worktree,
        repo_path=args.repo,
        branch=args.branch,
        codex_review=args.codex_review,
        agent_summary=args.agent_summary,
    )

    if not artifacts:
        logging.info("No artifacts found — nothing to distill")
        return

    task_id = args.mc_task_id or args.task_id
    wt = args.worktree or args.repo

    # Decide: skill or flat facts
    if should_create_skill(wt, args.branch, artifacts):
        skill = distill_skill(artifacts, project, repo_name)
        if skill:
            store_skill(skill, project, repo_name, task_id, args.task_outcome)
            # Also extract a few key facts alongside the skill
            entries = distill_learnings(artifacts, project, repo_name)
            if entries:
                # Only keep high-importance facts not covered by the skill
                entries = [e for e in entries if e["importance"] >= 4][:3]
                if entries:
                    store_entries(entries, project, repo_name, task_id, args.task_outcome)
            logging.info("Knowledge distillation complete (skill + facts)")
            return
        # Skill distillation failed, fall back to facts
        logging.info("  Skill distillation returned None — falling back to facts")

    entries = distill_learnings(artifacts, project, repo_name)
    if not entries:
        logging.info("No knowledge entries extracted — nothing to store")
        return

    store_entries(entries, project, repo_name, task_id, args.task_outcome)
    logging.info("Knowledge distillation complete (facts)")


if __name__ == "__main__":
    main()
