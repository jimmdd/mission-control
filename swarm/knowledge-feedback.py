#!/Users/mm/.openclaw/venv-3.12/bin/python3
"""
Knowledge Feedback — Track whether recalled knowledge helped downstream tasks.

Called after a task completes to update outcome tracking in Context Fabrica.

This creates a feedback loop:
  - Knowledge recalled → injected into prompt → task succeeds/fails
  - Successful tasks record positive outcomes → future recall scoring weights these higher
  - Failed tasks record negative outcomes → entries that don't help naturally decay

Usage:
  python3 knowledge-feedback.py --task-id TASK_ID --outcome success|failure
  python3 knowledge-feedback.py --entry-id ENTRY_ID --action recall    # mark as recalled
  python3 knowledge-feedback.py --entry-id ENTRY_ID --action helped    # mark as helped
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import List

from context_fabrica.storage import PostgresPgvectorAdapter
from context_fabrica.config import PostgresSettings

CONTEXT_FABRICA_DSN = os.environ.get("CONTEXT_FABRICA_DSN", "postgresql://mm@localhost/context_fabrica")
EMBEDDING_DIM = 3072

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [knowledge-feedback] %(message)s",
    datefmt="%H:%M:%S",
)


def _load_env():
    env_file = Path.home() / ".openclaw" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                if key.strip() and not os.environ.get(key.strip()):
                    os.environ[key.strip()] = value.strip()


def _make_adapter() -> PostgresPgvectorAdapter:
    return PostgresPgvectorAdapter.from_dsn(CONTEXT_FABRICA_DSN, embedding_dimensions=EMBEDDING_DIM)


def increment_metadata_counter(entry_id: str, counter: str):
    """Increment a counter in a record's metadata via Context Fabrica."""
    try:
        adapter = _make_adapter()
        record = adapter.fetch_record(entry_id)
        if not record:
            logging.warning(f"Entry {entry_id[:8]} not found")
            return

        meta = record.metadata if isinstance(record.metadata, dict) else {}
        meta[counter] = meta.get(counter, 0) + 1

        # Update via direct SQL (metadata is JSONB in postgres)
        schema = adapter.settings.schema
        with adapter.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE {schema}.memory_records SET metadata = %s WHERE record_id = %s",
                    (json.dumps(meta), entry_id),
                )
            conn.commit()

        # Also record outcome for the feedback loop
        outcome = "useful" if counter == "helped_count" else "recalled"
        try:
            adapter.record_outcome(entry_id, query_text="", outcome=outcome)
        except Exception:
            pass

        logging.info(f"  Updated {entry_id[:8]}: {counter}={meta[counter]}")

    except Exception as e:
        logging.error(f"Failed to update {entry_id[:8]}: {e}")


def mark_recalled(entry_ids: List[str]):
    """Mark entries as recalled (they were injected into an agent prompt)."""
    for eid in entry_ids:
        increment_metadata_counter(eid, "recall_count")


def mark_helped(entry_ids: List[str]):
    """Mark entries as having helped (the task they were recalled for succeeded)."""
    for eid in entry_ids:
        increment_metadata_counter(eid, "helped_count")


def process_task_outcome(task_id: str, outcome: str):
    """Find all entries recalled for a task and update their feedback counters."""
    try:
        adapter = _make_adapter()
        # Search for entries that were recalled for this task via metadata
        schema = adapter.settings.schema
        with adapter.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""SELECT record_id FROM {schema}.memory_records
                        WHERE metadata->>'recalled_for_tasks' LIKE %s""",
                    (f"%{task_id}%",),
                )
                rows = cur.fetchall()
    except Exception as e:
        logging.error(f"Failed to search for recalled entries: {e}")
        return

    matched = [row[0] for row in rows]

    if not matched:
        logging.info(f"No entries found that were recalled for task {task_id[:8]}")
        return

    logging.info(f"Found {len(matched)} entries recalled for task {task_id[:8]}")

    if outcome == "success":
        mark_helped(matched)
        logging.info(f"  Boosted helped_count for {len(matched)} entries")
    else:
        logging.info(f"  Task failed — no helped_count boost (recall_count already tracked)")


def main():
    _load_env()

    parser = argparse.ArgumentParser(description="Knowledge feedback tracking")
    parser.add_argument("--task-id", help="Task ID to process feedback for")
    parser.add_argument("--outcome", choices=["success", "failure", "partial"],
                        help="Task outcome")
    parser.add_argument("--entry-id", help="Specific entry ID to update")
    parser.add_argument("--action", choices=["recall", "helped"],
                        help="Action to perform on entry")

    args = parser.parse_args()

    if args.entry_id and args.action:
        if args.action == "recall":
            mark_recalled([args.entry_id])
        elif args.action == "helped":
            mark_helped([args.entry_id])
    elif args.task_id and args.outcome:
        process_task_outcome(args.task_id, args.outcome)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
