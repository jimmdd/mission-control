#!/Users/mm/.openclaw/venv-3.12/bin/python3
"""CLI for injecting, listing, and deleting knowledge entries in Context Fabrica.
Called by Mission Control API and usable directly from CLI.

Uses Context Fabrica (PostgreSQL + pgvector) as the single source of truth.
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import List
from uuid import uuid4

from context_fabrica.models import KnowledgeRecord
from context_fabrica.storage import PostgresPgvectorAdapter

EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIM = 3072
EMBEDDING_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent"

CONTEXT_FABRICA_DSN = os.environ.get("CONTEXT_FABRICA_DSN", "postgresql://mm@localhost/context_fabrica")


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


def embed_text(text: str, api_key: str) -> List[float]:
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

    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["embedding"]["values"]


def _make_adapter() -> PostgresPgvectorAdapter:
    return PostgresPgvectorAdapter.from_dsn(CONTEXT_FABRICA_DSN, embedding_dimensions=EMBEDDING_DIM)


def build_scope(project: str, repo: str = "") -> str:
    proj = project if project and project != "global" else ""
    r = repo if repo and repo != "global" else ""
    if r and proj:
        return f"repo:{proj}/{r}"
    if proj:
        return f"project:{proj}"
    return "global"


def scope_to_domain(scope: str) -> str:
    """Extract domain from scope string for Context Fabrica."""
    if scope.startswith("repo:"):
        parts = scope[5:].split("/", 1)
        return parts[0] if parts else "global"
    if scope.startswith("project:"):
        return scope[8:]
    return "global"


def cmd_inject(args):
    api_key = get_gemini_key()
    if not api_key:
        print(json.dumps({"error": "No Gemini API key"}))
        sys.exit(1)

    scope = args.scope or build_scope(args.project or "", args.repo or "")
    importance = max(1, min(5, args.importance))
    category = args.category if args.category in ("fact", "decision", "entity", "other", "preference", "developer_note") else "fact"
    source = args.source or "human"
    domain = scope_to_domain(scope)

    vector = embed_text(args.text, api_key)

    record_id = str(uuid4())
    now = datetime.now(timezone.utc)

    # Map importance 1-5 to confidence 0.0-1.0
    confidence = importance / 5.0

    # Human-injected knowledge starts as canonical (already reviewed)
    stage = "canonical" if source == "human" else "staged"

    kind = "workflow" if category == "skill" else "fact"

    record = KnowledgeRecord(
        record_id=record_id,
        text=args.text,
        source=source,
        domain=domain,
        confidence=confidence,
        stage=stage,
        kind=kind,
        tags={"category": category, "scope": scope},
        metadata={
            "source": source,
            "injected_via": args.via or "cli",
            "original_scope": scope,
        },
        created_at=now,
        valid_from=now,
        reviewed_at=now if stage == "canonical" else None,
    )

    adapter = _make_adapter()
    adapter.upsert_record(record)
    adapter.replace_chunks(record_id, [(args.text, vector, 0)])

    result = {
        "id": record_id,
        "text": args.text,
        "scope": scope,
        "category": category,
        "importance": importance,
        "source": source,
    }
    print(json.dumps(result))


def cmd_list(args):
    adapter = _make_adapter()
    has_filter = args.scope or args.project or args.repo
    scope = args.scope or build_scope(args.project or "", args.repo or "") if has_filter else None
    domain = scope_to_domain(scope) if scope else None

    try:
        records = adapter.list_records(domain=domain, limit=args.limit or 50)
    except Exception:
        records = []

    entries = []
    for rec in records:
        tags = rec.tags if isinstance(rec.tags, dict) else {}
        meta = rec.metadata if isinstance(rec.metadata, dict) else {}
        rec_scope = tags.get("scope", meta.get("original_scope", ""))

        # If filtering by specific scope, skip non-matching
        if scope and rec_scope and scope != "global":
            if scope.startswith("project:"):
                proj = scope.split(":", 1)[1]
                if not (rec_scope == scope or rec_scope.startswith(f"repo:{proj}/")):
                    continue
            elif rec_scope != scope:
                continue

        entries.append({
            "id": rec.record_id,
            "text": rec.text or "",
            "category": tags.get("category", rec.kind),
            "scope": rec_scope,
            "importance": round(rec.confidence * 5),
            "timestamp": int(rec.created_at.timestamp() * 1000) if rec.created_at else 0,
            "source": meta.get("source", "auto"),
        })

    entries.sort(key=lambda e: (-e["importance"], -e["timestamp"]))
    print(json.dumps({"entries": entries, "count": len(entries), "scope": scope or "all"}))


def cmd_delete(args):
    adapter = _make_adapter()
    try:
        deleted = adapter.delete_record(args.id)
        if not deleted:
            print(json.dumps({"error": "Record not found"}))
            sys.exit(1)
        print(json.dumps({"deleted": args.id}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Knowledge management for Mission Control")
    sub = parser.add_subparsers(dest="command", required=True)

    p_inject = sub.add_parser("inject")
    p_inject.add_argument("--text", required=True)
    p_inject.add_argument("--project", default="")
    p_inject.add_argument("--repo", default="")
    p_inject.add_argument("--scope", default="")
    p_inject.add_argument("--importance", type=int, default=5)
    p_inject.add_argument("--category", default="fact")
    p_inject.add_argument("--source", default="human")
    p_inject.add_argument("--via", default="cli")
    p_inject.set_defaults(func=cmd_inject)

    p_list = sub.add_parser("list")
    p_list.add_argument("--project", default="")
    p_list.add_argument("--repo", default="")
    p_list.add_argument("--scope", default="")
    p_list.add_argument("--limit", type=int, default=50)
    p_list.set_defaults(func=cmd_list)

    p_delete = sub.add_parser("delete")
    p_delete.add_argument("--id", required=True)
    p_delete.set_defaults(func=cmd_delete)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
