#!/usr/bin/env python3
"""Service health checker for Mission Control."""

import json
import os
import shutil
import subprocess
import urllib.request
import time
from datetime import datetime, timezone
from pathlib import Path


MC_HOME = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))


def load_env():
    env_file = MC_HOME / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def check_http_service(name, url, timeout=5):
    """Check an HTTP service by hitting its health endpoint."""
    result = {"name": name, "status": "down", "pid": None, "uptime": None, "last_check": now_iso(), "details": ""}
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            result["status"] = "up"
            # Try to extract PID and uptime from JSON health responses
            try:
                health_data = json.loads(body)
                if isinstance(health_data, dict):
                    if "pid" in health_data:
                        result["pid"] = health_data["pid"]
                    if "uptime" in health_data:
                        uptime_secs = health_data["uptime"]
                        if isinstance(uptime_secs, (int, float)):
                            h, rem = divmod(int(uptime_secs), 3600)
                            m, s = divmod(rem, 60)
                            result["uptime"] = f"{h:02d}:{m:02d}:{s:02d}"
                    result["details"] = health_data.get("status", "ok")
                else:
                    result["details"] = body[:200]
            except (json.JSONDecodeError, ValueError):
                result["details"] = "responding"
    except Exception as e:
        result["status"] = "down"
        result["details"] = str(e)[:200]
    return result


def check_launchd_service(name, label):
    """Check a launchd service via launchctl list."""
    result = {"name": name, "status": "down", "pid": None, "uptime": None, "last_check": now_iso(), "details": ""}
    try:
        out = subprocess.run(
            ["launchctl", "list"],
            capture_output=True, text=True, timeout=5
        )
        for line in out.stdout.splitlines():
            if label in line:
                parts = line.split("\t")
                if len(parts) >= 3:
                    pid_str = parts[0].strip()
                    exit_code_str = parts[1].strip()
                    if pid_str != "-" and pid_str.isdigit():
                        pid = int(pid_str)
                        result["pid"] = pid
                        result["status"] = "up"
                        result["uptime"] = get_process_uptime(pid)
                        result["details"] = f"PID {pid}, exit code {exit_code_str}"
                    else:
                        exit_code = int(exit_code_str) if exit_code_str.isdigit() else -1
                        if exit_code == 0:
                            result["status"] = "up"
                            result["details"] = "Idle (scheduled, last exit 0)"
                        else:
                            result["status"] = "down"
                            result["details"] = f"Crashed (exit code {exit_code_str})"
                return result
        result["details"] = f"Label '{label}' not found in launchctl list"
    except Exception as e:
        result["details"] = str(e)[:200]
    return result


def check_postgresql():
    """Check PostgreSQL via pg_isready."""
    result = {"name": "PostgreSQL", "status": "down", "pid": None, "uptime": None, "last_check": now_iso(), "details": ""}
    pg_isready = "/opt/homebrew/opt/postgresql@17/bin/pg_isready"
    try:
        out = subprocess.run(
            [pg_isready],
            capture_output=True, text=True, timeout=5
        )
        if out.returncode == 0:
            result["status"] = "up"
            result["details"] = out.stdout.strip()
            # Try to get PID
            try:
                ps = subprocess.run(
                    ["pgrep", "-f", "postgres.*-D"],
                    capture_output=True, text=True, timeout=3
                )
                if ps.stdout.strip():
                    pid = int(ps.stdout.strip().splitlines()[0])
                    result["pid"] = pid
                    result["uptime"] = get_process_uptime(pid)
            except Exception:
                pass
        else:
            result["details"] = out.stdout.strip() or out.stderr.strip() or "pg_isready failed"
    except FileNotFoundError:
        result["details"] = f"{pg_isready} not found"
    except Exception as e:
        result["details"] = str(e)[:200]
    return result


def check_command(name, command):
    result = {"name": name, "status": "down", "pid": None, "uptime": None, "last_check": now_iso(), "details": ""}
    binary = shutil.which(command)
    if binary:
        result["status"] = "up"
        result["details"] = binary
    else:
        result["details"] = f"{command} not found in PATH"
    return result


def check_env(name, *keys):
    result = {"name": name, "status": "down", "pid": None, "uptime": None, "last_check": now_iso(), "details": ""}
    present = [key for key in keys if os.environ.get(key)]
    if present:
        result["status"] = "up"
        result["details"] = "set: " + ", ".join(present)
    else:
        result["details"] = "missing: " + ", ".join(keys)
    return result


def check_knowledge_doctor():
    result = {"name": "Knowledge Doctor", "status": "down", "pid": None, "uptime": None, "last_check": now_iso(), "details": ""}
    script = MC_HOME / "swarm" / "knowledge-manage.py"
    python_bin = Path(os.environ.get("MC_PYTHON_BIN", str(MC_HOME / "venv-3.12" / "bin" / "python3")))
    if not script.exists():
        result["details"] = f"{script} not found"
        return result
    try:
        out = subprocess.run(
            [str(python_bin), str(script), "doctor"],
            capture_output=True, text=True, timeout=20
        )
        if out.returncode != 0:
            result["details"] = (out.stderr or out.stdout or "doctor failed")[:200]
            return result
        data = json.loads(out.stdout)
        result["status"] = "up" if data.get("ok") else "down"
        result["details"] = json.dumps(data)[:500]
    except Exception as e:
        result["details"] = str(e)[:200]
    return result


def get_process_uptime(pid):
    """Get uptime of a process by PID using ps."""
    try:
        out = subprocess.run(
            ["ps", "-o", "etime=", "-p", str(pid)],
            capture_output=True, text=True, timeout=3
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return None


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def main():
    load_env()
    services = []

    # 1. Mission Control
    services.append(check_http_service("Mission Control", "http://127.0.0.1:18790/health"))

    # 2-5. Core launchd services
    launchd_services = [
        ("Bridge", "ai.mission-control.bridge"),
        ("Check Agents", "ai.mission-control.check-agents"),
        ("Repo Watcher", "ai.mission-control.repo-watcher"),
    ]
    for name, label in launchd_services:
        services.append(check_launchd_service(name, label))

    # 6. PostgreSQL
    services.append(check_postgresql())

    # Local runtime dependencies
    for name, command in [
        ("tmux", "tmux"),
        ("git", "git"),
        ("GitHub CLI", "gh"),
        ("Node", "node"),
        ("npm", "npm"),
    ]:
        services.append(check_command(name, command))

    services.append(check_env("Gemini API Key", "GOOGLE_GENERATIVE_AI_API_KEY"))
    services.append(check_env("Planner API Key", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"))
    services.append(check_knowledge_doctor())

    # Determine overall status
    statuses = [s["status"] for s in services]
    if all(s == "up" for s in statuses):
        overall = "healthy"
    elif any(s == "down" for s in statuses):
        down_count = statuses.count("down")
        # Critical if more than half are down or if core services (MC, PG) are down
        core_names = {"Mission Control", "PostgreSQL"}
        core_down = any(s["status"] == "down" and s["name"] in core_names for s in services)
        if down_count > len(statuses) // 2 or core_down:
            overall = "critical"
        else:
            overall = "degraded"
    else:
        overall = "degraded"

    print(json.dumps({"services": services, "overall": overall}, indent=2))


if __name__ == "__main__":
    main()
