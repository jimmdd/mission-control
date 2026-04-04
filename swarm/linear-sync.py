#!/usr/bin/env python3
"""
Linear → Mission Control Sync

Polls Linear for issues with the configured label and creates
corresponding tasks in Mission Control. Runs on cron (every 5 min).

Deduplication: Uses external_id on MC tasks to avoid duplicates.
Sync-back: Updates Linear issue status when MC task reaches 'done'.
"""

import argparse
import json
import logging
import os
import re
import sys
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

MC_BASE_URL = os.environ.get("MISSION_CONTROL_URL", "http://localhost:18789/ext/mission-control")
LINEAR_API_URL = "https://api.linear.app/graphql"
ENV_FILE = Path.home() / ".openclaw" / ".env"
STATE_FILE = Path.home() / ".openclaw" / "sync" / "linear-state.json"
LOG_DIR = Path.home() / ".openclaw" / "sync" / "logs"
SWARM_CONFIG_FILE = Path.home() / ".openclaw" / "swarm" / "swarm-config.json"

DEFAULT_LINEAR_CONFIG = {
    "label": "your-label",
    "triageLabel": "",
    "mentionTag": "[mc-bot]",
    "botName": "Mission Control",
}


def load_linear_config() -> Dict[str, str]:
    config = DEFAULT_LINEAR_CONFIG.copy()
    if not SWARM_CONFIG_FILE.exists():
        return config

    try:
        data = json.loads(SWARM_CONFIG_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return config

    linear = data.get("linear", {})
    if isinstance(linear, dict):
        for key in ("label", "triageLabel", "mentionTag", "botName"):
            value = linear.get(key)
            if isinstance(value, str) and value.strip():
                config[key] = value.strip()
    return config


LINEAR_CONFIG = load_linear_config()
LINEAR_LABEL = LINEAR_CONFIG["label"]
LINEAR_TRIAGE_LABEL = LINEAR_CONFIG.get("triageLabel", "")
LINEAR_MENTION_TAG = LINEAR_CONFIG["mentionTag"]
LINEAR_BOT_NAME = LINEAR_CONFIG["botName"]
BOT_REPLY_PREFIX = f"{LINEAR_MENTION_TAG} **{LINEAR_BOT_NAME}**"


def _parse_csv_env(name: str) -> List[str]:
    raw = os.environ.get(name, "")
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def get_linear_team_keys() -> List[str]:
    return [key.upper() for key in _parse_csv_env("LINEAR_TEAM_KEYS")]

PRIORITY_MAP = {
    0: "normal",   # No priority
    1: "urgent",   # Urgent
    2: "high",     # High
    3: "normal",   # Medium
    4: "low",      # Low
}


def setup_logging():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / f"sync-{datetime.now().strftime('%Y%m%d')}.log"
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


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"last_sync": None, "synced_issues": {}}


def save_state(state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def linear_query(query: str, variables: Optional[dict] = None) -> dict:
    """Execute a Linear GraphQL query."""
    api_key = os.environ.get("LINEAR_API_KEY", "")
    if not api_key:
        raise RuntimeError("LINEAR_API_KEY not set")

    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        LINEAR_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": api_key,
        },
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        if "errors" in data:
            raise RuntimeError(f"Linear API error: {data['errors']}")
        return data["data"]


def mc_request(method: str, path: str, body: Optional[dict] = None) -> dict:
    """Make a request to Mission Control API."""
    url = f"{MC_BASE_URL}{path}"
    payload = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"} if payload else {},
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        logging.error(f"MC API error {e.code}: {error_body}")
        raise


def verify_workspace() -> bool:
    expected = os.environ.get("LINEAR_WORKSPACE", "")
    if not expected:
        logging.warning("LINEAR_WORKSPACE not set — skipping workspace verification")
        return True

    data = linear_query("{ organization { name } }")
    org_name = data.get("organization", {}).get("name", "")
    if org_name != expected:
        logging.error(f"Wrong workspace: got '{org_name}', expected '{expected}'. Aborting.")
        return False
    logging.info(f"Workspace verified: {org_name}")
    return True


def _fetch_issues_by_label(label: str, team_key: Optional[str] = None) -> List[dict]:
    team_filter = f", team: {{ key: {{ eq: \"{team_key}\" }} }}" if team_key else ""
    query = f"""
    query LabeledIssues($after: String) {{
      issues(
        filter: {{ labels: {{ name: {{ eq: "{label}" }} }}{team_filter} }}
        first: 50
        after: $after
        orderBy: createdAt
      ) {{
        nodes {{
          id
          identifier
          title
          description
          priority
          priorityLabel
          url
          createdAt
          updatedAt
          state {{ name type }}
          assignee {{ name email }}
          project {{ name }}
          team {{ name key }}
          labels {{ nodes {{ name }} }}
        }}
        pageInfo {{
          hasNextPage
          endCursor
        }}
      }}
    }}
    """

    all_issues: List[dict] = []
    cursor = None

    while True:
        data = linear_query(query, {"after": cursor})
        issues = data["issues"]
        all_issues.extend(issues["nodes"])

        if not issues["pageInfo"]["hasNextPage"]:
            break
        cursor = issues["pageInfo"]["endCursor"]

    return all_issues


def fetch_labeled_issues() -> List[dict]:
    """Fetch issues with either the implementation label or triage label."""
    team_keys = get_linear_team_keys()

    if team_keys:
        issues: List[dict] = []
        for team_key in team_keys:
            issues.extend(_fetch_issues_by_label(LINEAR_LABEL, team_key=team_key))
    else:
        issues = _fetch_issues_by_label(LINEAR_LABEL)

    if LINEAR_TRIAGE_LABEL:
        triage_issues: List[dict] = []
        if team_keys:
            for team_key in team_keys:
                triage_issues.extend(_fetch_issues_by_label(LINEAR_TRIAGE_LABEL, team_key=team_key))
        else:
            triage_issues = _fetch_issues_by_label(LINEAR_TRIAGE_LABEL)

        seen_ids = {i["id"] for i in issues}
        for issue in triage_issues:
            if issue["id"] not in seen_ids:
                issues.append(issue)
                seen_ids.add(issue["id"])

    if team_keys:
        logging.info(f"Team filter enabled: {', '.join(team_keys)}")

    return issues


def get_existing_mc_tasks() -> Dict[str, dict]:
    """Get all MC tasks that have a Linear external_id."""
    try:
        tasks = mc_request("GET", "/api/tasks")
        result = {}
        for t in tasks:
            ext_id = t.get("external_id") or t.get("linear_issue_id")
            if ext_id:
                t["external_id"] = ext_id
                result[ext_id] = t
        return result
    except Exception as e:
        logging.warning(f"Failed to fetch MC tasks: {e}")
        return {}


_workspace_id_cache: Optional[str] = None


def _get_target_workspace_id() -> str:
    global _workspace_id_cache
    if _workspace_id_cache:
        return _workspace_id_cache

    slug = os.environ.get("LINEAR_WORKSPACE", "").lower()
    if slug:
        try:
            workspaces = mc_request("GET", "/api/workspaces")
            for ws in workspaces:
                if ws.get("slug", "").lower() == slug or ws.get("name", "").lower() == slug:
                    workspace_id = ws.get("id")
                    if isinstance(workspace_id, str) and workspace_id:
                        _workspace_id_cache = workspace_id
                        return workspace_id
            logging.warning(f"Workspace '{slug}' not found in MC — using default")
        except Exception as e:
            logging.error(f"Failed to resolve workspace '{slug}': {e} — will retry next cycle")
            return "default"

    _workspace_id_cache = "default"
    return _workspace_id_cache


def _resolve_task_type(issue: dict) -> str:
    label_names = [l.get("name", "") for l in issue.get("labels", {}).get("nodes", [])]
    if LINEAR_TRIAGE_LABEL and LINEAR_TRIAGE_LABEL in label_names:
        return "investigation"
    return "implementation"


def create_mc_task(issue: dict) -> Optional[dict]:
    """Create a Mission Control task from a Linear issue."""
    priority = PRIORITY_MAP.get(issue.get("priority", 0), "normal")

    description_parts = []
    if issue.get("description"):
        description_parts.append(issue["description"])

    description_parts.append(f"\n---\n*Synced from Linear: [{issue['identifier']}]({issue['url']})*")

    if issue.get("assignee"):
        description_parts.append(f"*Linear assignee: {issue['assignee']['name']}*")

    if issue.get("project"):
        description_parts.append(f"*Linear project: {issue['project']['name']}*")

    task_type = _resolve_task_type(issue)

    body = {
        "title": f"[{issue['identifier']}] {issue['title']}",
        "description": "\n".join(description_parts),
        "priority": priority,
        "source": "linear",
        "external_id": issue["id"],
        "external_url": issue["url"],
        "workspace_id": _get_target_workspace_id(),
        "task_type": task_type,
    }

    try:
        task = mc_request("POST", "/api/tasks", body)
        logging.info(f"  Created MC task: {task.get('id', '?')[:8]} ← {issue['identifier']}")
        return task
    except Exception as e:
        logging.error(f"  Failed to create MC task for {issue['identifier']}: {e}")
        return None


def sync_status_back(mc_task: dict, issue_id: str):
    """When MC task is done, add a comment to Linear issue."""
    if mc_task.get("status") != "done":
        return

    try:
        mutation = """
        mutation AddComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }
        """
        linear_query(mutation, {
            "issueId": issue_id,
            "body": f"✅ Completed by {LINEAR_BOT_NAME} agent swarm.\n\nMission Control task: `{mc_task['id']}`",
        })
        logging.info(f"  Synced completion back to Linear for {issue_id[:8]}")
    except Exception as e:
        logging.warning(f"  Failed to sync back to Linear: {e}")


def is_terminal_state(issue: dict) -> bool:
    state_type = issue.get("state", {}).get("type", "")
    return state_type in ("completed", "cancelled")


def is_on_hold_state(issue: dict) -> bool:
    state_type = issue.get("state", {}).get("type", "")
    state_name = issue.get("state", {}).get("name", "").lower()
    if state_type in ("backlog", "triage"):
        return True
    if any(kw in state_name for kw in ("on hold", "paused", "blocked", "draft", "parked")):
        return True
    return False


BOT_COMMENT_MARKERS = [
    f"{LINEAR_BOT_NAME} needs clarification",
    f"Completed by {LINEAR_BOT_NAME}",
    f"{LINEAR_BOT_NAME} agent swarm",
    f"**{LINEAR_BOT_NAME}**:",
    BOT_REPLY_PREFIX,
]
LIBRARIAN_DIR = Path.home() / ".openclaw" / "librarian"
CONTEXT_FABRICA_DSN = os.environ.get("CONTEXT_FABRICA_DSN", "postgresql://mm@localhost/context_fabrica")
GEMINI_FLASH = "gemini-2.5-flash"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
EMBEDDING_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent"
GEMINI_PRO = "gemini-2.5-pro"
RESEARCH_DIR = Path.home() / ".openclaw" / "swarm" / "research"
SWARM_DIR = Path.home() / ".openclaw" / "swarm"
GITPROJECTS_DIR = Path.home() / "GitProjects"


def _is_bot_comment(body: str) -> bool:
    return any(marker in body for marker in BOT_COMMENT_MARKERS)


def _has_mention_tag(body: str) -> bool:
    trigger_patterns = [re.escape(LINEAR_MENTION_TAG)]

    triage_label = (LINEAR_TRIAGE_LABEL or "").strip()
    if triage_label:
        trigger_patterns.append(re.escape(f"[{triage_label}]"))
        trigger_patterns.append(rf"(?<!\w){re.escape(triage_label)}(?!\w)")

    return any(re.search(pattern, body, re.IGNORECASE) for pattern in trigger_patterns)


def _resolve_thread_parent(comment: dict) -> Optional[str]:
    """Linear requires parentId to be a top-level comment. If the comment is
    already a reply, use its parent's ID; otherwise use the comment's own ID."""
    parent = comment.get("parent")
    if parent and parent.get("id"):
        return parent["id"]
    return comment.get("id")


def _call_gemini(prompt: str, api_key: str, model: str = GEMINI_FLASH) -> Optional[str]:
    url = f"{GEMINI_API_BASE}/models/{model}:generateContent?key={api_key}"
    timeout = 120 if model == GEMINI_PRO else 60
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 2048},
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        logging.error(f"  Gemini call failed: {e}")
        return None


def _classify_question(question: str, api_key: str) -> str:
    """Classify a mention-tagged question as 'simple' or 'research'."""
    research_signals = [
        "how does", "how is", "where is", "trace", "pipeline",
        "function", "class", "method", "implementation", "behavior",
        "padding", "parameter", ".py", ".ts", ".json", ".rs",
        "source", "logic", "algorithm", "flow", "config",
        "what happens when", "why does", "walk me through",
    ]
    q_lower = question.lower()
    signal_count = sum(1 for s in research_signals if s in q_lower)
    if signal_count >= 3:
        return "research"

    prompt = (
        "Classify this engineering question into exactly one category.\n"
        "- simple: Answerable from repo descriptions, tech stacks, project structure, "
        "or general knowledge. Examples: 'What language is repo X?', 'Where are the docs?'\n"
        "- research: Requires reading actual source code, tracing function calls, "
        "understanding implementation details, or comparing configurations. "
        "Examples: 'How does padding work?', 'What is the auth flow?', 'Why does X call Y?'\n\n"
        f"Question: {question[:500]}\n\n"
        "Reply with exactly one word: simple or research"
    )
    result = _call_gemini(prompt, api_key)
    if result and "research" in result.strip().lower():
        return "research"
    return "simple" if signal_count < 2 else "research"


def _find_repo_path(text: str) -> Optional[Path]:
    """Extract repo name from text and find its path in ~/GitProjects."""
    import re
    candidates = re.findall(
        r'(?:in|from|for|repo[:\s]+|`|/)[\s`]*([a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)?)',
        text, re.IGNORECASE,
    )
    # Also match bare hyphenated identifiers that look like repo names
    candidates += re.findall(r'\b([a-z][a-z0-9]*(?:-[a-z0-9]+){1,})\b', text)
    seen: set = set()
    for candidate in candidates:
        repo_name = candidate.split("/")[-1].strip("`").strip()
        if repo_name in seen or len(repo_name) < 3:
            continue
        seen.add(repo_name)
        if not GITPROJECTS_DIR.is_dir():
            continue
        for project_dir in GITPROJECTS_DIR.iterdir():
            if not project_dir.is_dir():
                continue
            repo_dir = project_dir / repo_name
            if repo_dir.is_dir() and (repo_dir / ".git").exists():
                return repo_dir
    return None


def _post_placeholder(issue_id: str, comment_id: str) -> bool:
    """Post a 'researching' placeholder reply to Linear."""
    linear_api_key = os.environ.get("LINEAR_API_KEY", "")
    if not linear_api_key:
        return False
    body = (
        f"{BOT_REPLY_PREFIX}: \U0001f50d Researching your question — "
        "I'll post a detailed answer shortly."
    )
    mutation = """
    mutation AddComment($issueId: String!, $body: String!, $parentId: String) {
      commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success }
    }
    """
    try:
        variables: Dict[str, Any] = {"issueId": issue_id, "body": body}
        if comment_id:
            variables["parentId"] = comment_id
        linear_query(mutation, variables)
        return True
    except Exception as e:
        logging.warning(f"  Failed to post placeholder: {e}")
        return False


def _spawn_research(question_id: str, question: str, issue_title: str,
                    author: str, repo_path: Path, issue_id: str,
                    comment_id: str) -> bool:
    """Spawn a Claude Code research agent in the background."""
    RESEARCH_DIR.mkdir(parents=True, exist_ok=True)
    prompt_dir = SWARM_DIR / "prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)

    output_file = RESEARCH_DIR / f"{question_id}.md"
    prompt_file = prompt_dir / f"research-{question_id}.md"

    prompt_content = (
        "# Research Task\n\n"
        "You are a code research agent. A team member asked this question "
        f'in a Linear ticket titled "{issue_title}":\n\n'
        f"**Question from {author}:**\n{question}\n\n"
        "## Instructions\n\n"
        "1. Explore the codebase to find the answer\n"
        "2. Use grep, glob, and read tools to find relevant files\n"
        "3. Trace function calls and understand code flow\n"
        "4. Read configuration files if relevant\n"
        "5. Be thorough — check multiple files if needed\n\n"
        "## Output\n\n"
        "When you have completed your research, write your findings to:\n"
        f"`{output_file}`\n\n"
        "Format the file as markdown:\n"
        "- Start with a **one-paragraph summary** answering the question directly\n"
        "- Then add a `## Detailed Findings` section with:\n"
        "  - Relevant file paths and line numbers\n"
        "  - Code patterns and function signatures\n"
        "  - Configuration comparisons if applicable\n"
        "- Keep the summary under 500 words\n"
        "- Use markdown formatting suitable for posting in Linear\n\n"
        "## Constraints\n\n"
        "- READ ONLY — do not modify any source code files\n"
        "- Focus on answering the specific question asked\n"
        "- Reference actual files and line numbers\n"
        "- If you cannot find a definitive answer, say what you found "
        "and what remains unclear\n"
    )
    prompt_file.write_text(prompt_content)

    meta_file = RESEARCH_DIR / f"{question_id}.meta.json"
    meta = {
        "question_id": question_id,
        "question": question[:1000],
        "issue_id": issue_id,
        "comment_id": comment_id,
        "issue_title": issue_title,
        "author": author,
        "repo_path": str(repo_path),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_file.write_text(json.dumps(meta, indent=2))

    research_script = SWARM_DIR / "research-agent.sh"
    try:
        subprocess.Popen(
            ["bash", str(research_script), question_id, str(repo_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        logging.info(f"  Spawned research agent: {question_id} in {repo_path}")
        return True
    except Exception as e:
        logging.error(f"  Failed to spawn research agent: {e}")
        return False


def _distill_research(question: str, findings: str, repo_path: str) -> None:
    """Store research Q&A in context-fabrica for future instant recall."""
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        return
    try:
        from context_fabrica.storage import PostgresPgvectorAdapter
        from context_fabrica.models import KnowledgeRecord

        summary = findings.strip().split("\n\n")[0] if findings else ""
        text = f"Q: {question[:500]}\nA: {summary[:1500]}"

        embed_payload = json.dumps({
            "model": "models/gemini-embedding-001",
            "content": {"parts": [{"text": text}]},
        }).encode()
        embed_req = urllib.request.Request(
            f"{EMBEDDING_URL}?key={api_key}",
            data=embed_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(embed_req, timeout=15) as resp:
            vector = json.loads(resp.read())["embedding"]["values"]

        scope = "global"
        domain = "general"
        if repo_path:
            parts = Path(repo_path).parts
            gp_idx = next(
                (i for i, p in enumerate(parts) if p == "GitProjects"), -1
            )
            if gp_idx >= 0 and len(parts) > gp_idx + 2:
                scope = f"repo:{parts[gp_idx + 1]}/{parts[gp_idx + 2]}"
                domain = parts[gp_idx + 1]

        adapter = PostgresPgvectorAdapter.from_dsn(CONTEXT_FABRICA_DSN, embedding_dimensions=3072)

        record = KnowledgeRecord(
            record_id=f"research-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            text=text[:2000],
            source="mc-research",
            domain=domain,
            confidence=0.8,
            stage="canonical",
            kind="fact",
            tags={"category": "fact", "scope": scope},
            metadata={"source": "mc-research", "question": question[:500], "repo_path": repo_path},
            created_at=datetime.now(timezone.utc),
            valid_from=datetime.now(timezone.utc),
        )
        adapter.upsert_record(record)
        adapter.replace_chunks(record.record_id, [(text[:2000], vector, 0)])
        logging.info(f"  Distilled research to context-fabrica ({scope})")
    except Exception as e:
        logging.warning(f"  Failed to distill research: {e}")


def _check_research_results(state: dict) -> None:
    """Check for completed research and post results to Linear."""
    researching = state.get("researching", {})
    if not researching:
        return

    completed: List[str] = []
    for question_id, meta in list(researching.items()):
        output_file = RESEARCH_DIR / f"{question_id}.md"

        if output_file.exists():
            findings = output_file.read_text().strip()
            if not findings:
                logging.warning(f"  Empty research output for {question_id}")
                completed.append(question_id)
                continue

            issue_id = meta["issue_id"]
            comment_id = meta["comment_id"]

            reply_body = f"{BOT_REPLY_PREFIX} (research):\n\n{findings}"
            linear_api_key = os.environ.get("LINEAR_API_KEY", "")
            if linear_api_key:
                mutation = """
                mutation AddComment($issueId: String!, $body: String!, $parentId: String) {
                  commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success }
                }
                """
                try:
                    variables: Dict[str, Any] = {
                        "issueId": issue_id,
                        "body": reply_body[:10000],
                    }
                    if comment_id:
                        variables["parentId"] = comment_id
                    linear_query(mutation, variables)
                    logging.info(f"  Posted research findings for {question_id}")
                except Exception as e:
                    logging.error(f"  Failed to post research: {e}")

            _distill_research(
                meta.get("question", ""), findings, meta.get("repo_path", ""),
            )
            completed.append(question_id)
            continue

        # Check for failure
        log_file = SWARM_DIR / "logs" / f"research-{question_id}.log"
        if log_file.exists():
            try:
                log_text = log_file.read_text()
            except OSError:
                log_text = ""
            if "Research Agent failed" in log_text:
                logging.warning(f"  Research agent failed for {question_id}")
                completed.append(question_id)
                continue

        # Timeout after 15 minutes
        started = meta.get("started_at", "")
        if started:
            try:
                start_dt = datetime.fromisoformat(started)
                elapsed = (datetime.now(timezone.utc) - start_dt).total_seconds()
                if elapsed > 900:
                    logging.warning(
                        f"  Research timed out for {question_id} ({elapsed:.0f}s)"
                    )
                    completed.append(question_id)
            except (ValueError, TypeError):
                pass

    # Clean up completed research
    for qid in completed:
        researching.pop(qid, None)
        for suffix in [".md", ".meta.json"]:
            f = RESEARCH_DIR / f"{qid}{suffix}"
            if f.exists():
                try:
                    f.unlink()
                except OSError:
                    pass
        prompt_f = SWARM_DIR / "prompts" / f"research-{qid}.md"
        if prompt_f.exists():
            try:
                prompt_f.unlink()
            except OSError:
                pass

    state["researching"] = researching


def _gather_librarian_context(question: str) -> str:
    """Gather relevant librarian indexes and LanceDB knowledge for a question."""
    context_parts = []
    matched_repos: List[tuple] = []

    manifest_file = LIBRARIAN_DIR / "MANIFEST.md"
    if manifest_file.exists():
        context_parts.append(f"## Available Repos\n{manifest_file.read_text()[:5000]}")

    import re
    repo_patterns = re.findall(r'(?:in|from|for|repo[:\s]+)[\s`]*([a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)?)', question)
    for pattern in repo_patterns[:3]:
        repo_name = pattern.split("/")[-1]
        for idx_file in LIBRARIAN_DIR.glob(f"indexes/*/{repo_name}.md"):
            content = idx_file.read_text()[:8000]
            context_parts.append(f"## Repo Index: {idx_file.stem}\n{content}")
            matched_repos.append((idx_file.parent.name, repo_name))

    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if api_key:
        try:
            from context_fabrica.storage import PostgresPgvectorAdapter

            embed_payload = json.dumps({
                "model": "models/gemini-embedding-001",
                "content": {"parts": [{"text": question}]},
            }).encode()
            embed_req = urllib.request.Request(
                f"{EMBEDDING_URL}?key={api_key}",
                data=embed_payload, headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(embed_req, timeout=15) as resp:
                vector = json.loads(resp.read())["embedding"]["values"]

            adapter = PostgresPgvectorAdapter.from_dsn(CONTEXT_FABRICA_DSN, embedding_dimensions=3072)
            results = adapter.search_chunks(vector, top_k=10)

            if results:
                knowledge_lines = [
                    f"- {r.text}"
                    for r in results[:8] if r.text
                ]
                if knowledge_lines:
                    context_parts.append("## Past Knowledge\n" + "\n".join(knowledge_lines))
        except Exception as e:
            logging.warning(f"  context-fabrica recall failed: {e}")

    return "\n\n---\n\n".join(context_parts)


def answer_question(issue_id: str, comment: dict, issue_title: str,
                    state: dict) -> bool:
    """Two-tier answer: simple → Gemini Pro inline, complex → spawned research agent."""
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        logging.warning("  No Gemini API key — cannot answer mention-tagged question")
        return False

    question = comment.get("body", "")
    author = comment.get("user", {}).get("name", "someone")
    comment_id = comment.get("id", "")
    thread_parent_id = _resolve_thread_parent(comment) or ""
    logging.info(f"  Answering {LINEAR_MENTION_TAG} question from {author}: {question[:80]}...")

    complexity = _classify_question(question, api_key)
    logging.info(f"  Question classified as: {complexity}")

    if complexity == "research":
        repo_path = _find_repo_path(question) or _find_repo_path(issue_title)
        if repo_path:
            qid = comment_id[:12] if comment_id else datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            _post_placeholder(issue_id, thread_parent_id)
            if _spawn_research(qid, question, issue_title, author,
                               repo_path, issue_id, thread_parent_id):
                if "researching" not in state:
                    state["researching"] = {}
                state["researching"][qid] = {
                    "issue_id": issue_id,
                    "comment_id": thread_parent_id,
                    "question": question[:1000],
                    "repo_path": str(repo_path),
                    "started_at": datetime.now(timezone.utc).isoformat(),
                }
                return True
        logging.info("  No repo found for research — falling back to simple answer")

    context = _gather_librarian_context(question)

    prompt = f"""You are {LINEAR_BOT_NAME}, an AI assistant that helps engineers understand codebases.
A team member asked this question in a Linear ticket titled "{issue_title}":

**Question from {author}:**
{question}

**Available context from our codebase indexes and knowledge base:**
{context[:12000]}

Answer the question concisely and specifically. Reference actual files, directories, or code patterns from the context when possible. If you don't have enough information to answer fully, say what you DO know and suggest where to look.

Keep the answer under 500 words. Use markdown formatting."""

    answer = _call_gemini(prompt, api_key, model=GEMINI_PRO)
    if not answer:
        answer = _call_gemini(prompt, api_key)
    if not answer:
        return False

    reply_body = f"{BOT_REPLY_PREFIX}:\n\n{answer}"

    linear_api_key = os.environ.get("LINEAR_API_KEY", "")
    if not linear_api_key:
        return False

    mutation = """
    mutation AddComment($issueId: String!, $body: String!, $parentId: String) {
      commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success }
    }
    """
    try:
        variables: Dict[str, Any] = {"issueId": issue_id, "body": reply_body}
        if thread_parent_id:
            variables["parentId"] = thread_parent_id
        linear_query(mutation, variables)
        logging.info(f"  Posted mention-tagged answer to Linear issue {issue_id[:8]}")
        return True
    except Exception as e:
        logging.error(f"  Failed to post mention-tagged answer: {e}")
        return False


def fetch_issue_comments(issue_id: str) -> List[dict]:
    query = """
    query IssueComments($id: String!) {
      issue(id: $id) {
        comments(first: 50) {
          nodes {
            id
            body
            createdAt
            user { name }
            parent { id }
          }
        }
      }
    }
    """
    try:
        data = linear_query(query, {"id": issue_id})
        return data.get("issue", {}).get("comments", {}).get("nodes", [])
    except Exception as e:
        logging.warning(f"  Failed to fetch comments for {issue_id[:8]}: {e}")
        return []


def _fetch_triage_state(mc_task_id: str) -> Optional[dict]:
    try:
        return mc_request("GET", f"/api/tasks/{mc_task_id}/triage-state")
    except Exception as e:
        logging.warning(f"  Failed to fetch triage state for {mc_task_id[:8]}: {e}")
        return None


def _add_comment_to_triage(mc_task_id: str, triage_state: dict, comment: dict) -> bool:
    author = comment.get("user", {}).get("name", "Unknown")
    body = comment.get("body", "")
    comment_id = comment["id"]
    created_at = comment.get("createdAt", datetime.now(timezone.utc).isoformat())

    context_comments = triage_state.get("context_comments", [])

    existing_ids = {c.get("linear_comment_id") for c in context_comments}
    if comment_id in existing_ids:
        return False

    context_comments.append({
        "id": f"lc-{comment_id[:8]}",
        "author": author,
        "body": body,
        "source": "linear",
        "linear_comment_id": comment_id,
        "created_at": created_at,
    })

    triage_state["context_comments"] = context_comments
    triage_state["updated_at"] = datetime.now(timezone.utc).isoformat()

    try:
        mc_request("PUT", f"/api/tasks/{mc_task_id}/triage-state", triage_state)
        return True
    except Exception as e:
        logging.warning(f"  Failed to update triage state for {mc_task_id[:8]}: {e}")
        return False


def _try_auto_answer_triage(mc_task_id: str, triage_state: dict, comment: dict) -> int:
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not api_key:
        return 0

    questions = triage_state.get("questions", [])
    unanswered = [q for q in questions if not q.get("answer")]
    if not unanswered:
        return 0

    body = comment.get("body", "").strip()
    if not body:
        return 0

    questions_block = ""
    for q in unanswered:
        opts = ""
        if q.get("options"):
            opts = " Options: " + ", ".join(q["options"])
        questions_block += f'- id="{q["id"]}" question="{q["question"]}"{opts}\n'

    prompt = (
        "A developer replied on a Linear ticket. The reply may contain answers "
        "to one or more triage questions that were posted earlier.\n\n"
        f"## Developer Reply\n{body}\n\n"
        f"## Unanswered Triage Questions\n{questions_block}\n"
        "## Task\n"
        "Match the developer's reply to the triage questions. For each question "
        "that the reply answers (even partially), extract the answer.\n\n"
        "Return ONLY a JSON array. Each element: {\"id\": \"<question_id>\", \"answer\": \"<extracted_answer>\"}\n"
        "If the reply doesn't answer a question, omit it. If it answers none, return [].\n"
        "Return raw JSON only — no markdown fencing, no explanation."
    )

    matches = None
    for attempt in range(2):
        result = _call_gemini(prompt, api_key)
        if not result:
            continue

        result = result.strip()
        if result.startswith("```"):
            result = result.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        try:
            parsed = json.loads(result)
            if isinstance(parsed, list):
                matches = parsed
                break
        except (json.JSONDecodeError, ValueError):
            logging.warning(f"  Gemini auto-answer attempt {attempt + 1} returned unparseable JSON: {result[:200]}")

    if not matches:
        return 0

    answered = 0
    for match in matches:
        qid = match.get("id", "")
        answer = match.get("answer", "").strip()
        if not qid or not answer:
            continue

        try:
            mc_request("PATCH", f"/api/tasks/{mc_task_id}/triage-state", {
                "questionId": qid,
                "answer": answer,
            })
            answered += 1
            logging.info(f"  Auto-answered triage question {qid} for {mc_task_id[:8]}")
        except Exception as e:
            logging.warning(f"  Failed to auto-answer {qid}: {e}")

    return answered


def _post_triage_feedback_to_linear(issue_id: str, triage_state: dict, answered_count: int):
    api_key = os.environ.get("LINEAR_API_KEY", "")
    if not api_key:
        return

    questions = triage_state.get("questions", [])
    remaining = [q for q in questions if not q.get("answer")]
    total = len(questions)
    done = total - len(remaining)

    if not remaining:
        body = (
            f"{BOT_REPLY_PREFIX}: ✅ All {total} triage questions answered — "
            "moving to execution pipeline now.\n\n"
            "I'll analyze your answers and either start working or follow up "
            "if anything needs further clarification."
        )
    else:
        lines = [
            f"{BOT_REPLY_PREFIX}: Got it — answered {done}/{total} questions "
            f"from your reply.\n\n"
            f"**Still need clarification on {len(remaining)}:**\n"
        ]
        for i, q in enumerate(remaining, 1):
            lines.append(f"{i}. **{q['question']}**")
            if q.get("options"):
                for j, opt in enumerate(q["options"]):
                    label = chr(ord('a') + j)
                    lines.append(f"   {label}) {opt}")
            lines.append("")
        lines.append("_Reply with your answers (e.g. \"1a, 2b\" or type your own)._")
        body = "\n".join(lines)

    mutation = """
    mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }
    """
    try:
        linear_query(mutation, {"issueId": issue_id, "body": body})
        logging.info(f"  Posted triage feedback to Linear ({done}/{total} answered)")
    except Exception as e:
        logging.warning(f"  Failed to post triage feedback to Linear: {e}")


def _notify_triage_complete(mc_task_id: str, triage_state: dict, linear_issue_id: Optional[str] = None):
    questions = triage_state.get("questions", [])
    remaining = [q for q in questions if not q.get("answer")]
    if remaining:
        return

    logging.info(f"  All triage questions answered for {mc_task_id[:8]} — bridge will pick up on next cycle")

    try:
        mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
            "activity_type": "updated",
            "message": "All triage questions answered — ready for bridge to proceed.",
        })
    except Exception as e:
        logging.warning(f"  Failed to log triage completion activity for {mc_task_id[:8]}: {e}")

    if linear_issue_id:
        api_key = os.environ.get("LINEAR_API_KEY", "")
        if api_key:
            body = f"{BOT_REPLY_PREFIX}: ✅ All triage questions answered — proceeding with task."
            try:
                linear_query(
                    'mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }',
                    {"id": linear_issue_id, "body": body}
                )
            except Exception as e:
                logging.warning(f"  Failed to post completion to Linear: {e}")


def _hash_description(description: str) -> str:
    import hashlib
    return hashlib.sha256((description or "").strip().encode()).hexdigest()[:16]


def _check_description_changed(issue: dict, mc_task: dict, state: dict) -> bool:
    issue_id = issue["id"]
    mc_task_id = mc_task["id"]
    current_desc = issue.get("description", "") or ""
    current_hash = _hash_description(current_desc)

    synced_info = state.get("synced_issues", {}).get(issue_id, {})
    stored_hash = synced_info.get("description_hash", "")

    if not stored_hash:
        synced_info["description_hash"] = current_hash
        return False

    if current_hash == stored_hash:
        return False

    logging.info(f"  Description changed for {issue['identifier']} — resetting triage")

    synced_info["description_hash"] = current_hash
    state.get("synced_comments", {}).pop(issue_id, None)
    state.get("answered_comments", {}).pop(issue_id, None)

    try:
        mc_request("PUT", f"/api/tasks/{mc_task_id}/triage-state", None)
    except Exception:
        pass

    try:
        mc_request("PATCH", f"/api/tasks/{mc_task_id}", {
            "status": "inbox",
            "description": "\n".join([
                current_desc,
                f"\n---\n*Synced from Linear: [{issue['identifier']}]({issue['url']})*",
            ]),
        })
        mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
            "activity_type": "status_changed",
            "message": "Linear description changed — triage reset. Moved to inbox for re-triage.",
        })
    except Exception as e:
        logging.warning(f"  Failed to reset task for description change: {e}")

    api_key = os.environ.get("LINEAR_API_KEY", "")
    if api_key:
        try:
            linear_query(
                """mutation AddComment($issueId: String!, $body: String!) {
                    commentCreate(input: { issueId: $issueId, body: $body }) { success }
                }""",
                {"issueId": issue_id, "body": (
                    f"{BOT_REPLY_PREFIX}: Description updated — "
                    "resetting triage and re-evaluating. I'll post new questions shortly if needed."
                )},
            )
        except Exception:
            pass

    return True


def _clean_stale_comment_ids(issue_id: str, live_comment_ids: set, state: dict) -> int:
    synced = set(state.get("synced_comments", {}).get(issue_id, []))
    answered = set(state.get("answered_comments", {}).get(issue_id, []))

    stale_synced = synced - live_comment_ids
    stale_answered = answered - live_comment_ids

    if not stale_synced and not stale_answered:
        return 0

    cleaned = len(stale_synced) + len(stale_answered)

    if issue_id in state.get("synced_comments", {}):
        state["synced_comments"][issue_id] = list(synced - stale_synced)
    if issue_id in state.get("answered_comments", {}):
        state["answered_comments"][issue_id] = list(answered - stale_answered)

    logging.info(f"  Cleaned {cleaned} stale comment ID(s) for {issue_id[:8]} (deleted from Linear)")
    return cleaned


def sync_comments_to_mc(issue: dict, mc_task: dict, state: dict) -> int:
    mc_task_id = mc_task["id"]
    issue_id = issue["id"]
    issue_title = issue.get("title", "")

    synced_comment_ids = set(state.get("synced_comments", {}).get(issue_id, []))
    answered_comment_ids = set(state.get("answered_comments", {}).get(issue_id, []))

    comments = fetch_issue_comments(issue_id)
    synced = 0
    new_auto_answered = 0

    live_comment_ids = {c["id"] for c in comments}
    _clean_stale_comment_ids(issue_id, live_comment_ids, state)

    triage_state = _fetch_triage_state(mc_task_id)

    question_comment_ids = {}
    if triage_state and isinstance(triage_state, dict):
        for q in triage_state.get("questions", []):
            lcid = q.get("linear_comment_id")
            if lcid:
                question_comment_ids[lcid] = q

    for comment in comments:
        comment_id = comment["id"]
        body = comment.get("body", "")

        if _is_bot_comment(body) or comment_id in question_comment_ids:
            synced_comment_ids.add(comment_id)
            continue

        parent_id = comment.get("parent", {}).get("id") if comment.get("parent") else None
        if parent_id and parent_id in question_comment_ids:
            q = question_comment_ids[parent_id]
            if not q.get("answer"):
                author = comment.get("user", {}).get("name", "Unknown")
                q_label = q.get("id", "?")
                logging.info(f"  Thread reply from {author} on question {q_label} — auto-answering")
                try:
                    mc_request("PATCH", f"/api/tasks/{mc_task_id}/triage-state", {
                        "questionId": q.get("id"),
                        "answer": body.strip(),
                    })
                    new_auto_answered += 1
                    triage_state = _fetch_triage_state(mc_task_id)
                    if triage_state:
                        question_comment_ids = {}
                        for qq in triage_state.get("questions", []):
                            lcid = qq.get("linear_comment_id")
                            if lcid:
                                question_comment_ids[lcid] = qq
                except Exception as e:
                    logging.warning(f"  Failed to apply thread answer for {q_label}: {e}")
                if comment_id not in synced_comment_ids:
                    mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
                        "activity_type": "linear_comment",
                        "message": f"**{author}** answered {q_label} on Linear:\n\n{body}",
                    })
                    synced += 1
            synced_comment_ids.add(comment_id)
            continue

        if comment_id not in answered_comment_ids and _has_mention_tag(body):
            answer_question(issue_id, comment, issue_title, state)
            answered_comment_ids.add(comment_id)
            synced_comment_ids.add(comment_id)
            continue

        if comment_id in synced_comment_ids:
            if mc_task.get("status") == "planning" and triage_state and isinstance(triage_state, dict):
                unanswered = [q for q in triage_state.get("questions", []) if not q.get("answer")]
                if unanswered:
                    retry_answered = _try_auto_answer_triage(mc_task_id, triage_state, comment)
                    if retry_answered:
                        logging.info(f"  Retried auto-answer: matched {retry_answered} question(s) from {comment.get('user',{}).get('name','?')}")
                        triage_state = _fetch_triage_state(mc_task_id)
            continue

        author = comment.get("user", {}).get("name", "Unknown")
        message = f"**{author}** replied on Linear:\n\n{body}"

        if triage_state and isinstance(triage_state, dict) and "questions" in triage_state:
            if _add_comment_to_triage(mc_task_id, triage_state, comment):
                logging.info(f"  Added comment from {author} to triage context for {mc_task_id[:8]}")
            auto_answered = _try_auto_answer_triage(mc_task_id, triage_state, comment)
            if auto_answered:
                new_auto_answered += auto_answered
                logging.info(f"  Auto-answered {auto_answered} triage question(s) from {author}'s reply")
                triage_state = _fetch_triage_state(mc_task_id)

        try:
            mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
                "activity_type": "linear_comment",
                "message": message,
            })
            synced += 1
            logging.info(f"  Synced comment from {author} to MC task {mc_task_id[:8]}")
        except Exception as e:
            logging.warning(f"  Failed to sync comment to MC: {e}")
            continue

        synced_comment_ids.add(comment_id)

    if new_auto_answered and triage_state:
        has_threaded_questions = any(q.get("linear_comment_id") for q in triage_state.get("questions", []))
        if not has_threaded_questions:
            _post_triage_feedback_to_linear(issue_id, triage_state, new_auto_answered)
        _notify_triage_complete(mc_task_id, triage_state, issue_id if not has_threaded_questions else None)

    if "synced_comments" not in state:
        state["synced_comments"] = {}
    state["synced_comments"][issue_id] = list(synced_comment_ids)

    if "answered_comments" not in state:
        state["answered_comments"] = {}
    state["answered_comments"][issue_id] = list(answered_comment_ids)

    return synced


def sync():
    setup_logging()
    load_env()
    logging.info("=== Linear sync started ===")

    if not verify_workspace():
        sys.exit(1)

    state = load_state()
    _check_research_results(state)

    issues = fetch_labeled_issues()
    logging.info(f"Found {len(issues)} labeled issues in Linear (implementation + investigation)")

    existing_tasks = get_existing_mc_tasks()
    logging.info(f"Found {len(existing_tasks)} existing Linear-sourced MC tasks")

    created = 0
    skipped = 0
    comments_synced = 0

    for issue in issues:
        issue_id = issue["id"]

        if is_terminal_state(issue):
            if issue_id in existing_tasks:
                mc_task = existing_tasks[issue_id]
                if mc_task.get("status") != "done":
                    mc_task_id = mc_task["id"]
                    state_name = issue.get("state", {}).get("name", "Done")
                    logging.info(f"  Linear {issue['identifier']} is {state_name} — marking MC task {mc_task_id[:8]} done")
                    mc_request("PATCH", f"/api/tasks/{mc_task_id}", {"status": "done"})
                    mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
                        "activity_type": "status_changed",
                        "message": f"Linear ticket marked {state_name} — syncing to done",
                    })
                    for child in [t for t in existing_tasks.values() if t.get("parent_task_id") == mc_task_id and t.get("status") != "done"]:
                        mc_request("PATCH", f"/api/tasks/{child['id']}", {"status": "done"})
                        logging.info(f"    Child {child['id'][:8]} also marked done")
            skipped += 1
            continue

        if issue_id in existing_tasks:
            mc_task = existing_tasks[issue_id]

            if is_on_hold_state(issue) and mc_task.get("status") != "on_hold":
                mc_priority = mc_task.get("priority", "normal")
                if mc_priority in ("urgent", "high"):
                    logging.info(f"  Linear {issue['identifier']} is Backlog but MC priority is {mc_priority} — skipping on_hold")
                else:
                    mc_task_id = mc_task["id"]
                    state_name = issue.get("state", {}).get("name", "On Hold")
                    logging.info(f"  Linear {issue['identifier']} is {state_name} — setting MC task {mc_task_id[:8]} on_hold")
                    try:
                        mc_request("PATCH", f"/api/tasks/{mc_task_id}", {"status": "on_hold"})
                        mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
                            "activity_type": "status_changed",
                            "message": f"Linear ticket moved to {state_name} — setting on hold",
                        })
                        for child in [t for t in existing_tasks.values() if t.get("parent_task_id") == mc_task_id and t.get("status") not in ("done", "on_hold")]:
                            mc_request("PATCH", f"/api/tasks/{child['id']}", {"status": "on_hold"})
                            logging.info(f"    Child {child['id'][:8]} also set on_hold")
                    except Exception as e:
                        logging.warning(f"  Failed to set on_hold for {mc_task_id[:8]}: {e}")

            elif not is_on_hold_state(issue) and mc_task.get("status") == "on_hold":
                mc_task_id = mc_task["id"]
                state_name = issue.get("state", {}).get("name", "?")
                logging.info(f"  Linear {issue['identifier']} moved to {state_name} — restoring MC task {mc_task_id[:8]} to inbox")
                try:
                    mc_request("PATCH", f"/api/tasks/{mc_task_id}", {"status": "inbox"})
                    mc_request("POST", f"/api/tasks/{mc_task_id}/activities", {
                        "activity_type": "status_changed",
                        "message": f"Linear ticket moved to {state_name} — restored from on hold",
                    })
                except Exception as e:
                    logging.warning(f"  Failed to restore {mc_task_id[:8]} from on_hold: {e}")

            if _check_description_changed(issue, mc_task, state):
                skipped += 1
                continue
            sync_status_back(mc_task, issue_id)
            comments_synced += sync_comments_to_mc(issue, mc_task, state)
            skipped += 1
            continue

        task = create_mc_task(issue)
        if task:
            created += 1
            state["synced_issues"][issue_id] = {
                "mc_task_id": task.get("id"),
                "identifier": issue["identifier"],
                "synced_at": datetime.now(timezone.utc).isoformat(),
                "description_hash": _hash_description(issue.get("description", "")),
            }

    state["last_sync"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    logging.info(f"=== Sync complete: {created} created, {skipped} skipped, {comments_synced} comments synced ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Linear → Mission Control sync")
    parser.add_argument("--dry-run", action="store_true", help="Show what would sync without creating tasks")
    args = parser.parse_args()

    if args.dry_run:
        setup_logging()
        load_env()
        if not verify_workspace():
            sys.exit(1)
        issues = fetch_labeled_issues()
        existing = get_existing_mc_tasks()
        for issue in issues:
            status = "EXISTS" if issue["id"] in existing else "NEW"
            terminal = " (TERMINAL)" if is_terminal_state(issue) else ""
            print(f"  [{status}] {issue['identifier']}: {issue['title']}{terminal}")
        print(f"\nTotal: {len(issues)} issues, {len(existing)} already synced")
    else:
        sync()
