#!/usr/bin/env python3
"""meta-bot-ship PR review bot — standalone.

Depends only on the `gh` CLI (authenticated as the bot account, e.g. via
GH_TOKEN) and an LLM HTTP API (OpenRouter or Gemini). No Mission Control,
no bridge, no swarm, no codex/claude CLI.

Each run it scans the configured repos for open PRs where the bot is either a
requested reviewer or @-mentioned, runs an LLM review on the diff, posts it as a
PR review comment, and records the reviewed head SHA so it re-reviews only when
new commits land.

Config (env):
  PR_BOT_USER        bot GitHub login              (default: meta-bot-ship)
  PR_BOT_REPOS       comma-separated owner/repo    (required)
  PR_BOT_PROVIDER    openrouter | gemini           (default: openrouter)
  PR_BOT_MODEL       model id                      (default per provider)
  PR_BOT_STATE       state file path               (default: ~/.pr-review-bot/state.json)
  PR_BOT_MAX_DIFF    max diff bytes sent to LLM     (default: 120000)
  GH_TOKEN           gh auth for the bot account   (required)
  OPENROUTER_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY  (per provider)

Run once per invocation; schedule it (launchd/cron) for polling. --once is the
default; --loop N polls every N seconds in-process.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BOT_USER = os.environ.get("PR_BOT_USER", "meta-bot-ship")
REPOS = [r.strip() for r in os.environ.get("PR_BOT_REPOS", "").split(",") if r.strip()]
ENGINE = os.environ.get("PR_BOT_ENGINE", "codex").strip().lower()  # codex | llm
CODEX_EFFORT = os.environ.get("PR_BOT_CODEX_EFFORT", "xhigh")
WORKDIR = Path(os.environ.get("PR_BOT_WORKDIR", str(Path.home() / "pr-review-bot" / "repos")))
PROVIDER = os.environ.get("PR_BOT_PROVIDER", "openrouter").strip().lower()  # llm engine only
DEFAULT_MODEL = "google/gemini-2.5-pro" if PROVIDER == "openrouter" else "gemini-2.5-pro"
MODEL = os.environ.get("PR_BOT_MODEL", DEFAULT_MODEL)
STATE_FILE = Path(os.environ.get("PR_BOT_STATE", str(Path.home() / ".pr-review-bot" / "state.json")))
MAX_DIFF = int(os.environ.get("PR_BOT_MAX_DIFF", "120000"))

REVIEW_MARKER = "<!-- meta-bot-ship:pr-review -->"

SYSTEM_PROMPT = (
    "You are a meticulous senior software engineer reviewing a GitHub pull request. "
    "Review only the diff provided. Be concise and specific; cite file and approximate "
    "line. Prioritise correctness bugs, security issues, and data-loss risks; then note "
    "meaningful design/readability concerns. Do not restate the diff or praise. "
    "Format as markdown:\n"
    "  **Summary** — one or two sentences.\n"
    "  **Findings** — a bulleted list, each prefixed with a severity tag "
    "[P0]/[P1]/[P2]/[nit], file:line, and the issue. If none, say 'No blocking issues found.'\n"
    "  **Verdict** — one of: APPROVE / COMMENT / REQUEST_CHANGES."
)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def gh(args, check=True):
    """Run a gh command, return stdout (str). Inherits env (GH_TOKEN)."""
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and out.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.rename(STATE_FILE)


def find_prs(repo):
    """Open PRs in `repo` where the bot is a requested reviewer or is @-mentioned.
    Returns {number: {"headSha":..., "title":..., "reason":...}}."""
    found = {}
    for qualifier, reason in (("review-requested", "review-requested"), ("mentions", "mentioned")):
        try:
            raw = gh([
                "pr", "list", "--repo", repo, "--state", "open",
                "--search", f"{qualifier}:{BOT_USER}",
                "--json", "number,title,headRefOid",
                "--limit", "50",
            ])
        except RuntimeError as e:
            log(f"  {repo}: {qualifier} query failed: {e}")
            continue
        for pr in json.loads(raw or "[]"):
            num = pr["number"]
            if num not in found:
                found[num] = {"headSha": pr["headRefOid"], "title": pr["title"], "reason": reason}
    return found


def call_llm(prompt):
    if PROVIDER == "gemini":
        return _call_gemini(prompt)
    return _call_openrouter(prompt)


def _post_json(req, extract):
    delay = 2.0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return extract(json.loads(resp.read()))
        except urllib.error.HTTPError as e:
            if e.code in (408, 429, 500, 502, 503, 504) and attempt < 3:
                log(f"  LLM HTTP {e.code} — retry in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            raise RuntimeError(f"LLM HTTP {e.code}: {e.read().decode()[:200]}")
    raise RuntimeError("LLM retries exhausted")


def _call_openrouter(prompt):
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions", data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}",
                 "X-Title": "meta-bot-ship PR review"},
    )
    return _post_json(req, lambda d: d["choices"][0]["message"]["content"])


def _call_gemini(prompt):
    key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
    if not key:
        raise RuntimeError("GOOGLE_GENERATIVE_AI_API_KEY not set")
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
    }).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=payload, headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    return _post_json(req, lambda d: d["candidates"][0]["content"]["parts"][0]["text"])


def _repo_dir(repo):
    return WORKDIR / repo.replace("/", "__")


def _ensure_clone(repo):
    """Clone the repo once, then fetch. Returns the local checkout path."""
    d = _repo_dir(repo)
    if not (d / ".git").is_dir():
        d.parent.mkdir(parents=True, exist_ok=True)
        log(f"  cloning {repo} → {d}")
        subprocess.run(["gh", "repo", "clone", repo, str(d)], check=True, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(d), "fetch", "--prune", "origin"], check=False, capture_output=True, text=True)
    return d


def review_with_codex(repo, num):
    """Check out the PR into the local clone and run `codex review` at the
    configured effort against its base branch. Returns the review text."""
    d = _ensure_clone(repo)
    base = gh(["pr", "view", str(num), "--repo", repo, "--json", "baseRefName", "-q", ".baseRefName"]).strip() or "main"
    subprocess.run(["git", "-C", str(d), "fetch", "origin", base], check=False, capture_output=True, text=True)
    co = subprocess.run(["gh", "pr", "checkout", str(num), "--force"], cwd=str(d), capture_output=True, text=True)
    if co.returncode != 0:
        raise RuntimeError(f"gh pr checkout failed: {co.stderr.strip()}")
    proc = subprocess.run(
        ["codex", "review", "--base", f"origin/{base}", "-c", f'model_reasoning_effort="{CODEX_EFFORT}"'],
        cwd=str(d), capture_output=True, text=True, timeout=1800,
    )
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError(f"codex review produced no output (rc={proc.returncode}): {proc.stderr.strip()[:200]}")
    # codex cites absolute paths in the local clone; make them repo-relative.
    out = out.replace(str(d) + os.sep, "").replace(str(d), "")
    return out


def review_pr(repo, num, info):
    if ENGINE == "codex":
        review = review_with_codex(repo, num)
        engine_note = f"codex review (effort {CODEX_EFFORT})"
    else:
        diff = gh(["pr", "diff", str(num), "--repo", repo], check=False)
        if not diff.strip():
            log(f"  {repo}#{num}: empty diff, skipping")
            return False
        truncated = ""
        if len(diff) > MAX_DIFF:
            diff = diff[:MAX_DIFF]
            truncated = "\n\n[diff truncated for length]"
        prompt = f"PR title: {info['title']}\nRepo: {repo}\n\nUnified diff:\n```diff\n{diff}{truncated}\n```"
        review = call_llm(prompt).strip()
        engine_note = f"model {MODEL}"
    body = f"{REVIEW_MARKER}\n### 🤖 meta-bot-ship review\n\n{review}\n\n_{engine_note}. Re-reviews automatically on new commits._"
    # Post as a plain review comment (never auto-approve / block merges).
    proc = subprocess.run(
        ["gh", "pr", "review", str(num), "--repo", repo, "--comment", "--body", body],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        # Fall back to a normal PR comment if review submission is refused.
        subprocess.run(["gh", "pr", "comment", str(num), "--repo", repo, "--body", body],
                       capture_output=True, text=True)
    return True


def run_once():
    if not REPOS:
        log("PR_BOT_REPOS is empty — nothing to watch")
        return
    state = load_state()
    reviewed = 0
    for repo in REPOS:
        prs = find_prs(repo)
        for num, info in prs.items():
            key = f"{repo}#{num}"
            if state.get(key) == info["headSha"]:
                continue  # already reviewed this commit
            log(f"Reviewing {key} ({info['reason']}) @ {info['headSha'][:8]}")
            try:
                if review_pr(repo, num, info):
                    state[key] = info["headSha"]
                    save_state(state)
                    reviewed += 1
            except Exception as e:
                log(f"  {key}: review failed: {e}")
    log(f"Done — {reviewed} PR(s) reviewed this pass")


def main():
    parser = argparse.ArgumentParser(description="meta-bot-ship PR review bot")
    parser.add_argument("--loop", type=int, default=0, help="poll every N seconds (0 = run once)")
    args = parser.parse_args()
    engine_desc = f"codex/{CODEX_EFFORT}" if ENGINE == "codex" else f"llm:{PROVIDER}/{MODEL}"
    if args.loop > 0:
        log(f"PR review bot started (loop {args.loop}s) — bot={BOT_USER} repos={REPOS} engine={engine_desc}")
        while True:
            try:
                run_once()
            except Exception as e:
                log(f"pass error: {e}")
            time.sleep(args.loop)
    else:
        run_once()


if __name__ == "__main__":
    main()
