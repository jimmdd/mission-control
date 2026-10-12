#!/usr/bin/env python3
"""Render `claude -p --output-format stream-json` into the agent's readable log.

`--output-format text` (the old default) prints nothing until the run ends, so the
stall watchdog — which uses log growth as its only liveness signal — read every
Claude run that lasted longer than its 300s startup window as "produced no output at
all" and killed it. MET-833, MET-837 and MET-870 each lost three attempts that way
and were failed over to codex, and no Claude agent run had completed since Sep 17.

Streaming fixes the liveness signal; this filter keeps the log shaped the way the
launcher's checks expect:

- Progress (assistant text, tool calls, subagent activity) is written as lines
  prefixed `[agent] ` / `[tool] `. They exist for the watchdog and for humans; the
  launcher strips them before classifying an attempt, so an agent that merely
  *talks about* a rate limit or the turn limit cannot be misread as hitting one.
- The final `result` event is written unprefixed, exactly as text mode printed it,
  including `Error: Reached max turns (N)` for `error_max_turns`.
- Synthetic error messages (an account limit is reported as an assistant message
  from the `<synthetic>` model) are written unprefixed too, since they are what the
  account-limit check looks for.
- Anything that is not a JSON event (stderr, a crash trace) passes through verbatim.

Tool results are never written: they are bulk, and they are the likeliest place for
unrelated text to match a classification pattern.
"""

import json
import sys

PROGRESS_PREFIXES = ("[agent] ", "[tool] ")
SUMMARY_LIMIT = 160


def _one_line(value, limit=SUMMARY_LIMIT):
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _tool_summary(block):
    name = block.get("name", "tool")
    args = block.get("input") if isinstance(block.get("input"), dict) else {}
    for key in ("command", "file_path", "pattern", "description", "url", "query", "prompt"):
        if args.get(key):
            return f"{name}: {_one_line(args[key])}"
    return name


def _is_synthetic_error(event, message):
    return bool(event.get("error")) or message.get("model") == "<synthetic>"


def render(event):
    """Lines to write for one stream event (possibly none)."""
    kind = event.get("type")

    if kind == "assistant":
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        content = message.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
        synthetic = _is_synthetic_error(event, message)
        lines = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text", "").strip():
                text = block["text"].rstrip()
                if synthetic:
                    lines.append(text)
                else:
                    lines.extend("[agent] " + line for line in text.splitlines())
            elif block.get("type") == "tool_use":
                lines.append("[tool] " + _tool_summary(block))
        return lines

    if kind == "system" and event.get("subtype") in ("task_started", "task_notification"):
        label = event.get("description") or event.get("summary") or event.get("subtype")
        return ["[tool] subagent " + event.get("subtype", "").replace("task_", "") + ": " + _one_line(label)]

    if kind == "result":
        if event.get("subtype") == "error_max_turns":
            return [f"Error: Reached max turns ({event.get('num_turns', '?')})"]
        result = event.get("result")
        if isinstance(result, str) and result.strip():
            return [result.rstrip()]
        if event.get("is_error"):
            return [f"Error: {event.get('subtype', 'error')}"]
        return []

    return []


def main():
    out = sys.stdout
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        stripped = line.strip()
        event = None
        if stripped.startswith("{"):
            try:
                event = json.loads(stripped)
            except ValueError:
                event = None
        if not isinstance(event, dict):
            if stripped:
                out.write(line + "\n")
                out.flush()
            continue
        for text in render(event):
            out.write(text + "\n")
        out.flush()


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
