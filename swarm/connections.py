#!/usr/bin/env python3
"""Readiness probe for Mission Control.

Detects, with honest non-interactive signals, whether the agent runtimes
(Claude / Codex / Pi) are installed and authenticated, and which external
sources are connected. Sources are read primarily from `claude mcp list`, which
already reports per-server connection status (Notion, Google Drive, etc.), plus
API-key / CLI integrations (Linear, GitHub).

Output is JSON so the API/CLI/dashboard can render a "Connections" view:
    { "runtimes": [...], "sources": [...], "summary": {...} }
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


HOME = Path.home()
MC_HOME = Path(os.environ.get("MC_HOME", str(HOME / ".mission-control")))


def load_env():
    env_file = MC_HOME / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def _runtime(name, installed, authenticated, detail="", fix=""):
    return {
        "name": name,
        "installed": installed,
        "authenticated": authenticated,
        "detail": detail,
        "fix": fix,
    }


def check_claude():
    binary = shutil.which("claude")
    if not binary:
        return _runtime("claude", False, False, "not installed", "Install Claude Code")
    # Logged-in signal: oauthAccount in ~/.claude.json, or an API key.
    claude_json = HOME / ".claude.json"
    if claude_json.exists():
        try:
            data = json.loads(claude_json.read_text())
            acct = data.get("oauthAccount")
            if isinstance(acct, dict) and acct.get("accountUuid"):
                who = acct.get("emailAddress") or acct.get("displayName") or "account"
                org = acct.get("organizationName")
                detail = f"logged in as {who}" + (f" ({org})" if org else "")
                return _runtime("claude", True, True, detail)
        except Exception:
            pass
    if os.environ.get("ANTHROPIC_API_KEY"):
        return _runtime("claude", True, True, "using ANTHROPIC_API_KEY")
    return _runtime("claude", True, False, "not logged in", "Run: claude auth login")


def check_codex():
    binary = shutil.which("codex")
    if not binary:
        return _runtime("codex", False, False, "not installed", "Install Codex CLI")
    if (HOME / ".codex" / "auth.json").exists():
        return _runtime("codex", True, True, "credentials present (~/.codex/auth.json)")
    if os.environ.get("OPENAI_API_KEY"):
        return _runtime("codex", True, True, "using OPENAI_API_KEY")
    return _runtime("codex", True, False, "not logged in", "Run: codex login")


def check_pi():
    binary = shutil.which("pi")
    if not binary:
        return _runtime("pi", False, False, "not installed", "Install Pi CLI")
    has_dir = (HOME / ".pi").exists()
    token = os.environ.get("ANTHROPIC_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    if has_dir and token:
        return _runtime("pi", True, True, "configured (~/.pi + token)")
    if has_dir:
        return _runtime("pi", True, False, "no token", "Set ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN")
    return _runtime("pi", True, False, "not configured", "Run: pi config")


def _source(name, kind, status, detail="", fix=""):
    return {"name": name, "kind": kind, "status": status, "detail": detail, "fix": fix}


# Parse a line of `claude mcp list` output, e.g.:
#   "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected"
#   "claude.ai Google Drive: https://... - ! Needs authentication"
#   "pencil: /path/to/server --flag - ✘ Failed to connect"
def parse_mcp_line(line):
    line = line.strip()
    if not line or ":" not in line or " - " not in line:
        return None
    name_part, rest = line.split(":", 1)
    _, _, status_text = rest.rpartition(" - ")
    status_text = status_text.strip()
    low = status_text.lower()
    if "connected" in low and "fail" not in low:
        status = "connected"
    elif "auth" in low:
        status = "needs_auth"
    elif "fail" in low or "error" in low:
        status = "error"
    else:
        status = "unknown"
    name = re.sub(r"^claude\.ai\s+", "", name_part.strip())
    return _source(name, "mcp", status, detail=status_text)


def parse_mcp_list(output):
    sources = []
    for line in output.splitlines():
        parsed = parse_mcp_line(line)
        if parsed:
            sources.append(parsed)
    return sources


def check_mcp_sources():
    if not shutil.which("claude"):
        return []
    try:
        out = subprocess.run(
            ["claude", "mcp", "list"],
            capture_output=True, text=True, timeout=25,
        )
    except Exception:
        return []
    return parse_mcp_list(out.stdout)


def check_linear():
    if os.environ.get("LINEAR_API_KEY"):
        return _source("Linear", "api_key", "connected", "LINEAR_API_KEY set")
    return _source("Linear", "api_key", "not_connected", "", "Set LINEAR_API_KEY")


def check_github():
    if not shutil.which("gh"):
        return _source("GitHub", "cli", "not_connected", "gh not installed", "Install GitHub CLI")
    try:
        out = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True, timeout=10)
        if out.returncode == 0:
            return _source("GitHub", "cli", "connected", "gh authenticated")
    except Exception:
        pass
    return _source("GitHub", "cli", "not_connected", "", "Run: gh auth login")


def build_report():
    load_env()
    runtimes = [check_claude(), check_codex(), check_pi()]
    sources = check_mcp_sources()
    sources.append(check_linear())
    sources.append(check_github())

    runtimes_ready = sum(1 for r in runtimes if r["installed"] and r["authenticated"])
    sources_connected = sum(1 for s in sources if s["status"] == "connected")
    return {
        "runtimes": runtimes,
        "sources": sources,
        "summary": {
            "runtimesReady": runtimes_ready,
            "runtimesTotal": len(runtimes),
            "sourcesConnected": sources_connected,
            "sourcesTotal": len(sources),
            "ready": runtimes_ready >= 1,
        },
    }


def _selftest():
    sample = (
        "Checking MCP server health…\n"
        "\n"
        "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication\n"
        "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected\n"
        "pencil: /path/to/server --app x - ✘ Failed to connect\n"
    )
    parsed = parse_mcp_list(sample)
    by_name = {s["name"]: s["status"] for s in parsed}
    assert by_name == {
        "Google Drive": "needs_auth",
        "Notion": "connected",
        "pencil": "error",
    }, by_name
    print("selftest OK")


def main():
    if "--selftest" in sys.argv:
        _selftest()
        return
    print(json.dumps(build_report(), indent=2))


if __name__ == "__main__":
    main()
