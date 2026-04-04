#!/Users/mm/.openclaw/venv-3.12/bin/python3
"""mc-explore: Scan a repo and extract architectural knowledge into context-fabrica."""

import argparse
import logging
import sys
from pathlib import Path

from mc_explore_common import (
    GITPROJECTS,
    build_file_tree,
    call_gemini,
    detect_monorepo,
    embed_text,
    get_gemini_key,
    git,
    identify_key_files,
    load_env,
    make_adapter,
    parse_gemini_json,
    read_key_files,
    store_fact,
    store_relations,
    walk_repo,
)

log = logging.getLogger("mc-explore")


def build_prompt(project: str, repo: str, tree: str, file_contents: dict, git_log: str, focus: str | None) -> str:
    files_block = ""
    for path, content in file_contents.items():
        files_block += f"\n--- {path} ---\n{content}\n"

    focus_instruction = ""
    if focus:
        focus_instruction = f"FOCUS: Pay special attention to: {focus}\n"

    return f"""You are analyzing the architecture of {project}/{repo}.

File tree:
{tree}

Key files:
{files_block}

Recent commits:
{git_log}

{focus_instruction}
Extract architectural knowledge as JSON:
{{
  "facts": [
    {{"text": "clear, reusable architectural fact", "category": "fact|decision|convention|gotcha", "importance": 1-5}}
  ],
  "relations": [
    {{"source": "EntityName", "relation": "DEPENDS_ON|OWNS|CALLS|IMPLEMENTS|USES|CONFIGURES", "target": "EntityName", "weight": 0.5-1.0}}
  ],
  "summary": "one paragraph architectural summary"
}}

Rules:
- Extract 5-15 facts that would help a developer new to this codebase
- Focus on: tech stack, key patterns, data flow, dependencies, gotchas
- Entity names should be service/module/component names (e.g., "odc-api", "BeePlugin", "map-ai")
- Do NOT include trivial facts (e.g., "uses JavaScript")
- Each fact should be self-contained and useful in isolation"""


def explore_target(
    target_dir: Path,
    project: str,
    repo: str,
    label: str,
    api_key: str,
    adapter,
    focus: str | None,
    dry_run: bool,
    trust: bool,
    verbose: bool,
) -> dict:
    """Explore a single target (repo root or package dir). Returns a report dict."""
    report = {"label": label, "summary": "", "facts_stored": 0, "facts_skipped": 0, "relations_stored": 0, "errors": []}

    # Walk files, build tree, identify + read key files
    log.info(f"Scanning {label}...")
    all_files = walk_repo(target_dir)
    tree = build_file_tree(target_dir, max_depth=3)
    key_files = identify_key_files(target_dir, all_files)
    file_contents = read_key_files(key_files)

    if verbose:
        log.info(f"  Files found: {len(all_files)}, key files: {len(key_files)}")

    # Recent git log
    git_log = git(target_dir, "log", "--oneline", "-10")

    # Build and send prompt
    prompt = build_prompt(project, repo, tree, file_contents, git_log, focus)

    if verbose:
        log.info(f"  Prompt length: {len(prompt)} chars")

    log.info(f"  Calling Gemini Flash...")
    response = call_gemini(prompt, api_key, max_tokens=8192)
    if not response:
        report["errors"].append("Gemini returned empty response")
        return report

    parsed = parse_gemini_json(response)
    if not parsed:
        report["errors"].append("Failed to parse Gemini JSON response")
        if verbose:
            log.warning(f"  Raw response: {response[:300]}")
        return report

    facts = parsed.get("facts", [])
    relations = parsed.get("relations", [])
    report["summary"] = parsed.get("summary", "")

    log.info(f"  Extracted {len(facts)} facts, {len(relations)} relations")

    if dry_run:
        print(f"\n  [DRY RUN] Would store {len(facts)} facts and {len(relations)} relations for {label}")
        for i, fact in enumerate(facts, 1):
            cat = fact.get("category", "fact")
            imp = fact.get("importance", 3)
            print(f"    {i}. [{cat}/imp={imp}] {fact.get('text', '')}")
        for rel in relations:
            print(f"    -> {rel.get('source')} --{rel.get('relation')}--> {rel.get('target')} (w={rel.get('weight', 1.0)})")
        report["facts_stored"] = len(facts)
        report["relations_stored"] = len(relations)
        return report

    # Store facts
    stored_record_ids = []
    for fact in facts:
        text = fact.get("text", "").strip()
        if not text:
            continue
        category = fact.get("category", "fact")
        importance = int(fact.get("importance", 3))

        if not trust and importance < 3:
            if verbose:
                log.info(f"  Skipping low-importance fact: {text[:60]}...")
            report["facts_skipped"] += 1
            continue

        try:
            embedding = embed_text(text, api_key)
        except Exception as e:
            log.warning(f"  Embedding failed for fact: {e}")
            report["errors"].append(f"Embedding error: {e}")
            continue

        extra = {"package": label} if label != f"{project}/{repo}" else None
        record_id = store_fact(
            adapter=adapter,
            text=text,
            embedding=embedding,
            project=project,
            repo=repo,
            category=category,
            importance=importance,
            source="mc-explore",
            stage="staged" if not trust else "active",
            extra_metadata=extra,
        )

        if record_id:
            stored_record_ids.append(record_id)
            report["facts_stored"] += 1
            if verbose:
                log.info(f"  Stored: {text[:60]}...")
        else:
            report["facts_skipped"] += 1
            if verbose:
                log.info(f"  Skipped (duplicate): {text[:60]}...")

    # Store relations for each stored fact
    if relations and stored_record_ids:
        # Attach all relations to the first stored record
        primary_id = stored_record_ids[0]
        try:
            count = store_relations(adapter, primary_id, relations)
            report["relations_stored"] = count
        except Exception as e:
            log.warning(f"  Relations storage failed: {e}")
            report["errors"].append(f"Relations error: {e}")

    return report


def main():
    parser = argparse.ArgumentParser(
        prog="mc-explore",
        description="Scan a repo and extract architectural knowledge into context-fabrica.",
    )
    parser.add_argument("repo", help="Repo path as project/repo (e.g., hivemapper/network)")
    parser.add_argument("--focus", help="Focus extraction on a specific area (e.g., 'API endpoints')")
    parser.add_argument("--package", help="For monorepos: scope to a single package name")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be stored without writing to DB")
    parser.add_argument("--trust", action="store_true", help="Store facts as 'active' (skip staging) and include low-importance facts")
    parser.add_argument("--verbose", action="store_true", help="Show detailed progress")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
    )

    # Parse repo arg
    parts = args.repo.strip("/").split("/")
    if len(parts) != 2:
        print(f"Error: repo must be in project/repo format (e.g., hivemapper/network), got: {args.repo}")
        sys.exit(1)
    project, repo = parts

    # Load env and validate
    load_env()
    api_key = get_gemini_key()
    if not api_key:
        print("Error: GOOGLE_GENERATIVE_AI_API_KEY not set")
        sys.exit(1)

    repo_dir = GITPROJECTS / project / repo
    if not repo_dir.is_dir():
        print(f"Error: repo not found at {repo_dir}")
        sys.exit(1)

    # Set up adapter (unless dry-run)
    adapter = None
    if not args.dry_run:
        try:
            adapter = make_adapter()
        except Exception as e:
            print(f"Error connecting to context-fabrica: {e}")
            sys.exit(1)

    # Detect monorepo
    packages = detect_monorepo(repo_dir)
    targets = []

    if packages:
        log.info(f"Detected monorepo with {len(packages)} packages")
        if args.package:
            matched = [p for p in packages if p["name"] == args.package]
            if not matched:
                available = ", ".join(p["name"] for p in packages)
                print(f"Error: package '{args.package}' not found. Available: {available}")
                sys.exit(1)
            targets = matched
        else:
            targets = packages
    else:
        if args.package:
            log.warning(f"--package specified but {project}/{repo} is not a monorepo; ignoring")
        targets = [{"name": repo, "path": repo_dir, "type": "repo"}]

    # Process each target
    reports = []
    for target in targets:
        target_dir = Path(target["path"])
        label = target["name"] if target["type"] != "repo" else f"{project}/{repo}"
        report = explore_target(
            target_dir=target_dir,
            project=project,
            repo=repo,
            label=label,
            api_key=api_key,
            adapter=adapter,
            focus=args.focus,
            dry_run=args.dry_run,
            trust=args.trust,
            verbose=args.verbose,
        )
        reports.append(report)

    # Print final report
    print("\n" + "=" * 60)
    print(f"mc-explore report: {project}/{repo}")
    print("=" * 60)

    total_stored = 0
    total_skipped = 0
    total_relations = 0

    for r in reports:
        print(f"\n  {r['label']}:")
        if r["summary"]:
            print(f"    Summary: {r['summary']}")
        print(f"    Facts: {r['facts_stored']} stored, {r['facts_skipped']} skipped")
        print(f"    Relations: {r['relations_stored']}")
        if r["errors"]:
            for err in r["errors"]:
                print(f"    Error: {err}")
        total_stored += r["facts_stored"]
        total_skipped += r["facts_skipped"]
        total_relations += r["relations_stored"]

    print(f"\n  TOTAL: {total_stored} facts stored, {total_skipped} skipped, {total_relations} relations")
    if args.dry_run:
        print("  (dry-run mode — nothing was written to the database)")
    elif args.trust:
        print("  (trust mode — facts stored as 'active')")
    print()


if __name__ == "__main__":
    main()
