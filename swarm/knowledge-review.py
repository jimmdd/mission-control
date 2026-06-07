#!/usr/bin/env python3
"""Knowledge review CLI for Mission Control.
Subcommands: list, promote, reject, update.
Called by MC API routes via shell-out.
"""

import argparse
import json
import sys
from datetime import datetime, timezone

from context_fabrica.models import KnowledgeRecord
from context_fabrica.storage import PostgresPgvectorAdapter
from context_fabrica_config import (
    context_fabrica_dsn,
    context_fabrica_schema,
    existing_context_fabrica_embedding_dimensions,
    existing_context_fabrica_schema,
    make_context_fabrica_adapter,
    make_existing_context_fabrica_adapter,
    make_existing_context_fabrica_embedder,
)


def get_dsn() -> str:
    return context_fabrica_dsn()


def _make_adapter() -> PostgresPgvectorAdapter:
    return make_context_fabrica_adapter(bootstrap=True)


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


def cmd_share(args):
    source_adapter = _make_adapter()
    target_schema = existing_context_fabrica_schema()
    source_schema = context_fabrica_schema()
    if target_schema == source_schema:
        print(json.dumps({
            "shared": args.id,
            "source_schema": source_schema,
            "target_schema": target_schema,
            "already_shared": True,
        }))
        return

    source_record = source_adapter.fetch_record(args.id)
    if not source_record:
        print(json.dumps({"error": "Record not found"}))
        sys.exit(1)

    target_embedder = make_existing_context_fabrica_embedder()
    expected_dims = existing_context_fabrica_embedding_dimensions()
    actual_dims = int(getattr(target_embedder, "dimensions", expected_dims))
    if actual_dims != expected_dims:
        print(json.dumps({
            "error": "Shared embedder dimension mismatch",
            "expected_dimensions": expected_dims,
            "actual_dimensions": actual_dims,
        }))
        sys.exit(1)

    now = datetime.now(timezone.utc)
    metadata = source_record.metadata if isinstance(source_record.metadata, dict) else {}
    metadata = {
        **metadata,
        "shared_from_schema": source_schema,
        "shared_from_record_id": source_record.record_id,
        "shared_by": "mission-control",
        "shared_at": now.isoformat(),
    }
    tags = source_record.tags if isinstance(source_record.tags, dict) else {}
    tags = {**tags, "shared": True}

    shared_record = KnowledgeRecord(
        record_id=source_record.record_id,
        text=source_record.text,
        source="mission-control-share",
        domain=source_record.domain,
        namespace=source_record.namespace,
        confidence=source_record.confidence,
        stage="canonical",
        kind=source_record.kind,
        tags=tags,
        metadata=metadata,
        created_at=source_record.created_at,
        valid_from=source_record.valid_from,
        valid_to=source_record.valid_to,
        supersedes=source_record.supersedes,
        reviewed_at=now,
        occurred_from=source_record.occurred_from,
        occurred_to=source_record.occurred_to,
    )

    target_adapter = make_existing_context_fabrica_adapter()
    try:
        vector = target_embedder.embed(shared_record.text)
        target_adapter.upsert_record(shared_record)
        target_adapter.replace_chunks(shared_record.record_id, [(shared_record.text, vector, 0)])
        source_meta = source_record.metadata if isinstance(source_record.metadata, dict) else {}
        source_tags = source_record.tags if isinstance(source_record.tags, dict) else {}
        source_record.metadata = {
            **source_meta,
            "shared_to_schema": target_schema,
            "shared_at": now.isoformat(),
        }
        source_record.tags = {**source_tags, "shared": True}
        source_adapter.upsert_record(source_record)
        try:
            target_adapter.enqueue_projection(shared_record.record_id)
        except Exception:
            pass
        print(json.dumps({
            "shared": shared_record.record_id,
            "source_schema": source_schema,
            "target_schema": target_schema,
            "embedding_dimensions": actual_dims,
            "stage": "canonical",
        }))
    except Exception as e:
        print(json.dumps({"error": str(e), "target_schema": target_schema}))
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

    p_share = sub.add_parser("share")
    p_share.add_argument("--id", required=True)

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
    elif args.command == "share":
        cmd_share(args)
    elif args.command == "reject":
        cmd_reject(args)
    elif args.command == "update":
        cmd_update(args)


if __name__ == "__main__":
    main()
