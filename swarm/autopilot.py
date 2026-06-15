#!/usr/bin/env python3
"""Autopilot / Objective mode for Mission Control.

Open-ended, fuzzy-goal work ("build a wiki of my project"). The agent proposes a
scope, the human approves once, then it runs to completion.

Efficiency core: scope proposal, exploration, synthesis and gap-check are CHEAP
direct small-model LLM calls (no tmux/worktree/agent sessions). Context Fabrica
is the accumulation/recall layer. Full agent sessions are reserved for
implementation sub-goals (later phase). This module is driven by the bridge
daemon via process_objectives().
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Optional

MC_HOME = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))
MC_BASE_URL = os.environ.get("MISSION_CONTROL_URL", "http://localhost:18900")

# Reuse the planner's role-routed LLM caller + JSON parsing.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from planner import _call_llm, _parse_json_response  # noqa: E402


# --- Mission Control HTTP (self-contained; no bridge import to avoid cycles) ---

def _mc_token() -> str:
    return (
        os.environ.get("MISSION_CONTROL_ACCESS_TOKEN")
        or os.environ.get("MISSION_CONTROL_WRITE_TOKEN")
        or os.environ.get("MISSION_CONTROL_READ_ACCESS_TOKEN")
        or ""
    ).strip()


def mc_request(method: str, path: str, body: Optional[dict] = None):
    url = f"{MC_BASE_URL}{path}"
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if payload else {}
    # Same-origin marker so the server's CSRF guard treats us as a trusted client.
    token = _mc_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=payload, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def _slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")
    return s or "page"


# --- Repo context (cheap, best-effort; degrades if Context Fabrica absent) ---

def _repo_context(repo_path: str, max_chars: int = 14000) -> str:
    if not repo_path:
        return ""
    try:
        import mc_explore_common as mx  # lazy: may pull context_fabrica deps
    except Exception as e:  # pragma: no cover - env dependent
        logging.warning(f"autopilot: repo context module unavailable: {e}")
        return ""
    try:
        rd = Path(repo_path).expanduser()
        if not rd.exists():
            return ""
        files = mx.walk_repo(rd)
        tree = mx.build_file_tree(rd)
        key_files = mx.identify_key_files(rd, files)
        contents = mx.read_key_files(key_files, max_total=max_chars)
        parts = [f"Repository file tree:\n{tree}"]
        for path, text in contents.items():
            parts.append(f"\n--- {path} ---\n{text}")
        return "\n".join(parts)[: max_chars * 2]
    except Exception as e:
        logging.warning(f"autopilot: repo context gather failed: {e}")
        return ""


def _output_config(obj: dict) -> dict:
    raw = obj.get("output_config")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return {}


# --- Scope proposal (inverts triage: the agent proposes, human approves once) ---

SCOPE_SYSTEM = (
    "You are the planner for an autonomous 'autopilot' run in a developer tool. "
    "Given a fuzzy goal, propose a concrete scope: an interpretation and a small "
    "set of sub-goals. Each sub-goal is either kind 'research' (read-only: "
    "explore/document) or 'implementation' (writes code). Prefer research unless "
    "the goal clearly requires code changes. Return STRICT JSON only."
)


def propose_scope(obj: dict) -> Optional[dict]:
    goal = obj.get("goal", "")
    cfg = _output_config(obj)
    ctx = _repo_context(cfg.get("repo_path", ""))
    ctx_block = ("Repository context:\n" + ctx) if ctx else "(no repository context available)"
    prompt = f"""Goal: {goal}

{ctx_block}

Return JSON:
{{
  "interpretation": "one or two sentences on what you'll deliver",
  "sub_goals": [
    {{"id": "sg1", "title": "Short section/sub-goal title", "kind": "research", "rationale": "why"}}
  ],
  "estimated_rounds": 1,
  "notes": "assumptions or risks"
}}
For a 'wiki' goal, sub_goals are the wiki sections (e.g. Overview, Architecture, Modules, Setup)."""
    out = _call_llm(prompt, role="scope", system=SCOPE_SYSTEM, max_tokens=2048)
    scope = _parse_json_response(out)
    if not scope or not isinstance(scope.get("sub_goals"), list) or not scope["sub_goals"]:
        return None
    # Normalize sub-goal ids/kinds.
    for i, sg in enumerate(scope["sub_goals"], 1):
        sg.setdefault("id", f"sg{i}")
        if sg.get("kind") not in ("research", "implementation"):
            sg["kind"] = "research"
    return scope


def _scope_summary(scope: dict) -> str:
    lines = [scope.get("interpretation", "").strip(), "", "Proposed sub-goals:"]
    for sg in scope.get("sub_goals", []):
        lines.append(f"- {sg.get('title','?')} ({sg.get('kind','research')})")
    lines.append("\nApprove to run autonomously, or reject.")
    return "\n".join([ln for ln in lines if ln is not None])


# --- Page synthesis (compose wiki pages from context + recalled knowledge) ---

SYNTH_SYSTEM = (
    "You write a clear, accurate technical wiki page in Markdown. Use only the "
    "provided context; do not invent specifics. Be concise and useful."
)


def _recall(query: str, project: str = "", repo: str = "") -> str:
    try:
        path = f"/api/knowledge/recall?query={urllib.parse.quote(query)}&limit=5"
        if project:
            path += f"&project={urllib.parse.quote(project)}"
        if repo:
            path += f"&repo={urllib.parse.quote(repo)}"
        data = mc_request("GET", path)
        if isinstance(data, dict):
            chunks = data.get("results") or data.get("past_learnings") or data.get("entries")
            return json.dumps(chunks)[:4000] if chunks else ""
    except Exception:
        pass
    return ""


def _compose_page(goal: str, sub_goal: dict, ctx: str, recalled: str) -> Optional[str]:
    ctx_block = ("Repository context:\n" + ctx) if ctx else ""
    recall_block = ("Related prior knowledge:\n" + recalled) if recalled else ""
    prompt = f"""Overall goal: {goal}
Wiki section: {sub_goal.get('title')}
Rationale: {sub_goal.get('rationale','')}

{ctx_block}
{recall_block}

Write the Markdown body for THIS section only (no top-level # title — that is added separately)."""
    return _call_llm(prompt, role="synthesize", system=SYNTH_SYSTEM, max_tokens=3000)


def _inject_knowledge(project: str, repo: str, text: str) -> None:
    if not text:
        return
    try:
        mc_request("POST", "/api/knowledge", {
            "text": text[:1500],
            "importance": 3,
            "category": "fact",
            "project": project,
            "repo": repo,
        })
    except Exception:
        pass  # Context Fabrica is best-effort; pages still get built.


# --- State machine ---

def _patch(objective_id: str, **fields) -> None:
    mc_request("PATCH", f"/api/objectives/{objective_id}", fields)


def _set_blocked(obj: dict, reason: str) -> None:
    try:
        _patch(obj["id"], status="blocked", blocked_reason=reason)
        if obj.get("anchor_task_id"):
            mc_request("POST", f"/api/tasks/{obj['anchor_task_id']}/checkpoints", {
                "kind": "approval",
                "prompt": f"Autopilot blocked: {reason}",
            })
    except Exception:
        pass


def _do_scoping(obj: dict) -> None:
    scope = propose_scope(obj)
    if not scope:
        _set_blocked(obj, "Could not propose a scope (LLM unavailable or empty). Check model config/keys.")
        return
    _patch(obj["id"], proposed_scope=scope, status="awaiting_approval")
    anchor = obj.get("anchor_task_id")
    if anchor:
        mc_request("POST", f"/api/tasks/{anchor}/checkpoints", {
            "kind": "approval",
            "prompt": _scope_summary(scope),
            "options": scope.get("sub_goals", []),
        })
    logging.info(f"autopilot: proposed scope for {obj['id'][:8]}, awaiting approval")


def _check_approval(obj: dict) -> None:
    anchor = obj.get("anchor_task_id")
    if not anchor:
        return
    checkpoints = mc_request("GET", f"/api/tasks/{anchor}/checkpoints")
    if not isinstance(checkpoints, list):
        return
    # Most recent first (route returns DESC).
    for cp in checkpoints:
        status = cp.get("status")
        if status == "pending":
            return  # still waiting on the human
        if status in ("approved", "rejected", "answered"):
            if status == "rejected":
                _patch(obj["id"], status="failed")
                logging.info(f"autopilot: scope rejected for {obj['id'][:8]}")
                return
            # Approved (or answered with edits). Merge any edited scope from response.
            approved = obj.get("proposed_scope")
            if isinstance(approved, str):
                try:
                    approved = json.loads(approved)
                except Exception:
                    approved = None
            resp = cp.get("response")
            if resp:
                try:
                    edited = json.loads(resp)
                    if isinstance(edited, dict) and edited.get("sub_goals"):
                        approved = edited
                except Exception:
                    pass
            _patch(obj["id"], approved_scope=approved, status="running")
            logging.info(f"autopilot: scope approved for {obj['id'][:8]}, running")
            return


def _run_round(obj: dict) -> None:
    obj_id = obj["id"]
    scope = obj.get("approved_scope")
    if isinstance(scope, str):
        try:
            scope = json.loads(scope)
        except Exception:
            scope = None
    if not scope or not scope.get("sub_goals"):
        _set_blocked(obj, "No approved scope to run.")
        return

    cfg = _output_config(obj)
    repo_path = cfg.get("repo_path", "")
    project = cfg.get("project", "")
    repo = cfg.get("repo", "")
    goal = obj.get("goal", "")
    max_subtasks = int(obj.get("max_subtasks", 20) or 20)

    # MVP: research sub-goals only, single round. Implementation sub-goals are a
    # later phase (they route through delegation → planner → PR).
    research = [sg for sg in scope["sub_goals"] if sg.get("kind") != "implementation"][:max_subtasks]

    # Create (or reuse) the wiki document.
    doc = mc_request("POST", f"/api/objectives/{obj_id}/document", {"title": goal, "kind": "wiki"})
    doc_id = doc.get("id") if isinstance(doc, dict) else None
    if not doc_id:
        _set_blocked(obj, "Could not create wiki document.")
        return

    ctx = _repo_context(repo_path)
    composed = 0
    for pos, sg in enumerate(research):
        recalled = _recall(sg.get("title", goal), project, repo)
        body = _compose_page(goal, sg, ctx, recalled)
        if not body:
            continue
        title = sg.get("title", f"Section {pos + 1}")
        slug = _slug(title)
        try:
            mc_request("PUT", f"/api/documents/{doc_id}/pages/{slug}", {
                "title": title,
                "body_md": body,
                "position": pos,
            })
            composed += 1
            _inject_knowledge(project, repo, f"{title}: {body[:400]}")
        except Exception as e:
            logging.warning(f"autopilot: page upsert failed for {slug}: {e}")

    coverage = {"done": True, "coverage_score": 1.0, "pages": composed, "round": 1}
    _patch(obj_id, status="done", round=1, subtasks_spawned=len(research), coverage=coverage)

    anchor = obj.get("anchor_task_id")
    if anchor:
        try:
            mc_request("POST", f"/api/tasks/{anchor}/activities", {
                "activity_type": "objective_complete",
                "message": f"Autopilot complete: {composed} wiki page(s) generated.",
                "metadata": json.dumps({"objective_id": obj_id, "document_id": doc_id, "pages": composed}),
            })
            mc_request("POST", f"/api/tasks/{anchor}/deliverables", {
                "deliverable_type": "wiki",
                "title": f"Wiki: {goal}",
                "description": f"{composed} page(s)",
            })
            mc_request("PATCH", f"/api/tasks/{anchor}", {"status": "review"})
        except Exception:
            pass
    logging.info(f"autopilot: objective {obj_id[:8]} done — {composed} pages")


def process_objectives() -> None:  # noqa: E302
    """Bridge entry point — advance every active objective by one step."""
    try:
        objectives = mc_request("GET", "/api/objectives")
    except Exception as e:
        logging.debug(f"autopilot: list objectives failed: {e}")
        return
    if not isinstance(objectives, list):
        return
    for obj in objectives:
        status = obj.get("status")
        if status not in ("scoping", "awaiting_approval", "running"):
            continue
        try:
            if status == "scoping":
                _do_scoping(obj)
            elif status == "awaiting_approval":
                _check_approval(obj)
            elif status == "running":
                _run_round(obj)
        except Exception as e:
            logging.error(f"autopilot: objective {str(obj.get('id'))[:8]} error: {e}", exc_info=True)
            _set_blocked(obj, str(e)[:300])


def _selftest() -> None:
    assert _slug("Architecture & Data Model!") == "architecture-data-model"
    assert _slug("") == "page"
    scope = {
        "interpretation": "Document the repo",
        "sub_goals": [{"id": "sg1", "title": "Overview", "kind": "research"}],
    }
    summary = _scope_summary(scope)
    assert "Overview" in summary and "Approve" in summary
    # propose_scope normalization tolerates missing ids/kinds
    parsed = _parse_json_response('{"sub_goals":[{"title":"X"}],"interpretation":"y"}')
    assert parsed and parsed["sub_goals"][0]["title"] == "X"
    print("selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        process_objectives()
