#!/usr/bin/env python3
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
from context_fabrica_config import (
    context_fabrica_dsn,
    context_fabrica_embedding_dimensions,
    context_fabrica_embedding_model,
    context_fabrica_schema,
    existing_context_fabrica_embedding_dimensions,
    existing_context_fabrica_schema,
    include_existing_context_fabrica_schema,
    make_existing_context_fabrica_adapter,
    make_existing_context_fabrica_embedder,
    gemini_embedding_payload,
    gemini_embedding_url,
    make_context_fabrica_adapter,
)

EMBEDDING_MODEL = context_fabrica_embedding_model()
EMBEDDING_URL = gemini_embedding_url(EMBEDDING_MODEL)


def get_gemini_key() -> str:
    key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not key:
        env_file = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control"))) / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("GOOGLE_GENERATIVE_AI_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
    return key


def embed_text(text: str, api_key: str) -> List[float]:
    payload = json.dumps(gemini_embedding_payload(text, model=EMBEDDING_MODEL)).encode()

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
    return make_context_fabrica_adapter(bootstrap=True)


def _configured_adapter(schema: str, dimensions: int, *, bootstrap: bool = False) -> PostgresPgvectorAdapter:
    adapter = PostgresPgvectorAdapter.from_dsn(
        context_fabrica_dsn(),
        schema=schema,
        embedding_dimensions=dimensions,
    )
    if bootstrap:
        adapter.bootstrap()
    return adapter


def _embedding_column_dimension(adapter: PostgresPgvectorAdapter) -> int | None:
    schema = adapter.settings.schema
    try:
        with adapter.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT format_type(a.atttypid, a.atttypmod)
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s
                      AND c.relname = 'memory_chunks'
                      AND a.attname = 'embedding'
                      AND NOT a.attisdropped
                    """,
                    (schema,),
                )
                row = cur.fetchone()
        if not row:
            return None
        type_text = str(row[0])
        if "(" not in type_text or ")" not in type_text:
            return None
        return int(type_text.split("(", 1)[1].split(")", 1)[0])
    except Exception:
        return None


def _schema_status(adapter: PostgresPgvectorAdapter, configured_dimensions: int, *, writable: bool) -> dict:
    actual_dimensions = _embedding_column_dimension(adapter)
    return {
        "schema": adapter.settings.schema,
        "configured_dimensions": configured_dimensions,
        "actual_dimensions": actual_dimensions,
        "exists": actual_dimensions is not None,
        "matches": actual_dimensions == configured_dimensions if actual_dimensions is not None else None,
        "writable": writable,
    }


def _reset_embedding_column(adapter: PostgresPgvectorAdapter, dimensions: int) -> None:
    schema = adapter.settings.schema
    with adapter.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(f"DROP INDEX IF EXISTS {schema}.idx_{schema}_chunks_embedding")
            cur.execute(f"DELETE FROM {schema}.memory_chunks")
            cur.execute(f"ALTER TABLE {schema}.memory_chunks ALTER COLUMN embedding TYPE vector({dimensions})")
        conn.commit()


def _record_to_entry(rec: KnowledgeRecord) -> dict:
    tags = rec.tags if isinstance(rec.tags, dict) else {}
    meta = rec.metadata if isinstance(rec.metadata, dict) else {}
    return {
        "id": rec.record_id,
        "text": rec.text or "",
        "category": tags.get("category", rec.kind),
        "scope": tags.get("scope", meta.get("original_scope", "")),
        "domain": rec.domain or "global",
        "stage": rec.stage,
        "importance": round(rec.confidence * 5),
        "timestamp": int(rec.created_at.timestamp() * 1000) if rec.created_at else 0,
        "source": meta.get("source", rec.source or "auto"),
        "shared": bool(tags.get("shared") or meta.get("shared_at")),
        "shared_at": meta.get("shared_at"),
        "shared_from_schema": meta.get("shared_from_schema"),
    }


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
        entry = _record_to_entry(rec)
        rec_scope = entry.get("scope", "")

        # If filtering by specific scope, skip non-matching
        if scope and rec_scope and scope != "global":
            if scope.startswith("project:"):
                proj = scope.split(":", 1)[1]
                if not (rec_scope == scope or rec_scope.startswith(f"repo:{proj}/")):
                    continue
            elif rec_scope != scope:
                continue

        entries.append(entry)

    entries.sort(key=lambda e: (-e["importance"], -e["timestamp"]))
    print(json.dumps({"entries": entries, "count": len(entries), "scope": scope or "all"}))


def cmd_doctor(args):
    primary = make_context_fabrica_adapter(bootstrap=False)
    statuses = [_schema_status(primary, context_fabrica_embedding_dimensions(), writable=True)]
    if include_existing_context_fabrica_schema() and existing_context_fabrica_schema() != context_fabrica_schema():
        existing = make_existing_context_fabrica_adapter()
        statuses.append(_schema_status(existing, existing_context_fabrica_embedding_dimensions(), writable=False))
    ok = all(status["matches"] is not False for status in statuses)
    print(json.dumps({"ok": ok, "schemas": statuses}))


def cmd_reembed(args):
    api_key = get_gemini_key()
    if not api_key:
        print(json.dumps({"error": "No Gemini API key"}))
        sys.exit(1)

    schema = args.schema or context_fabrica_schema()
    dimensions = int(args.dimensions or context_fabrica_embedding_dimensions())
    if schema != context_fabrica_schema() and not args.force:
        print(json.dumps({
            "error": "Refusing to re-embed a non-primary schema without --force",
            "schema": schema,
        }))
        sys.exit(1)

    adapter = _configured_adapter(schema, dimensions, bootstrap=False)
    actual = _embedding_column_dimension(adapter)
    if actual is not None and actual != dimensions:
        _reset_embedding_column(adapter, dimensions)
    adapter.bootstrap()

    records = adapter.list_records(limit=args.limit or 100000)
    count = 0
    for rec in records:
        vector = embed_text(rec.text or "", api_key)
        adapter.replace_chunks(rec.record_id, [(rec.text or "", vector, 0)])
        count += 1

    print(json.dumps({
        "reembedded": count,
        "schema": schema,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dimensions": dimensions,
    }))


def _recall_primary(query: str, domains: list[str], top_k: int) -> list[dict]:
    vector = embed_text(query, get_gemini_key())
    adapter = _make_adapter()
    rows: list[dict] = []
    for domain in domains:
        for result in adapter.semantic_search(vector, domain=domain, top_k=top_k):
            entry = _record_to_entry(result.record)
            entry.update({
                "schema": context_fabrica_schema(),
                "score": result.semantic_score,
                "feedback_enabled": True,
            })
            rows.append(entry)
    return rows


def _recall_existing(query: str, domains: list[str], top_k: int) -> list[dict]:
    if not include_existing_context_fabrica_schema() or existing_context_fabrica_schema() == context_fabrica_schema():
        return []
    embedder = make_existing_context_fabrica_embedder()
    vector = embedder.embed(query)
    adapter = make_existing_context_fabrica_adapter()
    rows: list[dict] = []
    for domain in domains:
        for result in adapter.semantic_search(vector, domain=domain, top_k=top_k):
            entry = _record_to_entry(result.record)
            entry.update({
                "schema": existing_context_fabrica_schema(),
                "score": result.semantic_score,
                "feedback_enabled": False,
            })
            rows.append(entry)
    return rows


def cmd_recall(args):
    if not args.query:
        print(json.dumps({"error": "query is required"}))
        sys.exit(1)
    domains = []
    if args.domain:
        domains.append(args.domain)
    if args.project and args.repo:
        domains.append(f"{args.project}/{args.repo}")
    if args.project:
        domains.append(args.project)
    domains.append("global")
    domains = list(dict.fromkeys(domains))

    rows: list[dict] = []
    errors: list[str] = []
    try:
        rows.extend(_recall_primary(args.query, domains, args.limit or 5))
    except Exception as e:
        errors.append(f"primary: {e}")
    try:
        rows.extend(_recall_existing(args.query, domains, args.limit or 5))
    except Exception as e:
        errors.append(f"existing: {e}")

    seen = set()
    deduped = []
    for row in sorted(rows, key=lambda item: float(item.get("score", 0.0)), reverse=True):
        key = (row.get("schema"), row.get("id"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)

    print(json.dumps({
        "query": args.query,
        "domains": domains,
        "results": deduped[:args.limit or 5],
        "errors": errors,
    }))


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

    p_doctor = sub.add_parser("doctor")
    p_doctor.set_defaults(func=cmd_doctor)

    p_reembed = sub.add_parser("reembed")
    p_reembed.add_argument("--schema", default="")
    p_reembed.add_argument("--dimensions", type=int, default=0)
    p_reembed.add_argument("--limit", type=int, default=0)
    p_reembed.add_argument("--force", action="store_true")
    p_reembed.set_defaults(func=cmd_reembed)

    p_recall = sub.add_parser("recall")
    p_recall.add_argument("--query", required=True)
    p_recall.add_argument("--project", default="")
    p_recall.add_argument("--repo", default="")
    p_recall.add_argument("--domain", default="")
    p_recall.add_argument("--limit", type=int, default=5)
    p_recall.set_defaults(func=cmd_recall)

    p_delete = sub.add_parser("delete")
    p_delete.add_argument("--id", required=True)
    p_delete.set_defaults(func=cmd_delete)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
