#!/usr/bin/env python3
"""One prompt in, one completion out — a transport for callers outside Python.

Provider selection, model choice, retries and the OpenRouter fallback all live in
planner._call_llm; this only exposes them. Keeping the choice there means the chat
assistant uses whatever the swarm is configured to use, instead of growing a second
opinion about which model to call.

Usage:  echo '{"prompt": "...", "system": "...", "role": "routing"}' | llm-call.py
Output: {"ok": true, "text": "..."}  |  {"ok": false, "error": "..."}
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MC_HOME = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))


def load_env() -> None:
    """Pull ~/.mission-control/.env into the environment.

    The launchd-run server does not load that file, so a provider key pasted into
    Settings is invisible to a child process unless it is read here. Same shape as
    connections.py / bridge.py — deliberately not importing mc_explore_common, which
    would drag in Postgres and pgvector to send one prompt.
    """
    env_file = MC_HOME / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad request: {e}"}))
        return 1

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        print(json.dumps({"ok": False, "error": "prompt is required"}))
        return 1

    load_env()

    system = payload.get("system") or ""
    role = payload.get("role") or "routing"
    try:
        max_tokens = int(payload.get("max_tokens") or 1024)
    except (TypeError, ValueError):
        max_tokens = 1024

    try:
        import planner  # noqa: PLC0415 — deferred so a bad import reports as an error, not a crash
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"planner import failed: {e}"}))
        return 1

    # An explicitly configured role wins; otherwise fall back to "routing", which is the
    # small/fast tier every install already has set up.
    try:
        cfg = planner._get_config()
        if not cfg.get(f"{role}_provider"):
            role = "routing"
    except Exception:
        role = "routing"

    try:
        text = planner._call_llm(prompt, role=role, system=system, max_tokens=max_tokens)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1

    if not text:
        print(json.dumps({"ok": False, "error": "no completion returned"}))
        return 1
    print(json.dumps({"ok": True, "text": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
