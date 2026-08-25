#!/usr/bin/env python3
"""Deterministic retry policy for account/session limits."""

from __future__ import annotations

import argparse
import json


def next_retry(
    now_ms: int,
    first_at_ms: int = 0,
    retry_count: int = 0,
    initial_seconds: int = 300,
    max_seconds: int = 7200,
    window_seconds: int = 43200,
) -> dict:
    """Return the next exponential retry, bounded by one recovery window."""
    now_ms = max(0, int(now_ms))
    first_at_ms = int(first_at_ms or now_ms)
    retry_count = max(0, int(retry_count))
    initial_seconds = max(1, int(initial_seconds))
    max_seconds = max(initial_seconds, int(max_seconds))
    window_seconds = max(initial_seconds, int(window_seconds))

    deadline_at = first_at_ms + window_seconds * 1000
    if now_ms >= deadline_at:
        return {
            "exhausted": True,
            "firstAt": first_at_ms,
            "deadlineAt": deadline_at,
            "retryCount": retry_count,
            "delaySeconds": 0,
            "nextRetryAt": None,
        }

    # Cap the exponent before shifting so corrupt state cannot create a huge int.
    exponent = min(retry_count, 30)
    delay_seconds = min(max_seconds, initial_seconds * (2 ** exponent))
    next_retry_at = min(now_ms + delay_seconds * 1000, deadline_at)
    return {
        "exhausted": False,
        "firstAt": first_at_ms,
        "deadlineAt": deadline_at,
        "retryCount": retry_count + 1,
        "delaySeconds": max(0, (next_retry_at - now_ms) // 1000),
        "nextRetryAt": next_retry_at,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--now-ms", type=int, required=True)
    parser.add_argument("--first-at-ms", type=int, default=0)
    parser.add_argument("--retry-count", type=int, default=0)
    parser.add_argument("--initial-seconds", type=int, default=300)
    parser.add_argument("--max-seconds", type=int, default=7200)
    parser.add_argument("--window-seconds", type=int, default=43200)
    args = parser.parse_args()
    print(json.dumps(next_retry(
        args.now_ms,
        args.first_at_ms,
        args.retry_count,
        args.initial_seconds,
        args.max_seconds,
        args.window_seconds,
    )))


if __name__ == "__main__":
    main()
