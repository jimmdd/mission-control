#!/usr/bin/env python3
"""Fail-closed PR delivery gate shared by the API and agent monitor.

Independent review receipts are local runtime evidence, bound to clean commits.
GitHub is always queried afresh; a URL, process exit, or old green run is not proof.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote


def evaluate(meta, receipt=None, threads=None):
    head, base = meta.get("headRefOid"), meta.get("baseRefOid")
    def result(status, reason):
        return {"status": status, "reason": reason, "head": head, "base": base, "baseRefName": meta.get("baseRefName")}
    if meta.get("state") == "MERGED":
        return result("pass", "PR is merged")
    if meta.get("state") != "OPEN" or not head or not base:
        return result("unknown", "Open PR and current head/base could not be verified")
    checks = meta.get("statusCheckRollup") or []
    if not checks:
        return result("pending", "No CI results have been reported for this head")
    reported = {c.get("name") or c.get("context") for c in checks}
    missing = set(meta.get("requiredChecks") or []) - reported
    if missing:
        return result("pending", "Required checks have not reported: " + ", ".join(sorted(missing)))
    for workflow in meta.get("workflowRuns") or []:
        if workflow.get("status") != "completed":
            return result("pending", "A current-head CI workflow has not finished creating/running its jobs")
        if workflow.get("conclusion") not in ("success", "skipped", "neutral"):
            return result("ci_failed", "A current-head CI workflow did not pass")
    successful = 0
    pending = False
    for check in checks:
        state = check.get("conclusion") if check.get("status") == "COMPLETED" else check.get("state")
        if state in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"):
            return result("ci_failed", "CI has failed, cancelled, or action-required checks")
        if state == "SUCCESS":
            successful += 1
        elif state not in ("SKIPPED", "NEUTRAL"):
            pending = True
    if pending or not successful:
        return result("pending", "CI is pending, unknown, or has no successful checks")
    if meta.get("reviewDecision") == "CHANGES_REQUESTED" or any(not t.get("isResolved") for t in threads or []):
        return result("review_blocked", "Resolve requested changes and open review threads")
    if not receipt or receipt.get("head") != head or receipt.get("base") != base or receipt.get("verdict") != "PASS":
        return result("review_required", "Independent PASS review is required for the current head and base")
    if not greptile_pass(receipt.get("greptile"), head, base):
        return result("review_required", "Completed local Greptile review without findings is required for the current head and base")
    return result("pass", "Current-head CI, Greptile and independent review passed; no unresolved review threads")


def greptile_pass(evidence, head, base):
    return (isinstance(evidence, dict) and evidence.get("head") == head
            and evidence.get("base") == base and evidence.get("status") == "COMPLETED"
            and evidence.get("verdict") == "PASS" and bool(evidence.get("runId"))
            and isinstance(evidence.get("review"), dict)
            and evidence["review"].get("comments") == [])


def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.PIPE, timeout=30).strip()


def receipt_dir():
    return Path(os.environ.get("MC_HOME", str(Path.home() / ".mission-control"))) / "swarm" / "pr-review-state"


def check(url):
    match = re.fullmatch(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)(?:[/?#].*)?", url)
    if not match:
        return {"status": "unknown", "reason": "Expected a GitHub pull request URL"}
    owner, repo, number = match.groups()
    try:
        meta = json.loads(run(["gh", "pr", "view", number, "--repo", f"{owner}/{repo}", "--json",
                               "state,headRefOid,baseRefOid,baseRefName,statusCheckRollup,reviewDecision"]))
        threads, cursor = [], None
        for _ in range(10):
            query = '''query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefOid baseRef{branchProtectionRule{requiredStatusCheckContexts}} reviewThreads(first:100,after:$cursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}'''
            args = ["gh", "api", "graphql", "-f", f"query={query}", "-f", f"owner={owner}", "-f", f"repo={repo}", "-F", f"number={number}"]
            if cursor:
                args += ["-f", f"cursor={cursor}"]
            pr = json.loads(run(args))["data"]["repository"]["pullRequest"]
            if any(pr.get(k) != meta.get(k) for k in ("headRefOid", "baseRefOid")):
                return {"status": "pending", "reason": "PR changed while checking; retry the new head"}
            protection = (pr.get("baseRef") or {}).get("branchProtectionRule") or {}
            meta["requiredChecks"] = protection.get("requiredStatusCheckContexts") or []
            connection = pr["reviewThreads"]
            threads.extend(connection["nodes"])
            if not connection["pageInfo"]["hasNextPage"]:
                break
            cursor = connection["pageInfo"]["endCursor"]
        else:
            return {"status": "unknown", "reason": "Review thread pagination exceeded the bounded inspection limit"}
        for page in range(1, 11):
            rules = json.loads(run(["gh", "api", f"repos/{owner}/{repo}/rules/branches/{quote(meta['baseRefName'], safe='')}?per_page=100&page={page}"]))
            for rule in rules:
                if rule.get("type") == "required_status_checks":
                    meta["requiredChecks"].extend(c["context"] for c in rule["parameters"]["required_status_checks"])
            if len(rules) < 100:
                break
        else:
            return {"status": "unknown", "reason": "Branch rule pagination exceeded inspection limit"}
        runs = json.loads(run(["gh", "run", "list", "--repo", f"{owner}/{repo}", "--commit", meta["headRefOid"], "--limit", "100", "--json", "status,conclusion,workflowDatabaseId,event"]))
        if len(runs) >= 100:
            return {"status": "unknown", "reason": "CI workflow history exceeded inspection limit"}
        # GitHub can report an early successful job before a downstream matrix
        # has created its checks. Keep waiting for the whole workflow run.
        latest = {}
        for workflow in runs:
            if workflow.get("event") in ("push", "pull_request", "pull_request_target", "merge_group"):
                if not workflow.get("workflowDatabaseId"):
                    return {"status": "unknown", "reason": "CI workflow identity could not be verified"}
                latest.setdefault((workflow["workflowDatabaseId"], workflow.get("event")), workflow)
        meta["workflowRuns"] = list(latest.values())
        current = json.loads(run(["gh", "pr", "view", number, "--repo", f"{owner}/{repo}", "--json", "headRefOid,baseRefOid"]))
        if any(current.get(k) != meta.get(k) for k in ("headRefOid", "baseRefOid")):
            return {"status": "pending", "reason": "PR changed during readiness checks; retry"}
        try:
            receipt = json.loads((receipt_dir() / f'{meta["headRefOid"]}.json').read_text())
        except (OSError, ValueError):
            receipt = None
        return evaluate(meta, receipt, threads)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError):
        return {"status": "unknown", "reason": "GitHub readiness lookup failed; retry instead of assuming success"}


def record(worktree, base, expected_head, expected_base, output, greptile_output):
    text = Path(output).read_text()
    # Never accept a stray LGTM, an echoed prompt, or a mixed FAIL/PASS response.
    verdicts = re.findall(r"^VERDICT: (PASS|FAIL|WARN)\b.*$", text, re.MULTILINE)
    if not verdicts or verdicts[-1] != "PASS" or "FAIL" in verdicts:
        raise ValueError("An explicit independent PASS verdict is required")
    head = run(["git", "rev-parse", "HEAD"], worktree)
    base_oid = run(["git", "rev-parse", base], worktree)
    if head != expected_head or base_oid != expected_base or run(["git", "status", "--porcelain"], worktree):
        raise ValueError("Commit all changes and rerun review; the reviewed worktree/head/base must stay clean and unchanged")
    greptile = json.loads(Path(greptile_output).read_text())
    if not greptile_pass(greptile, head, base_oid):
        raise ValueError("A completed local Greptile review without findings is required")
    root = receipt_dir()
    root.mkdir(parents=True, exist_ok=True)
    payload = {"head": head, "base": base_oid, "verdict": "PASS", "review": text, "greptile": greptile}
    temp = root / f".{head}.{os.getpid()}.tmp"
    temp.write_text(json.dumps(payload))
    temp.replace(root / f"{head}.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    check_parser = sub.add_parser("check")
    check_parser.add_argument("url")
    record_parser = sub.add_parser("record")
    for name in ("worktree", "base", "head", "base_oid", "output", "greptile_output"):
        record_parser.add_argument(name)
    args = parser.parse_args()
    if args.command == "check":
        print(json.dumps(check(args.url)))
    else:
        try:
            record(args.worktree, args.base, args.head, args.base_oid, args.output, args.greptile_output)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
