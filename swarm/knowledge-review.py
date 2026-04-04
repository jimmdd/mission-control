#!/Users/mm/.openclaw/venv-3.12/bin/python3
"""Knowledge review CLI for Mission Control.
Subcommands: list, promote, reject, update.
Called by MC API routes via shell-out.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
import os

from context_fabrica.models import KnowledgeRecord
from context_fabrica.storage import PostgresPgvectorAdapter

EMBEDDING_DIM = 3072


def get_dsn() -> str:
    dsn = os.environ.get("CONTEXT_FABRICA_DSN", "")
    if not dsn:
        env_file = Path.home() / ".openclaw" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("CONTEXT_FABRICA_DSN="):
                    dsn = line.split("=", 1)[1].strip()
                    break
    return dsn or "postgresql://mm@localhost/context_fabrica"


def _make_adapter() -> PostgresPgvectorAdapter:
    return PostgresPgvectorAdapter.from_dsn(get_dsn(), embedding_dimensions=EMBEDDING_DIM)


def _record_to_dict(rec: KnowledgeRecord) -> dict:
    tags = rec.tags if isinstance(rec.tags, dict) else {}
    meta = rec.metadata if isinstance(rec.metadata, dict) else {}
    return {
        "id": rec.record_id,
        "text": rec.text or "",
        "domain": rec.domain or "global",
        "stage": rec.stage,
        "kind": rec.kind,
        "confidence": rec.confidence,
        "source": rec.source or "",
        "category": tags.get("category", rec.kind),
        "scope": tags.get("scope", meta.get("original_scope", "")),
        "importance": round(rec.confidence * 5),
        "timestamp": int(rec.created_at.timestamp() * 1000) if rec.created_at else 0,
        "reviewed_at": int(rec.reviewed_at.timestamp() * 1000) if rec.reviewed_at else None,
        "meta_source": meta.get("source", "auto"),
    }


def cmd_list(args):
    adapter = _make_adapter()
    stage = args.stage if args.stage else None
    limit = args.limit or 50
    try:
        records = adapter.list_records(stage=stage, limit=limit)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    entries = [_record_to_dict(r) for r in records]
    entries.sort(key=lambda e: -e["timestamp"])
    print(json.dumps({"entries": entries, "count": len(entries), "stage": stage or "all"}))


def cmd_promote(args):
    adapter = _make_adapter()
    schema = adapter.settings.schema
    now = datetime.now(timezone.utc)
    try:
        with adapter.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE {schema}.memory_records SET memory_stage = 'canonical', reviewed_at = %s WHERE record_id = %s",
                    (now, args.id),
                )
                if cur.rowcount == 0:
                    print(json.dumps({"error": "Record not found"}))
                    sys.exit(1)
            conn.commit()
        # Enqueue for projection
        try:
            adapter.enqueue_projection(args.id)
        except Exception:
            pass
        print(json.dumps({"promoted": args.id, "stage": "canonical", "reviewed_at": int(now.timestamp() * 1000)}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def cmd_reject(args):
    adapter = _make_adapter()
    try:
        deleted = adapter.delete_record(args.id)
        if not deleted:
            print(json.dumps({"error": "Record not found"}))
            sys.exit(1)
        print(json.dumps({"rejected": args.id, "deleted": True}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def cmd_update(args):
    adapter = _make_adapter()
    schema = adapter.settings.schema
    fields = []
    params = []
    if args.text:
        fields.append("text_content = %s")
        params.append(args.text)
    if args.domain:
        fields.append("domain = %s")
        params.append(args.domain)
    if not fields:
        print(json.dumps({"error": "No fields to update"}))
        sys.exit(1)

    params.append(args.id)
    try:
        with adapter.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE {schema}.memory_records SET {', '.join(fields)} WHERE record_id = %s",
                    params,
                )
                if cur.rowcount == 0:
                    print(json.dumps({"error": "Record not found"}))
                    sys.exit(1)
            conn.commit()
        print(json.dumps({"updated": args.id, "fields": [f.split(" = ")[0] for f in fields]}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Knowledge review CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("--stage", default=None)
    p_list.add_argument("--limit", type=int, default=50)

    p_promote = sub.add_parser("promote")
    p_promote.add_argument("--id", required=True)

    p_reject = sub.add_parser("reject")
    p_reject.add_argument("--id", required=True)

    p_update = sub.add_parser("update")
    p_update.add_argument("--id", required=True)
    p_update.add_argument("--text", default=None)
    p_update.add_argument("--domain", default=None)

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args)
    elif args.command == "promote":
        cmd_promote(args)
    elif args.command == "reject":
        cmd_reject(args)
    elif args.command == "update":
        cmd_update(args)


if __name__ == "__main__":
    main()
