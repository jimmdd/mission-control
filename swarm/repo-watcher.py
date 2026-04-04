#!/Users/mm/.openclaw/venv-3.12/bin/python3
"""Repo-watcher: monitors Git repos for architectural changes and extracts knowledge."""

import fnmatch
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

# Shared utilities
from mc_explore_common import (
    GITPROJECTS,
    SWARM_DIR,
    call_gemini,
    embed_text,
    get_gemini_key,
    git,
    load_env,
    make_adapter,
    parse_gemini_json,
    store_fact,
    store_relations,
    build_file_tree,
    walk_repo,
    identify_key_files,
    read_key_files,
)

# === Config ===

STATE_FILE = SWARM_DIR / "repo-watcher-state.json"
LOG_FILE = SWARM_DIR / "logs" / "repo-watcher.log"
MAX_CHANGED_CONTENT = 40_000  # 40KB cap on changed file contents

NON_ARCH_PATTERNS = [
    "*.lock",
    "*.md",
    "*.txt",
    ".github/*",
    ".circleci/*",
    "*.test.*",
    "*.spec.*",
    "__tests__/*",
    "test/*",
]

INCREMENTAL_PROMPT = """Given these recent changes to {domain}, identify architectural knowledge that changed.

Changed files: {file_list}
Commit messages: {commit_messages}
Changed file contents: {contents}

Return JSON:
{{
  "new_facts": [{{"text": "...", "category": "fact|decision|convention", "importance": 1-5}}],
  "superseded": [{{"old_text_pattern": "text of the fact that is now outdated", "new_text": "updated fact", "reason": "why it changed"}}],
  "relations": [{{"source": "...", "relation": "...", "target": "...", "weight": 0.5-1.0}}]
}}
Return empty arrays if nothing architecturally significant changed."""

FIRST_RUN_PROMPT = """Analyze this repository ({domain}) and extract key architectural knowledge.

File tree:
{file_tree}

Key file contents:
{key_contents}

Return JSON:
{{
  "new_facts": [{{"text": "...", "category": "fact|decision|convention", "importance": 1-5}}],
  "relations": [{{"source": "...", "relation": "...", "target": "...", "weight": 0.5-1.0}}]
}}
Focus on: tech stack, architecture patterns, key abstractions, project structure, conventions."""


# === Logging ===

def setup_logging():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(str(LOG_FILE)),
            logging.StreamHandler(sys.stderr),
        ],
    )


# === State ===

def load_state() -> Dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError) as e:
            logging.warning(f"Failed to load state file: {e}")
    return {}


def save_state(state: Dict) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.rename(STATE_FILE)


# === Repo Discovery ===

def discover_repos() -> List[Dict]:
    """Walk ~/GitProjects/*/* looking for .git dirs."""
    repos = []
    if not GITPROJECTS.is_dir():
        logging.warning(f"GitProjects directory not found: {GITPROJECTS}")
        return repos
    for project_dir in sorted(GITPROJECTS.iterdir()):
        if not project_dir.is_dir():
            continue
        project = project_dir.name
        for repo_dir in sorted(project_dir.iterdir()):
            if not repo_dir.is_dir():
                continue
            if (repo_dir / ".git").is_dir():
                repos.append({
                    "project": project,
                    "repo": repo_dir.name,
                    "path": repo_dir,
                    "domain": f"{project}/{repo_dir.name}",
                })
    return repos


# === Non-Architectural Detection ===

def is_non_architectural(filepath: str) -> bool:
    """Check if a file path matches non-architectural patterns."""
    for pattern in NON_ARCH_PATTERNS:
        if fnmatch.fnmatch(filepath, pattern):
            return True
        # Also check just the filename
        basename = os.path.basename(filepath)
        if fnmatch.fnmatch(basename, pattern):
            return True
    return False


def all_non_architectural(files: List[str]) -> bool:
    """Return True if ALL changed files are non-architectural."""
    if not files:
        return True
    return all(is_non_architectural(f) for f in files)


# === Changed File Contents ===

def read_changed_files(repo_dir: Path, files: List[str], max_total: int = MAX_CHANGED_CONTENT) -> str:
    """Read contents of changed files, capped at max_total bytes."""
    parts = []
    total = 0
    for f in files:
        if total >= max_total:
            break
        fp = repo_dir / f
        if not fp.is_file():
            continue
        try:
            content = fp.read_text(errors="replace")
            if len(content) > 4096:
                content = content[:4096] + "\n... (truncated)"
            parts.append(f"=== {f} ===\n{content}")
            total += len(content)
        except (OSError, UnicodeDecodeError):
            continue
    return "\n\n".join(parts)


# === Superseded Fact Handling ===

def handle_superseded(
    adapter,
    api_key: str,
    project: str,
    repo: str,
    superseded_entries: List[Dict],
) -> int:
    """Find old records via semantic search, set valid_to, create new with supersedes link."""
    domain = f"{project}/{repo}"
    count = 0
    now = datetime.now(timezone.utc)

    for entry in superseded_entries:
        old_pattern = entry.get("old_text_pattern", "")
        new_text = entry.get("new_text", "")
        reason = entry.get("reason", "")

        if not old_pattern or not new_text:
            continue

        try:
            # Find the old record via semantic search
            old_embedding = embed_text(old_pattern, api_key)
            results = adapter.semantic_search(old_embedding, domain=domain, top_k=3)

            # Find best match with high similarity
            old_record = None
            for r in results:
                if r.semantic_score >= 0.85:
                    old_record = r
                    break

            if old_record:
                # Set valid_to on old record
                old_record.valid_to = now
                if not old_record.metadata:
                    old_record.metadata = {}
                old_record.metadata["superseded_reason"] = reason
                adapter.upsert_record(old_record)
                logging.info(f"Superseded old record: {old_record.record_id[:8]}...")

            # Create new fact with supersedes link
            new_embedding = embed_text(new_text, api_key)
            extra_meta = {"supersedes_reason": reason}
            if old_record:
                extra_meta["supersedes"] = old_record.record_id

            record_id = store_fact(
                adapter,
                text=new_text,
                embedding=new_embedding,
                project=project,
                repo=repo,
                category="fact",
                importance=3,
                source="repo-watcher",
                stage="staged",
                extra_metadata=extra_meta,
            )
            if record_id:
                count += 1
                logging.info(f"Created superseding fact: {record_id[:8]}...")

        except Exception as e:
            logging.error(f"Error handling superseded entry: {e}")

    return count


# === Incremental Processing ===

def process_incremental(
    repo_info: Dict,
    old_sha: str,
    new_sha: str,
    api_key: str,
    adapter,
) -> Dict:
    """Process incremental changes for a repo."""
    repo_dir = repo_info["path"]
    domain = repo_info["domain"]
    stats = {"facts": 0, "relations": 0, "superseded": 0, "skipped": False}

    # Pull latest
    git(repo_dir, "pull", "--quiet")

    # Get changed files
    changed_files_raw = git(repo_dir, "diff", "--name-only", f"{old_sha}..{new_sha}")
    if not changed_files_raw:
        stats["skipped"] = True
        return stats
    changed_files = [f for f in changed_files_raw.splitlines() if f.strip()]

    # Skip if only non-architectural files changed
    if all_non_architectural(changed_files):
        logging.info(f"  Skipping {domain}: only non-architectural files changed")
        stats["skipped"] = True
        return stats

    # Read changed file contents
    contents = read_changed_files(repo_dir, changed_files)

    # Get commit messages
    commit_messages = git(repo_dir, "log", "--oneline", f"{old_sha}..{new_sha}")

    # Build prompt
    prompt = INCREMENTAL_PROMPT.format(
        domain=domain,
        file_list="\n".join(changed_files),
        commit_messages=commit_messages,
        contents=contents,
    )

    # Call Gemini
    response = call_gemini(prompt, api_key)
    if not response:
        logging.warning(f"  No Gemini response for {domain}")
        return stats

    parsed = parse_gemini_json(response)
    if not parsed:
        logging.warning(f"  Failed to parse Gemini response for {domain}")
        return stats

    # Store new facts
    new_facts = parsed.get("new_facts", [])
    for fact in new_facts:
        text = fact.get("text", "")
        if not text:
            continue
        try:
            embedding = embed_text(text, api_key)
            record_id = store_fact(
                adapter,
                text=text,
                embedding=embedding,
                project=repo_info["project"],
                repo=repo_info["repo"],
                category=fact.get("category", "fact"),
                importance=fact.get("importance", 3),
                source="repo-watcher",
                stage="staged",
            )
            if record_id:
                stats["facts"] += 1

                # Store relations for this fact
                fact_relations = parsed.get("relations", [])
                if fact_relations:
                    stored = store_relations(adapter, record_id, fact_relations)
                    stats["relations"] += stored
        except Exception as e:
            logging.error(f"  Error storing fact for {domain}: {e}")

    # Handle superseded facts
    superseded = parsed.get("superseded", [])
    if superseded:
        stats["superseded"] = handle_superseded(
            adapter, api_key, repo_info["project"], repo_info["repo"], superseded
        )

    return stats


# === First-Run Processing ===

def process_first_run(
    repo_info: Dict,
    api_key: str,
    adapter,
) -> Dict:
    """Lightweight full extraction for repos seen for the first time."""
    repo_dir = repo_info["path"]
    domain = repo_info["domain"]
    stats = {"facts": 0, "relations": 0}

    logging.info(f"  First-run extraction for {domain}")

    # Build file tree
    file_tree = build_file_tree(repo_dir, max_depth=3)

    # Find and read key files
    all_files = walk_repo(repo_dir)
    key_files = identify_key_files(repo_dir, all_files)
    key_contents_dict = read_key_files(key_files, max_total=30_000)

    key_contents = "\n\n".join(
        f"=== {path} ===\n{content}"
        for path, content in key_contents_dict.items()
    )

    # Build prompt
    prompt = FIRST_RUN_PROMPT.format(
        domain=domain,
        file_tree=file_tree,
        key_contents=key_contents,
    )

    # Call Gemini
    response = call_gemini(prompt, api_key)
    if not response:
        logging.warning(f"  No Gemini response for first-run {domain}")
        return stats

    parsed = parse_gemini_json(response)
    if not parsed:
        logging.warning(f"  Failed to parse Gemini response for first-run {domain}")
        return stats

    # Store facts
    new_facts = parsed.get("new_facts", [])
    all_relations = parsed.get("relations", [])

    for fact in new_facts:
        text = fact.get("text", "")
        if not text:
            continue
        try:
            embedding = embed_text(text, api_key)
            record_id = store_fact(
                adapter,
                text=text,
                embedding=embedding,
                project=repo_info["project"],
                repo=repo_info["repo"],
                category=fact.get("category", "fact"),
                importance=fact.get("importance", 3),
                source="repo-watcher",
                stage="staged",
            )
            if record_id:
                stats["facts"] += 1
                if all_relations:
                    stored = store_relations(adapter, record_id, all_relations)
                    stats["relations"] += stored
        except Exception as e:
            logging.error(f"  Error storing first-run fact for {domain}: {e}")

    return stats


# === Main ===

def main():
    setup_logging()
    logging.info("=== repo-watcher starting ===")

    # Load environment
    load_env()
    api_key = get_gemini_key()
    if not api_key:
        logging.error("No GOOGLE_GENERATIVE_AI_API_KEY found")
        sys.exit(1)

    # Load state
    state = load_state()
    logging.info(f"Loaded state with {len(state)} tracked repos")

    # Discover repos
    repos = discover_repos()
    logging.info(f"Discovered {len(repos)} repos in GitProjects")

    # Connect to storage
    try:
        adapter = make_adapter()
    except Exception as e:
        logging.error(f"Failed to connect to storage: {e}")
        sys.exit(1)

    # Process repos
    total_stats = {"processed": 0, "skipped": 0, "first_run": 0, "facts": 0, "relations": 0, "superseded": 0, "errors": 0}

    for repo_info in repos:
        domain = repo_info["domain"]
        repo_dir = repo_info["path"]

        # Get current HEAD
        current_sha = git(repo_dir, "rev-parse", "HEAD")
        if not current_sha:
            logging.warning(f"  Could not get HEAD for {domain}, skipping")
            continue

        repo_state = state.get(domain)

        if repo_state is None:
            # First run for this repo
            try:
                stats = process_first_run(repo_info, api_key, adapter)
                total_stats["first_run"] += 1
                total_stats["facts"] += stats["facts"]
                total_stats["relations"] += stats["relations"]
            except Exception as e:
                logging.error(f"  Error in first-run for {domain}: {e}")
                total_stats["errors"] += 1

            # Update state
            state[domain] = {
                "sha": current_sha,
                "last_processed": datetime.now(timezone.utc).isoformat(),
            }
            save_state(state)
            continue

        old_sha = repo_state.get("sha", "")

        if current_sha == old_sha:
            # No changes
            total_stats["skipped"] += 1
            continue

        # Incremental processing
        logging.info(f"Processing {domain}: {old_sha[:8]}..{current_sha[:8]}")
        try:
            stats = process_incremental(repo_info, old_sha, current_sha, api_key, adapter)
            total_stats["processed"] += 1
            total_stats["facts"] += stats["facts"]
            total_stats["relations"] += stats["relations"]
            total_stats["superseded"] += stats.get("superseded", 0)
            if stats.get("skipped"):
                total_stats["skipped"] += 1
                total_stats["processed"] -= 1
        except Exception as e:
            logging.error(f"  Error processing {domain}: {e}")
            total_stats["errors"] += 1

        # Update state (crash-safe: save after each repo)
        state[domain] = {
            "sha": current_sha,
            "last_processed": datetime.now(timezone.utc).isoformat(),
        }
        save_state(state)

    # Summary
    logging.info(
        f"=== repo-watcher complete === "
        f"processed={total_stats['processed']} first_run={total_stats['first_run']} "
        f"skipped={total_stats['skipped']} facts={total_stats['facts']} "
        f"relations={total_stats['relations']} superseded={total_stats['superseded']} "
        f"errors={total_stats['errors']}"
    )


if __name__ == "__main__":
    main()
