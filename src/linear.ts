const LINEAR_API_URL = "https://api.linear.app/graphql";

type FetchLike = typeof fetch;

interface LinearGraphqlOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
}

interface LinearIssueForClosure {
  id: string;
  identifier?: string;
  state?: { name?: string; type?: string } | null;
  team?: { key?: string } | null;
}

export interface LinearClosureResult {
  issueId: string;
  identifier: string;
  stateName: string;
  alreadyClosed: boolean;
}

async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: LinearGraphqlOptions,
): Promise<T> {
  const apiKey = (options.apiKey ?? process.env.LINEAR_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("LINEAR_API_KEY is not configured");

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}`);
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message || "unknown GraphQL error").join("; "));
  }
  if (!payload.data) throw new Error("Linear API returned no data");
  return payload.data;
}

/** Move a linked Linear issue to its team's canceled/closed workflow state. */
export async function closeLinearIssue(
  issueId: string,
  options: LinearGraphqlOptions = {},
): Promise<LinearClosureResult> {
  const issueData = await linearGraphql<{ issue?: LinearIssueForClosure | null }>(`
    query IssueForClosure($id: String!) {
      issue(id: $id) { id identifier state { name type } team { key } }
    }
  `, { id: issueId }, options);
  const issue = issueData.issue;
  if (!issue) throw new Error("Linear issue was not found or is not accessible");

  const identifier = issue.identifier || issue.id;
  const currentType = String(issue.state?.type || "").toLowerCase();
  if (["canceled", "cancelled"].includes(currentType)) {
    return {
      issueId: issue.id,
      identifier,
      stateName: issue.state?.name || "Canceled",
      alreadyClosed: true,
    };
  }

  const teamKey = issue.team?.key?.trim();
  if (!teamKey) throw new Error(`Linear issue ${identifier} has no team`);
  const statesData = await linearGraphql<{
    workflowStates?: { nodes?: Array<{ id?: string; name?: string; type?: string; position?: number }> };
  }>(`
    query CanceledWorkflowStates($teamKey: String!) {
      workflowStates(filter: { team: { key: { eq: $teamKey } }, type: { eq: "canceled" } }) {
        nodes { id name type position }
      }
    }
  `, { teamKey }, options);
  const states = (statesData.workflowStates?.nodes || [])
    .filter((state): state is { id: string; name?: string; type?: string; position?: number } => Boolean(state.id));
  const preferredNames = ["canceled", "cancelled", "closed"];
  const target = preferredNames
    .map((name) => states.find((state) => state.name?.trim().toLowerCase() === name))
    .find(Boolean)
    ?? states.slice().sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER))[0];
  if (!target) throw new Error(`Linear team ${teamKey} has no canceled workflow state`);

  const updateData = await linearGraphql<{
    issueUpdate?: { success?: boolean; issue?: { state?: { name?: string; type?: string } | null } | null };
  }>(`
    mutation CloseIssue($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { state { name type } }
      }
    }
  `, { id: issue.id, stateId: target.id }, options);
  if (updateData.issueUpdate?.success !== true) {
    throw new Error(`Linear did not confirm closing ${identifier}`);
  }

  return {
    issueId: issue.id,
    identifier,
    stateName: updateData.issueUpdate.issue?.state?.name || target.name || "Canceled",
    alreadyClosed: false,
  };
}
