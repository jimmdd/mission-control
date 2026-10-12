"""Narrow helper roles a ticket agent can call, each a separate read-only run.

Distilled from oh-my-openagent's explore / multimodal-looker / Momus / Oracle. What
made those roles cheap was not their prompts but their contract: a fixed, short
answer, so the calling agent's context grows by a few hundred tokens instead of by
whatever the helper had to read. MET-792 carried ~4 MB of screenshots and Paper
design dumps in its main context; with `looker`, the pixels stay in a process that
exits.

    explore — where is X, how does Y work. Cheap model.
    looker  — what do these images show against these criteria. Cheap model.
    critic  — APPROVE / REJECT a plan or a finished change, at most 3 blockers.
    oracle  — one recommendation after two failed attempts. Strong model.

Usage (request on stdin, answer on stdout):
    echo "where is the footer rendered?" | role.sh explore --cd <worktree>
    echo "is the nav centered at 1440?" | role.sh looker --cd <worktree> --image a.png
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

HERE = Path(__file__).resolve().parent
ROLES_DIR = HERE / "roles"

# Answers are capped: a role exists to keep the caller's context small, and one that
# returns a transcript defeats itself.
MAX_ANSWER_CHARS = 6000

DEFAULTS: Dict[str, Dict] = {
    "explore": {"model": "gpt-5.6-luna", "effort": "low", "timeout": 300},
    "looker": {"model": "gpt-5.6-luna", "effort": "low", "timeout": 300},
    "critic": {"model": "gpt-5.6-sol", "effort": "high", "timeout": 600},
    "oracle": {"model": "gpt-5.6-sol", "effort": "xhigh", "timeout": 600},
}


def role_config(role: str, swarm_config: Optional[dict] = None) -> Dict:
    """Defaults, overridden per role by swarm-config.json `roles.<name>`."""
    if role not in DEFAULTS:
        raise ValueError(f"unknown role {role!r}; one of {', '.join(DEFAULTS)}")
    override = ((swarm_config or {}).get("roles") or {}).get(role) or {}
    return {**DEFAULTS[role], **{k: v for k, v in override.items() if k in ("model", "effort", "timeout")}}


def build_prompt(role: str, request: str) -> str:
    return (ROLES_DIR / f"{role}.md").read_text().rstrip() + "\n\n---\nREQUEST:\n" + request.strip() + "\n"


def build_command(role: str, cfg: Dict, cwd: str, answer_file: str, images: List[str]) -> List[str]:
    cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
           "--cd", cwd, "--model", cfg["model"], "-c", f"model_reasoning_effort={cfg['effort']}",
           "-o", answer_file]
    for img in images:
        cmd += ["--image", img]
    return cmd


def cap(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_ANSWER_CHARS:
        return text
    return text[:MAX_ANSWER_CHARS].rstrip() + f"\n[truncated at {MAX_ANSWER_CHARS} chars]"


def run(role: str, request: str, cwd: str, images: List[str], env: Optional[dict] = None,
        swarm_config: Optional[dict] = None) -> int:
    cfg = role_config(role, swarm_config)
    missing = [i for i in images if not Path(i).is_file()]
    if missing:
        print(f"ROLE ERROR: image not found: {', '.join(missing)}")
        return 2
    if role == "looker" and not images:
        print("ROLE ERROR: looker needs at least one --image")
        return 2
    with tempfile.NamedTemporaryFile("r", suffix=".txt", delete=False) as fh:
        answer_file = fh.name
    try:
        proc = subprocess.run(build_command(role, cfg, cwd, answer_file, images),
                              input=build_prompt(role, request), text=True,
                              capture_output=True, timeout=cfg["timeout"], env=env)
        answer = Path(answer_file).read_text() if Path(answer_file).exists() else ""
        if proc.returncode != 0 or not answer.strip():
            tail = (proc.stderr or proc.stdout or "")[-600:]
            print(f"ROLE ERROR: {role} exited {proc.returncode} without an answer.\n{tail}")
            return 2
        print(cap(answer))
        return 0
    except subprocess.TimeoutExpired:
        # Bounded, like pre-review.sh: a helper that cannot answer must say so fast
        # rather than hold the ticket.
        print(f"ROLE ERROR: {role} timed out after {cfg['timeout']}s. Proceed without it.")
        return 2
    finally:
        try:
            os.unlink(answer_file)
        except OSError:
            pass


def _swarm_config() -> dict:
    mc = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))
    try:
        return json.loads((mc / "swarm" / "swarm-config.json").read_text())
    except Exception:
        return {}


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(prog="role.sh")
    ap.add_argument("role", choices=sorted(DEFAULTS))
    ap.add_argument("--cd", default=os.getcwd())
    ap.add_argument("--image", action="append", default=[])
    args = ap.parse_args(argv)
    request = sys.stdin.read()
    if not request.strip():
        print("ROLE ERROR: put the request on stdin")
        return 2
    env = dict(os.environ)
    try:
        import codex_home
        mc = Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control")))
        env["CODEX_HOME"] = str(codex_home.ensure(mc, Path.home() / ".codex"))
    except Exception:
        pass    # the operator's home still works; it is only larger
    return run(args.role, request, args.cd, args.image, env=env, swarm_config=_swarm_config())


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    sys.exit(main(sys.argv[1:]))
