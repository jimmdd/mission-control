#!/usr/bin/env python3
"""
Knowledge Feedback — Track whether recalled knowledge helped downstream tasks.

Called after a task completes to update the recall_count and helped_count
of knowledge entries that were injected into the agent's prompt.

This creates a feedback loop:
  - Knowledge recalled → injected into prompt → task succeeds/fails
  - Successful tasks boost helped_count → future recall scoring weights these higher
  - Failed tasks don't boost → entries that don't help naturally decay in relevance

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
import time
from pathlib import Path
from typing import List

import lancedb

LANCEDB_PATH = os.path.expanduser("~/.openclaw/memory/lancedb-pro")
MC_BASE_URL = os.environ.get("MISSION_CONTROL_URL", "http://localhost:18789/ext/mission-control")

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


def get_table():
    db = lancedb.connect(LANCEDB_PATH)
    return db.open_table("memories")


def increment_metadata_counter(entry_id: str, counter: str):
    """Increment a counter in an entry's metadata JSON.

    LanceDB doesn't support in-place updates, so we read-delete-reinsert.
    """
    try:
        table = get_table()
        results = table.search().where(f"id = '{entry_id}'").limit(1).to_list()
        if not results:
            logging.warning(f"Entry {entry_id[:8]} not found")
            return

        row = results[0]
        meta = json.loads(row.get("metadata", "{}") or "{}")
        meta[counter] = meta.get(counter, 0) + 1
        meta["last_feedback_at"] = int(time.time() * 1000)

        # Delete and reinsert with updated metadata
        table.delete(f"id = '{entry_id}'")

        updated_row = {
            "id": row["id"],
            "text": row["text"],
            "vector": row["vector"],
            "category": row["category"],
            "scope": row["scope"],
            "importance": row["importance"],
            "timestamp": row["timestamp"],
            "metadata": json.dumps(meta),
        }
        table.add([updated_row])
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
        table = get_table()
        # Find entries that were recalled for this task
        # These are tracked via the recall_log in metadata
        results = table.search().limit(1000).to_list()
    except Exception as e:
        logging.error(f"Failed to search for recalled entries: {e}")
        return

    matched = []
    for row in results:
        try:
            meta = json.loads(row.get("metadata", "{}") or "{}")
            recalled_for = meta.get("recalled_for_tasks", [])
            if task_id in recalled_for:
                matched.append(row["id"])
        except (json.JSONDecodeError, TypeError):
            continue

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
