import assert from "node:assert/strict";
import { test } from "node:test";

import { closeLinearIssue } from "../src/linear.ts";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("closing a Linear issue selects its team's canceled workflow and waits for confirmation", async () => {
  const calls = [];
  const replies = [
    jsonResponse({
      issue: {
        id: "issue-uuid",
        identifier: "MET-700",
        state: { name: "In Review", type: "started" },
        team: { key: "MET" },
      },
    }),
    jsonResponse({
      workflowStates: {
        nodes: [
          { id: "abandoned", name: "Won't Do", type: "canceled", position: 2 },
          { id: "closed", name: "Closed", type: "canceled", position: 1 },
        ],
      },
    }),
    jsonResponse({ issueUpdate: { success: true, issue: { state: { name: "Closed", type: "canceled" } } } }),
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return replies.shift();
  };

  const result = await closeLinearIssue("issue-uuid", { apiKey: "linear-key", fetchImpl });

  assert.deepEqual(result, {
    issueId: "issue-uuid",
    identifier: "MET-700",
    stateName: "Closed",
    alreadyClosed: false,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].init.headers.Authorization, "linear-key");
  assert.deepEqual(calls[2].body.variables, { id: "issue-uuid", stateId: "closed" });
  assert.match(calls[2].body.query, /issueUpdate/);
});

test("an already canceled Linear issue is idempotent", async () => {
  let calls = 0;
  const result = await closeLinearIssue("issue-uuid", {
    apiKey: "linear-key",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        issue: {
          id: "issue-uuid",
          identifier: "MET-701",
          state: { name: "Canceled", type: "canceled" },
          team: { key: "MET" },
        },
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.alreadyClosed, true);
  assert.equal(result.stateName, "Canceled");
});

test("closing requires a Linear API key before making a request", async () => {
  let called = false;
  await assert.rejects(
    closeLinearIssue("issue-uuid", {
      apiKey: " ",
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    }),
    /LINEAR_API_KEY/,
  );
  assert.equal(called, false);
});
