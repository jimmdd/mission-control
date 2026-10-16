"""Remember task-scoped review consent; never infer it from a review verdict."""
import json

RECIPIENTS = ["greptile", "verified-codex"]
DATA_SCOPE = "intended-committed-branch-code-diff"
EXCLUSIONS = ["env-files", "secrets", "unrelated-private-data"]


def scope(task, entry=None):
    try:
        state = task.get("triage_state") or {}
        state = json.loads(state) if isinstance(state, str) else state
        repos = state.get("execution_target", {}).get("repos", [])
        if len(repos) != 1:
            return None, None
        repo = repos[0]
        context = {"taskId": task["id"], "project": repo["project"],
                   "repo": repo["repo"], "branch": (entry or {}).get("branch") or repo["branch"],
                   "baseRef": repo["base_branch"], "recipients": RECIPIENTS,
                   "dataScope": DATA_SCOPE, "exclusions": EXCLUSIONS}
        return state.get("review_authorization"), context
    except (ValueError, KeyError, TypeError, AttributeError):
        return None, None


def permits(record, context, decisions):
    if not isinstance(record, dict) or not isinstance(context, dict):
        return False
    if (record.get("version") != 1 or record.get("status") != "active"
            or record.get("autonomousReruns") is not True):
        return False
    # Changing task, branch, repository, recipients or reviewed data needs a new
    # explicit record. Head SHAs may advance through the authorized fix loop.
    for field in ("taskId", "project", "repo", "branch", "baseRef",
                  "recipients", "dataScope", "exclusions"):
        if record.get(field) != context.get(field) or not context.get(field):
            return False
    approval = record.get("approvalCheckpointId")
    return bool(approval and any(
        c.get("id") == approval and c.get("task_id") == context["taskId"]
        and c.get("status") == "approved" and str(c.get("response") or "").strip()
        for c in decisions if isinstance(c, dict)))


def authorized(task, decisions, entry=None):
    record, context = scope(task, entry)
    return permits(record, context, decisions)


def instructions(task, decisions, entry=None, project=None, repo=None):
    record, context = scope(task, entry)
    matches_repo = context and (project is None or context["project"] == project) and (repo is None or context["repo"] == repo)
    if not matches_repo or not permits(record, context, decisions):
        return ("Routine review iteration count is not permission to transmit code. "
                "Use existing explicit authorization; if recipient/data scope is missing or "
                "changed, request that concrete permission. Do not invent consent or waive findings.")
    return f"""Recorded review authorization: checkpoint {record['approvalCheckpointId']}.
Scope: task {context['taskId']}, {context['project']}/{context['repo']}, branch
{context['branch']} against {context['baseRef']}; existing Greptile and verified Codex;
intended committed branch code diff only. Exclude env files, secrets and unrelated private data.
Inspect the intended diff before each transmission; stop if excluded material cannot be omitted.
Continue investigate -> implement -> test -> review -> fix -> re-review automatically.
A review finding, missing QA, independent-lane gap or recoverable runner failure is
engineering work; complete its cause and rerun within this scope. An iteration count
alone must not create a human checkpoint. Do not repeat unchanged failures in a loop.
Wait for the existing review lease; never duplicate workers. Preserve all findings.
Every changed head/base requires fresh zero Greptile findings, an explicit Codex PASS,
and GSD verification before any already-authorized draft publication. This record
grants no new publication permission. Honor NO-PR mode, explicit holds, Nick's visual
approval and live provider/release gates. Changed recipients/data/task/repo/branch,
missing/revoked authorization, a denied action, a real product decision or a release
gate still blocks. Never weaken security/access, skip checks or infer PASS from confidence.
"""
