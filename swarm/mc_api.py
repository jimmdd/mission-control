"""Shared Mission Control API authentication for Python runtime clients."""

from __future__ import annotations

import os
from urllib.parse import urlsplit


def _first(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def token_for(method: str, path: str) -> str:
    """Mirror the server's simple/scoped token selection exactly."""
    fallback = _first("MISSION_CONTROL_ACCESS_TOKEN", "MISSION_CONTROL_READ_ACCESS_TOKEN")
    if os.environ.get("MISSION_CONTROL_AUTH_MODE", "simple").strip().lower() != "scoped":
        return fallback

    route = urlsplit(path).path
    segments = [segment for segment in route.removeprefix("/api/").split("/") if segment]
    if segments and segments[0] == "webhooks":
        return _first("MISSION_CONTROL_WEBHOOK_SECRET", "MISSION_CONTROL_WRITE_TOKEN") or fallback
    if method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return _first("MISSION_CONTROL_READ_TOKEN") or fallback
    if method.upper() == "DELETE":
        return _first("MISSION_CONTROL_ADMIN_TOKEN", "MISSION_CONTROL_WRITE_TOKEN") or fallback
    return _first("MISSION_CONTROL_WRITE_TOKEN") or fallback


def headers_for(method: str, path: str, *, json_body: bool = False) -> dict[str, str]:
    headers: dict[str, str] = {}
    if json_body:
        headers["Content-Type"] = "application/json"
    token = token_for(method, path)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers
