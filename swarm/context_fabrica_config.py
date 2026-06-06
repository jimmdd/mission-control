"""Mission Control context-fabrica integration settings.

Mission Control uses context-fabrica as an installed Python dependency, but
keeps its own schema by default so its Gemini embeddings do not
mutate or conflict with a user's existing context-fabrica schema.
"""

from __future__ import annotations

import getpass
import json
import os
from pathlib import Path

from context_fabrica.storage import PostgresPgvectorAdapter


DEFAULT_SCHEMA = "mission_control"
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
DEFAULT_EMBEDDING_DIMENSIONS = 1536
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def load_mission_control_env() -> None:
    env_file = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control"))) / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def _swarm_config() -> dict:
    config_path = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control"))) / "swarm" / "swarm-config.json"
    if not config_path.exists():
        return {}
    try:
        return json.loads(config_path.read_text())
    except Exception:
        return {}


def context_fabrica_dsn() -> str:
    load_mission_control_env()
    return os.environ.get(
        "CONTEXT_FABRICA_DSN",
        f"postgresql://{getpass.getuser()}@localhost/context_fabrica",
    )


def context_fabrica_schema() -> str:
    load_mission_control_env()
    return os.environ.get("CONTEXT_FABRICA_SCHEMA", DEFAULT_SCHEMA)


def context_fabrica_embedding_dimensions() -> int:
    load_mission_control_env()
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    triage_cfg = cfg.get("triage", {}) if isinstance(cfg.get("triage", {}), dict) else {}
    raw = (
        os.environ.get("CONTEXT_FABRICA_EMBEDDING_DIMENSIONS")
        or os.environ.get("CONTEXT_FABRICA_EMBEDDING_DIM")
        or os.environ.get("EMBEDDING_DIMENSIONS")
        or knowledge_cfg.get("embedding_dimensions")
        or knowledge_cfg.get("embedding_dim")
        or triage_cfg.get("embedding_dimensions")
        or triage_cfg.get("embedding_dim")
    )
    if not raw:
        return DEFAULT_EMBEDDING_DIMENSIONS
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_EMBEDDING_DIMENSIONS


def context_fabrica_embedding_model() -> str:
    load_mission_control_env()
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    triage_cfg = cfg.get("triage", {}) if isinstance(cfg.get("triage", {}), dict) else {}
    return (
        os.environ.get("CONTEXT_FABRICA_EMBEDDING_MODEL")
        or os.environ.get("GEMINI_EMBEDDING_MODEL")
        or knowledge_cfg.get("embedding_model")
        or triage_cfg.get("embedding_model")
        or DEFAULT_EMBEDDING_MODEL
    )


def gemini_embedding_url(model: str | None = None) -> str:
    embedding_model = model or context_fabrica_embedding_model()
    return f"{GEMINI_API_BASE}/models/{embedding_model}:embedContent"


def gemini_embedding_payload(text: str, *, model: str | None = None) -> dict:
    embedding_model = model or context_fabrica_embedding_model()
    return {
        "model": f"models/{embedding_model}",
        "content": {"parts": [{"text": text}]},
        "outputDimensionality": context_fabrica_embedding_dimensions(),
    }


def make_context_fabrica_adapter(*, bootstrap: bool = False) -> PostgresPgvectorAdapter:
    adapter = PostgresPgvectorAdapter.from_dsn(
        context_fabrica_dsn(),
        schema=context_fabrica_schema(),
        embedding_dimensions=context_fabrica_embedding_dimensions(),
    )
    if bootstrap:
        adapter.bootstrap()
    return adapter
