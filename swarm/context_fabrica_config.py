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
DEFAULT_EXISTING_SCHEMA = "context_fabrica"
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
DEFAULT_EMBEDDING_DIMENSIONS = 1536
DEFAULT_EXISTING_EMBEDDER = "fastembed"
DEFAULT_EXISTING_EMBEDDING_DIMENSIONS = 384
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


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return _coerce_bool(raw, default)


def _coerce_bool(value: object, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() not in {"0", "false", "no", "off", ""}


def include_existing_context_fabrica_schema() -> bool:
    load_mission_control_env()
    if os.environ.get("CONTEXT_FABRICA_INCLUDE_EXISTING") is not None:
        return _env_bool("CONTEXT_FABRICA_INCLUDE_EXISTING", True)
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    return _coerce_bool(knowledge_cfg.get("include_existing"), True)


def existing_context_fabrica_schema() -> str:
    load_mission_control_env()
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    return os.environ.get("CONTEXT_FABRICA_EXISTING_SCHEMA") or knowledge_cfg.get("existing_schema") or DEFAULT_EXISTING_SCHEMA


def existing_context_fabrica_embedding_dimensions() -> int:
    load_mission_control_env()
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    raw = (
        os.environ.get("CONTEXT_FABRICA_EXISTING_EMBEDDING_DIMENSIONS")
        or os.environ.get("CONTEXT_FABRICA_EXISTING_EMBEDDING_DIM")
        or knowledge_cfg.get("existing_embedding_dimensions")
        or knowledge_cfg.get("existing_embedding_dim")
    )
    if not raw:
        return DEFAULT_EXISTING_EMBEDDING_DIMENSIONS
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_EXISTING_EMBEDDING_DIMENSIONS


def existing_context_fabrica_embedder_name() -> str:
    load_mission_control_env()
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    return os.environ.get("CONTEXT_FABRICA_EXISTING_EMBEDDER") or knowledge_cfg.get("existing_embedder") or DEFAULT_EXISTING_EMBEDDER


def existing_context_fabrica_embedder_model() -> str | None:
    load_mission_control_env()
    cfg = _swarm_config()
    knowledge_cfg = cfg.get("knowledge", {}) if isinstance(cfg.get("knowledge", {}), dict) else {}
    return os.environ.get("CONTEXT_FABRICA_EXISTING_EMBED_MODEL") or knowledge_cfg.get("existing_embed_model")


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
        _guard_embedding_dimensions(adapter, context_fabrica_embedding_dimensions())
        adapter.bootstrap()
    return adapter


def _guard_embedding_dimensions(adapter: PostgresPgvectorAdapter, configured_dimensions: int) -> None:
    actual = _embedding_column_dimensions(adapter)
    if actual is not None and actual != configured_dimensions:
        raise RuntimeError(
            f"Context Fabrica schema '{adapter.settings.schema}' has embedding dimension {actual}, "
            f"but Mission Control is configured for {configured_dimensions}. "
            "Use a different schema or re-embed the existing schema before bootstrapping."
        )


def _embedding_column_dimensions(adapter: PostgresPgvectorAdapter) -> int | None:
    try:
        with adapter.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT format_type(a.atttypid, a.atttypmod)
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s
                      AND c.relname = 'memory_chunks'
                      AND a.attname = 'embedding'
                      AND NOT a.attisdropped
                    """,
                    (adapter.settings.schema,),
                )
                row = cur.fetchone()
        if not row:
            return None
        type_text = str(row[0])
        if "(" not in type_text or ")" not in type_text:
            return None
        return int(type_text.split("(", 1)[1].split(")", 1)[0])
    except Exception:
        return None


def make_existing_context_fabrica_adapter() -> PostgresPgvectorAdapter:
    return PostgresPgvectorAdapter.from_dsn(
        context_fabrica_dsn(),
        schema=existing_context_fabrica_schema(),
        embedding_dimensions=existing_context_fabrica_embedding_dimensions(),
    )


def make_existing_context_fabrica_embedder():
    from context_fabrica.embedding import build_default_embedder

    return build_default_embedder(
        dimensions=existing_context_fabrica_embedding_dimensions(),
        embedder=existing_context_fabrica_embedder_name(),
        model_name=existing_context_fabrica_embedder_model(),
    )
