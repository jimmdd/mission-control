#!/usr/bin/env python3
"""CLI for injecting, listing, and deleting knowledge entries in LanceDB.
Called by Mission Control API and usable directly from CLI.

Shares the same LanceDB database as knowledge-distill.py and memory-lancedb-pro.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import List
from uuid import uuid4

import lancedb
import pyarrow as pa

LANCEDB_PATH = os.path.expanduser("~/.openclaw/memory/lancedb-pro")
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIM = 3072
EMBEDDING_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent"

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


def get_table():
    db = lancedb.connect(LANCEDB_PATH)
    try:
        return db.open_table("memories")
    except Exception:
        return db.create_table("memories", schema=MEMORIES_SCHEMA)


def build_scope(project: str, repo: str = "") -> str:
    # Treat "global" as empty — "global" is not a real project/repo
    proj = project if project and project != "global" else ""
    r = repo if repo and repo != "global" else ""
    if r and proj:
        return f"repo:{proj}/{r}"
    if proj:
        return f"project:{proj}"
    return "global"


def cmd_inject(args):
    api_key = get_gemini_key()
    if not api_key:
        print(json.dumps({"error": "No Gemini API key"}))
        sys.exit(1)

    scope = args.scope or build_scope(args.project or "", args.repo or "")
    importance = max(1, min(5, args.importance))
    category = args.category if args.category in ("fact", "decision", "entity", "other", "preference", "developer_note") else "fact"

    vector = embed_text(args.text, api_key)

    entry_id = str(uuid4())
    metadata = json.dumps({
        "source": args.source or "human",
        "injected_via": args.via or "cli",
    })

    row = {
        "id": entry_id,
        "text": args.text,
        "vector": vector,
        "category": category,
        "scope": scope,
        "importance": importance,
        "timestamp": int(time.time() * 1000),
        "metadata": metadata,
    }

    table = get_table()
    table.add([row])

    result = {
        "id": entry_id,
        "text": args.text,
        "scope": scope,
        "category": category,
        "importance": importance,
        "source": args.source or "human",
    }
    print(json.dumps(result))


def cmd_list(args):
    table = get_table()
    has_filter = args.scope or args.project or args.repo
    scope = args.scope or build_scope(args.project or "", args.repo or "") if has_filter else None

    try:
        query = table.search()
        if scope:
            if scope.startswith("project:"):
                proj = scope.split(":", 1)[1]
                query = query.where(f"(scope = '{scope}' OR scope LIKE 'repo:{proj}/%')")
            else:
                query = query.where(f"scope = '{scope}'")
        results = query.limit(args.limit or 50).to_list()
    except Exception:
        results = []

    entries = []
    for row in results:
        meta = {}
        try:
            meta = json.loads(row.get("metadata", "{}") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass

        entries.append({
            "id": row.get("id", ""),
            "text": row.get("text", ""),
            "category": row.get("category", ""),
            "scope": row.get("scope", ""),
            "importance": row.get("importance", 3),
            "timestamp": row.get("timestamp", 0),
            "source": meta.get("source", "auto"),
        })

    entries.sort(key=lambda e: (-e["importance"], -e["timestamp"]))
    print(json.dumps({"entries": entries, "count": len(entries), "scope": scope or "all"}))


def cmd_delete(args):
    table = get_table()
    try:
        table.delete(f"id = '{args.id}'")
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
