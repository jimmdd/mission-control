"""Shared utilities for mc-explore CLI and repo-watcher service."""

import fnmatch
import json
import logging
import os
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

from context_fabrica.models import KnowledgeRecord, Relation
from context_fabrica.storage import PostgresPgvectorAdapter

# === Constants ===

SWARM_DIR = Path.home() / ".openclaw" / "swarm"
ENV_FILE = Path.home() / ".openclaw" / ".env"
GITPROJECTS = Path.home() / "GitProjects"
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIM = 3072
EMBEDDING_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBEDDING_MODEL}:embedContent"

SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", "__pycache__",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "coverage",
    ".turbo", ".cache", "target", "vendor", ".gradle", "bower_components",
    ".idea", ".vscode", ".DS_Store", "eggs", "*.egg-info",
}

KEY_FILE_NAMES = [
    "README.md", "package.json", "pyproject.toml", "Cargo.toml",
    "tsconfig.json", "docker-compose.yml", "docker-compose.yaml",
    "Makefile", "go.mod", "setup.py", "setup.cfg",
]

KEY_SOURCE_PATTERNS = [
    "schema", "types", "models", "routes", "middleware",
    "config", "constants", "index", "main", "app", "server",
]

ARCHITECTURE_PATTERNS = [
    "openapi", "swagger", "proto", "graphql", "migration",
    "seed", "fixture", "plugin", "service", "handler", "controller",
]

SKIP_FILE_EXTENSIONS = {
    ".lock", ".map", ".min.js", ".min.css", ".wasm", ".png", ".jpg",
    ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot",
    ".zip", ".tar", ".gz", ".pdf", ".pyc", ".pyo", ".so", ".dylib",
}


# === Environment ===

def load_env() -> None:
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def get_gemini_key() -> str:
    key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not key:
        load_env()
        key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    return key


def make_adapter() -> PostgresPgvectorAdapter:
    dsn = os.environ.get("CONTEXT_FABRICA_DSN", "postgresql://mm@localhost/context_fabrica")
    return PostgresPgvectorAdapter.from_dsn(dsn, embedding_dimensions=EMBEDDING_DIM)


# === Gemini APIs ===

def embed_text(text: str, api_key: str) -> List[float]:
    payload = json.dumps({
        "model": f"models/{EMBEDDING_MODEL}",
        "content": {"parts": [{"text": text}]},
    }).encode()
    req = urllib.request.Request(
        f"{EMBEDDING_URL}?key={api_key}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["embedding"]["values"]


def call_gemini(prompt: str, api_key: str, max_tokens: int = 4096, model: str = "gemini-2.5-flash") -> Optional[str]:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent?key={api_key}"
    )
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        logging.error(f"Gemini API error: {e}")
        return None


def parse_gemini_json(response: str) -> Optional[dict]:
    text = response.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if "```" in text:
            text = text.rsplit("```", 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logging.warning(f"Gemini returned invalid JSON: {text[:100]}")
        return None


# === Git ===

def git(repo_dir: Path, *args) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_dir)] + list(args),
            capture_output=True, text=True, timeout=30,
        )
        return result.stdout.strip()
    except (subprocess.TimeoutExpired, OSError) as e:
        logging.warning(f"git error in {repo_dir.name}: {e}")
        return ""


# === .gitignore ===

def load_gitignore_patterns(repo_dir: Path) -> List[str]:
    gitignore = repo_dir / ".gitignore"
    if not gitignore.exists():
        return []
    patterns = []
    for line in gitignore.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(line)
    return patterns


def is_ignored(path: Path, repo_dir: Path, patterns: List[str]) -> bool:
    rel = str(path.relative_to(repo_dir))
    for part in path.relative_to(repo_dir).parts:
        if part in SKIP_DIRS:
            return True
    for pattern in patterns:
        if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(path.name, pattern):
            return True
    return False


# === Repo Walking ===

def walk_repo(repo_dir: Path) -> List[Path]:
    patterns = load_gitignore_patterns(repo_dir)
    files = []
    for root, dirs, filenames in os.walk(repo_dir):
        root_path = Path(root)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not is_ignored(root_path / d, repo_dir, patterns)]
        for f in filenames:
            fp = root_path / f
            if fp.suffix in SKIP_FILE_EXTENSIONS:
                continue
            if not is_ignored(fp, repo_dir, patterns):
                files.append(fp)
    return sorted(files)


def build_file_tree(repo_dir: Path, max_depth: int = 3) -> str:
    patterns = load_gitignore_patterns(repo_dir)
    lines = []

    def _walk(dir_path: Path, prefix: str, depth: int):
        if depth > max_depth:
            return
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return
        entries = [e for e in entries if e.name not in SKIP_DIRS and not is_ignored(e, repo_dir, patterns)]
        for i, entry in enumerate(entries):
            is_last = i == len(entries) - 1
            connector = "└── " if is_last else "├── "
            lines.append(f"{prefix}{connector}{entry.name}{'/' if entry.is_dir() else ''}")
            if entry.is_dir():
                ext = "    " if is_last else "│   "
                _walk(entry, prefix + ext, depth + 1)

    lines.append(f"{repo_dir.name}/")
    _walk(repo_dir, "", 1)
    return "\n".join(lines[:200])  # cap output


def identify_key_files(repo_dir: Path, all_files: List[Path]) -> List[Path]:
    key = []
    seen = set()
    # Named files first
    for name in KEY_FILE_NAMES:
        p = repo_dir / name
        if p.exists() and p not in seen:
            key.append(p)
            seen.add(p)
    # Source pattern matches
    for f in all_files:
        if f in seen:
            continue
        stem = f.stem.lower()
        if any(pat in stem for pat in KEY_SOURCE_PATTERNS + ARCHITECTURE_PATTERNS):
            key.append(f)
            seen.add(f)
    return key[:30]  # cap at 30 files


def read_key_files(key_files: List[Path], max_total: int = 50_000) -> Dict[str, str]:
    result = {}
    total = 0
    for f in key_files:
        if total >= max_total:
            break
        try:
            content = f.read_text(errors="replace")[:4096]
            result[str(f)] = content
            total += len(content)
        except (OSError, UnicodeDecodeError):
            continue
    return result


# === Monorepo Detection ===

def detect_monorepo(repo_dir: Path) -> List[Dict]:
    """Detect monorepo packages. Returns [] for regular repos."""
    packages = []

    # Check package.json workspaces
    pkg_json = repo_dir / "package.json"
    if pkg_json.exists():
        try:
            pkg = json.loads(pkg_json.read_text())
            workspaces = pkg.get("workspaces", [])
            if isinstance(workspaces, dict):
                workspaces = workspaces.get("packages", [])
            if workspaces:
                for pattern in workspaces:
                    import glob as g
                    for match in g.glob(str(repo_dir / pattern)):
                        mp = Path(match)
                        if mp.is_dir() and (mp / "package.json").exists():
                            packages.append({"name": mp.name, "path": mp, "type": "npm-workspace"})
                if packages:
                    return packages
        except (json.JSONDecodeError, OSError):
            pass

    # Check pnpm-workspace.yaml
    pnpm_ws = repo_dir / "pnpm-workspace.yaml"
    if pnpm_ws.exists():
        try:
            import re
            content = pnpm_ws.read_text()
            for line in content.splitlines():
                match = re.match(r"\s*-\s*['\"]?([^'\"]+)", line)
                if match:
                    import glob as g
                    for mp in g.glob(str(repo_dir / match.group(1))):
                        mp = Path(mp)
                        if mp.is_dir():
                            packages.append({"name": mp.name, "path": mp, "type": "pnpm-workspace"})
            if packages:
                return packages
        except OSError:
            pass

    # Check Cargo.toml workspace
    cargo = repo_dir / "Cargo.toml"
    if cargo.exists():
        try:
            content = cargo.read_text()
            if "[workspace]" in content:
                import re
                members = re.findall(r'members\s*=\s*\[(.*?)\]', content, re.DOTALL)
                if members:
                    for m in re.findall(r'"([^"]+)"', members[0]):
                        import glob as g
                        for mp in g.glob(str(repo_dir / m)):
                            mp = Path(mp)
                            if mp.is_dir():
                                packages.append({"name": mp.name, "path": mp, "type": "cargo-workspace"})
                    if packages:
                        return packages
        except OSError:
            pass

    # Check for common monorepo directories
    for dirname in ["packages", "apps", "libs", "services", "modules"]:
        d = repo_dir / dirname
        if d.is_dir():
            for child in sorted(d.iterdir()):
                if child.is_dir() and any((child / f).exists() for f in ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]):
                    packages.append({"name": child.name, "path": child, "type": f"{dirname}-dir"})

    return packages


# === Deduplication ===

def find_similar_records(adapter: PostgresPgvectorAdapter, embedding: List[float], domain: str, threshold: float = 0.92) -> List:
    try:
        results = adapter.semantic_search(embedding, domain=domain, top_k=3)
        return [r for r in results if r.semantic_score >= threshold]
    except Exception:
        return []


# === Knowledge Storage ===

def store_fact(
    adapter: PostgresPgvectorAdapter,
    text: str,
    embedding: List[float],
    project: str,
    repo: str,
    category: str = "fact",
    importance: int = 3,
    source: str = "mc-explore",
    stage: str = "staged",
    extra_metadata: Optional[Dict] = None,
) -> Optional[str]:
    """Store a single knowledge fact. Returns record_id or None if duplicate."""
    domain = f"{project}/{repo}" if repo else project
    scope = f"repo:{domain}" if repo else f"project:{project}"

    # Dedup check
    dupes = find_similar_records(adapter, embedding, domain)
    if dupes:
        return None

    record_id = str(uuid4())
    now = datetime.now(timezone.utc)
    confidence = min(importance / 5.0, 1.0)
    kind = "workflow" if category == "convention" else "fact"

    metadata = {
        "source": source,
        "project": project,
        "repo": repo,
        "original_scope": scope,
        "extracted_at": now.isoformat(),
    }
    if extra_metadata:
        metadata.update(extra_metadata)

    record = KnowledgeRecord(
        record_id=record_id,
        text=text,
        source=source,
        domain=domain,
        confidence=confidence,
        stage=stage,
        kind=kind,
        tags={"category": category, "scope": scope},
        metadata=metadata,
        created_at=now,
        valid_from=now,
    )
    adapter.upsert_record(record)
    adapter.replace_chunks(record_id, [(text, embedding, 0)])
    return record_id


def store_relations(
    adapter: PostgresPgvectorAdapter,
    record_id: str,
    relations: List[Dict],
) -> int:
    """Store entity relations for a record. Returns count stored."""
    if not relations:
        return 0
    rows = []
    for rel in relations:
        src = rel.get("source", "").lower()
        tgt = rel.get("target", "").lower()
        rtype = rel.get("relation", "RELATED_TO").upper()
        weight = float(rel.get("weight", 1.0))
        if src and tgt:
            rows.append((record_id, src, rtype, tgt, weight))
    if rows:
        adapter.replace_relations(record_id, rows)
    return len(rows)
