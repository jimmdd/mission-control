"""Carry a repo's local environment config into the worktrees we build from it.

A `git worktree` contains tracked content and nothing else. Local `.env` files are
gitignored by construction, so every worktree Mission Control creates — agent
worktrees and the throwaway gate-check probe alike — starts without them. Any gate
that compiles or runs the app then fails for a reason that has nothing to do with
the work being verified.

That is not hypothetical. The Phase 0 gate `bun run --cwd apps/new-ui build` was
diagnosed as a broken base commit and written off as the target repo's problem. It
was neither: SvelteKit's `$env/static/public` only exports the `PUBLIC_*` names
defined at build time, so with no `.env` the build died on
`MISSING_EXPORT "PUBLIC_API_URL"`. Supply the names and the same commit builds in
four seconds. The gate was fine; the worktree was empty.

Two sources, in order of trust:

1. A real `.env` beside the one in the source repo — copied verbatim. This is what a
   developer running the gate by hand would have.
2. Failing that, `.env.example` renamed to `.env`. Placeholder values are enough to
   make a *build* gate meaningful (the compiler wants the names to exist, not to
   resolve), and a seeded file is reported separately so a pass is attributable.

Nothing is invented and nothing is overwritten: a worktree that already carries the
file is left alone.

Secrets never travel into a commit. Every destination is checked against
`git check-ignore` in the worktree first, and a path git would track is skipped
rather than written — copying a real `.env` onto a tracked path is how a secret ends
up in a diff.

Dependencies are the same story one layer down. `spawn-agent.sh` installs them in
every agent worktree, but the gate-check probe was created bare, so a build gate
there died on `vite: command not found` (exit 127) and got reported as a gate that
cannot pass. `install_dependencies` mirrors the spawn-time detection so the probe
sees what the agents will see, and `looks_unprepared` decides when it is worth
paying for — a gate that fails because the tree was never set up looks nothing like
a gate that fails on its merits.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

# Directory names that never hold the repo's own config, and would make the walk
# pathologically slow if it descended into them.
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "target", "vendor",
    ".svelte-kit", ".next", ".nuxt", ".venv", "venv", "__pycache__",
    ".turbo", ".cache", "coverage", ".pytest_cache",
}

# How deep below the repo root to look. Monorepo config lives at the root and one
# or two levels down (`apps/new-ui/.env`); deeper than that is a fixture.
MAX_DEPTH = 4

# Files whose contents are real local config, copied as-is.
LIVE_NAMES = (".env", ".env.local")

# Templates, in preference order, used only when no live file exists.
TEMPLATE_NAMES = (".env.example", ".env.sample", ".env.template", ".env.defaults")


def _walk_env_dirs(root: Path) -> List[Path]:
    """Directories under `root` holding any kind of env file, nearest first."""
    found: List[Path] = []
    stack = [(root, 0)]
    while stack:
        directory, depth = stack.pop(0)
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        if any(e.is_file() and e.name in LIVE_NAMES + TEMPLATE_NAMES for e in entries):
            found.append(directory)
        if depth >= MAX_DEPTH:
            continue
        for entry in entries:
            if entry.is_dir() and not entry.is_symlink() and entry.name not in SKIP_DIRS:
                stack.append((entry, depth + 1))
    return found


def _is_ignored(worktree: Path, dest: Path) -> bool:
    """Would git ignore this path in the worktree?

    `check-ignore` exits 0 for an ignored path, 1 for one git would track. A repo
    that tracks its own `.env` (or one where the check cannot run) answers 1, and we
    decline to write — the tracked copy is already there, and overwriting it would
    put local secrets into the agent's diff.
    """
    try:
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(dest)],
            cwd=str(worktree), capture_output=True, timeout=30,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def seed_worktree_env(repo_path: str, worktree_path: str) -> Dict[str, List]:
    """Mirror local env config from `repo_path` into `worktree_path`.

    Returns `{"copied": [...], "seeded": [...], "skipped": [...]}` with paths
    relative to the worktree. `copied` came from a real local file; `seeded` came
    from a checked-in template and therefore holds placeholder values.
    """
    repo = Path(repo_path).resolve()
    worktree = Path(worktree_path).resolve()
    report: Dict[str, List] = {"copied": [], "seeded": [], "skipped": []}

    if not repo.is_dir() or not worktree.is_dir():
        report["skipped"].append({"path": str(worktree), "reason": "repo or worktree missing"})
        return report

    for directory in _walk_env_dirs(repo):
        rel_dir = directory.relative_to(repo)
        dest_dir = worktree / rel_dir
        if not dest_dir.is_dir():
            # A path that exists in the source clone but not on the base ref — a
            # different branch, nothing to configure.
            continue

        for name in LIVE_NAMES:
            source = directory / name
            dest = dest_dir / name
            if not source.is_file() or dest.exists():
                continue
            _place(source, dest, worktree, report, "copied")

        # A live `.env` — whether it was already there or we just copied one — makes
        # the template redundant.
        if (dest_dir / ".env").exists():
            continue
        for name in TEMPLATE_NAMES:
            template = directory / name
            if template.is_file():
                _place(template, dest_dir / ".env", worktree, report, "seeded")
                break

    return report


def _place(source: Path, dest: Path, worktree: Path, report: Dict[str, List], bucket: str):
    rel = str(dest.relative_to(worktree))
    if not _is_ignored(worktree, dest):
        report["skipped"].append({"path": rel, "reason": "git would track this path"})
        return
    try:
        shutil.copyfile(source, dest)
        # Local config routinely holds credentials; keep it owner-only rather than
        # inheriting whatever umask the daemon happens to run under.
        dest.chmod(0o600)
        report[bucket].append(rel)
    except OSError as e:
        report["skipped"].append({"path": rel, "reason": f"copy failed: {e}"})


# Lockfile → installer, in the same precedence spawn-agent.sh uses. Keep the two in
# step: a probe prepared differently from the agent worktree is not a control.
INSTALLERS = (
    ("pnpm-lock.yaml", ["pnpm", "install"]),
    ("bun.lock", ["bun", "install"]),
    ("bun.lockb", ["bun", "install"]),
    ("yarn.lock", ["yarn", "install"]),
    ("package-lock.json", ["npm", "install"]),
)

# Exit 127 is the shell's "command not found". The strings cover runners that catch
# the failure themselves and exit with their own code.
UNPREPARED_MARKERS = (
    "command not found",
    "cannot find module",
    "module not found",
    "no such file or directory: node_modules",
    "is not recognized as an internal or external command",
)


def looks_unprepared(result: Dict) -> bool:
    """Did this gate fail because the tree was never set up, rather than on its merits?

    The distinction decides whether an install is worth paying for. A build that
    reports `vite: command not found` says nothing about the base commit; a build
    that compiles and then fails a type check says plenty.
    """
    if result.get("exit_code") == 127:
        return True
    reason = (result.get("reason") or "").lower()
    return any(marker in reason for marker in UNPREPARED_MARKERS)


def install_dependencies(worktree_path: str, timeout: int = 900) -> Optional[str]:
    """Install deps in a worktree the same way a spawn would. Returns the tool used.

    Best-effort by design: a dep hiccup must not turn into a verdict about the
    plan's gates. `None` means nothing was run, or the run failed.
    """
    worktree = Path(worktree_path)
    for lockfile, command in INSTALLERS:
        if not (worktree / lockfile).is_file():
            continue
        try:
            proc = subprocess.run(command, cwd=str(worktree), capture_output=True,
                                  text=True, timeout=timeout)
        except (subprocess.TimeoutExpired, OSError) as e:
            logging.warning(f"  {command[0]} install failed in probe worktree: {e}")
            return None
        if proc.returncode != 0:
            tail = ((proc.stderr or "") + (proc.stdout or ""))[-300:].strip()
            logging.warning(f"  {command[0]} install failed in probe worktree: {tail}")
            return None
        return command[0]
    return None


def describe(report: Dict[str, List]) -> str:
    """One line for a log or an activity feed. Empty string when nothing happened."""
    parts = []
    if report["copied"]:
        parts.append(f"{len(report['copied'])} local env file(s) copied")
    if report["seeded"]:
        parts.append(
            f"{len(report['seeded'])} seeded from .env.example "
            f"({', '.join(report['seeded'][:3])}) — placeholder values"
        )
    if report["skipped"]:
        parts.append(f"{len(report['skipped'])} skipped")
    return "; ".join(parts)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("repo_path")
    parser.add_argument("worktree_path")
    parser.add_argument("--json", action="store_true", help="emit the full report")
    args = parser.parse_args(argv)

    report = seed_worktree_env(args.repo_path, args.worktree_path)
    if args.json:
        print(json.dumps(report))
    else:
        summary = describe(report)
        if summary:
            print(f"  env: {summary}")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    sys.exit(main())
