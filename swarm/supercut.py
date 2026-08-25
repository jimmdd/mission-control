#!/usr/bin/env python3
"""Find canonical Supercut share links for MCP-backed ticket ingestion.

Mission Control intentionally does not fetch Supercut content here. The bridge
hands these links to the authenticated Supercut MCP server, which preserves the
workspace permissions selected during OAuth.
"""

from __future__ import annotations

import re
import urllib.parse
from typing import List


SHARE_HOST = "supercut.ai"
MAX_LINKS = 3
READ_TOOLS = [
    "get-recording",
    "get-transcript",
    "get-frame",
    "list-comments",
    "list-reactions",
    "get-recording-analytics",
]

_LINK_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])https://supercut\.ai/share/"
    r"(?:[A-Za-z0-9_-]+/)?[A-Za-z0-9_-]+(?![A-Za-z0-9_/-])",
    re.IGNORECASE,
)


def extract_links(text: str) -> List[str]:
    """Return canonical, deduplicated Supercut public-share links."""
    links: List[str] = []
    for raw in _LINK_RE.findall(text or ""):
        parsed = urllib.parse.urlparse(raw.rstrip(".,)>]"))
        host = (parsed.hostname or "").lower().rstrip(".")
        parts = [part for part in parsed.path.split("/") if part]
        if (
            parsed.scheme != "https"
            or host != SHARE_HOST
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or len(parts) not in (2, 3)
            or parts[0] != "share"
        ):
            continue
        canonical = f"https://{SHARE_HOST}/" + "/".join(parts)
        if canonical not in links:
            links.append(canonical)
        if len(links) >= MAX_LINKS:
            break
    return links
