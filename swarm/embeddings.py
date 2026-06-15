"""Pluggable text embeddings for Mission Control.

Default provider is FastEmbed — local, free, no API key. Configure with:

    EMBEDDING_PROVIDER  = fastembed | openai | ollama | gemini   (default: fastembed)
    EMBEDDING_MODEL     = provider-specific model name (optional)
    CONTEXT_FABRICA_EMBEDDING_DIMENSIONS = vector size; must match the pgvector
                          schema and the chosen model's native dimension.

This module is the single source of truth for producing embedding vectors. All
swarm scripts route through embed_text() so the embedder can be swapped without
touching call sites. Only the chosen provider's dependency/key is required.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

DEFAULT_PROVIDER = "fastembed"

_PROVIDER_DEFAULTS = {
    "fastembed": {"model": "BAAI/bge-small-en-v1.5", "dims": 384},
    "openai": {"model": "text-embedding-3-small", "dims": 1536},
    "ollama": {"model": "nomic-embed-text", "dims": 768},
    "gemini": {"model": "gemini-embedding-001", "dims": 1536},
}


def _load_env() -> None:
    env_file = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control"))) / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def provider() -> str:
    _load_env()
    return (os.environ.get("EMBEDDING_PROVIDER") or DEFAULT_PROVIDER).strip().lower()


def model_name(p: Optional[str] = None) -> str:
    p = p or provider()
    return os.environ.get("EMBEDDING_MODEL") or _PROVIDER_DEFAULTS.get(p, {}).get("model", "")


def dimensions(p: Optional[str] = None) -> int:
    p = p or provider()
    raw = (
        os.environ.get("CONTEXT_FABRICA_EMBEDDING_DIMENSIONS")
        or os.environ.get("CONTEXT_FABRICA_EMBEDDING_DIM")
        or os.environ.get("EMBEDDING_DIMENSIONS")
    )
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return _PROVIDER_DEFAULTS.get(p, {}).get("dims", 384)


def available() -> tuple[bool, str]:
    """Whether the configured provider can produce embeddings right now.

    Returns (ok, reason). Reason is a human-readable hint when not ok.
    """
    p = provider()
    if p == "fastembed":
        try:
            import fastembed  # noqa: F401
            return True, ""
        except Exception:
            return False, "fastembed not installed (pip install fastembed)"
    if p == "openai":
        return (bool(os.environ.get("OPENAI_API_KEY")), "OPENAI_API_KEY not set")
    if p == "gemini":
        return (bool(os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY")), "GOOGLE_GENERATIVE_AI_API_KEY not set")
    if p == "ollama":
        return True, ""  # reachability checked at call time
    return False, f"unknown EMBEDDING_PROVIDER: {p}"


@lru_cache(maxsize=4)
def _fastembed_model(name: str):
    from fastembed import TextEmbedding
    return TextEmbedding(model_name=name)


def _embed_fastembed(text: str) -> List[float]:
    model = _fastembed_model(model_name("fastembed"))
    vec = list(model.embed([text]))[0]
    return vec.tolist() if hasattr(vec, "tolist") else list(vec)


def _embed_openai(text: str) -> List[float]:
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY not set for EMBEDDING_PROVIDER=openai")
    name = model_name("openai")
    body: dict = {"model": name, "input": text}
    dims = dimensions("openai")
    if dims and name.startswith("text-embedding-3"):
        body["dimensions"] = dims  # 3-* models support dimension reduction
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["data"][0]["embedding"]


def _embed_ollama(text: str) -> List[float]:
    base = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
    req = urllib.request.Request(
        f"{base}/api/embeddings",
        data=json.dumps({"model": model_name("ollama"), "prompt": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())["embedding"]


def _embed_gemini(text: str) -> List[float]:
    key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not key:
        raise RuntimeError("GOOGLE_GENERATIVE_AI_API_KEY not set for EMBEDDING_PROVIDER=gemini")
    name = model_name("gemini")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{name}:embedContent"
    body = {
        "model": f"models/{name}",
        "content": {"parts": [{"text": text}]},
        "outputDimensionality": dimensions("gemini"),
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["embedding"]["values"]


def embed_text(text: str, api_key: Optional[str] = None) -> List[float]:
    """Embed `text` with the configured provider.

    The `api_key` argument is accepted for backward compatibility with older
    call sites and ignored — each provider reads its own credentials.
    """
    p = provider()
    if p == "fastembed":
        return _embed_fastembed(text)
    if p == "openai":
        return _embed_openai(text)
    if p == "ollama":
        return _embed_ollama(text)
    if p == "gemini":
        return _embed_gemini(text)
    raise ValueError(f"Unknown EMBEDDING_PROVIDER: {p}")


def _selftest() -> None:
    os.environ.setdefault("EMBEDDING_PROVIDER", "fastembed")
    ok, reason = available()
    assert ok, f"fastembed unavailable: {reason}"
    vec = embed_text("authentication middleware retry loop")
    assert isinstance(vec, list) and len(vec) == dimensions("fastembed"), len(vec)
    assert all(isinstance(x, float) for x in vec[:5])
    print(f"selftest OK — provider={provider()} dims={len(vec)}")


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(json.dumps({"provider": provider(), "model": model_name(), "dimensions": dimensions()}))
