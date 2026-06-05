"""Mission Control context-fabrica integration settings.

Mission Control uses context-fabrica as an installed Python dependency, but
keeps its own schema by default so its 3072-dimension Gemini embeddings do not
mutate or conflict with a user's existing context-fabrica schema.
"""

from __future__ import annotations

import getpass
import os
from pathlib import Path

from context_fabrica.storage import PostgresPgvectorAdapter


DEFAULT_SCHEMA = "mission_control"
DEFAULT_EMBEDDING_DIMENSIONS = 3072


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
    raw = (
        os.environ.get("CONTEXT_FABRICA_EMBEDDING_DIMENSIONS")
        or os.environ.get("CONTEXT_FABRICA_EMBEDDING_DIM")
        or os.environ.get("EMBEDDING_DIMENSIONS")
    )
    if not raw:
        return DEFAULT_EMBEDDING_DIMENSIONS
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_EMBEDDING_DIMENSIONS


def make_context_fabrica_adapter(*, bootstrap: bool = False) -> PostgresPgvectorAdapter:
    adapter = PostgresPgvectorAdapter.from_dsn(
        context_fabrica_dsn(),
        schema=context_fabrica_schema(),
        embedding_dimensions=context_fabrica_embedding_dimensions(),
    )
    if bootstrap:
        adapter.bootstrap()
    return adapter
