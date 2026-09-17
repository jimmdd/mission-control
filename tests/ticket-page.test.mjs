// The ticket page is one ticket end to end: brief, what triage found, the open
// questions, the plan. The plan and its per-step progress are still written to disk
// by the Python planner, so the page reads them through /api/tasks/:id/plan.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";

const SILENT = { info() {}, error() {} };

function mockReq({ url, method = "GET", headers = {}, body }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.url = url;
  stream.method = method;
  stream.headers = { host: "localhost", ...headers };
  return stream;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(c) { this.statusCode = c; },
    end(b) { this.body = b ?? ""; },
  };
}

/** A handler backed by a scratch MC_HOME so plan files can be planted on disk. */
async function withHandler(fn, dependencies = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-ticket-"));
  const priorHome = process.env.MC_HOME;
  process.env.MC_HOME = dir;
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    return await fn(createHandler(db, SILENT, undefined, dependencies), db, dir);
  } finally {
    db.close();
    if (priorHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = priorHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(handler, url) {
  const res = mockRes();
  await handler(mockReq({ url }), res);
  return res;
}

function plantPlan(home, taskId, plan, progress) {
  for (const [kind, data] of [["plans", plan], ["progress", progress]]) {
    if (!data) continue;
    mkdirSync(join(home, "bridge", kind), { recursive: true });
    writeFileSync(join(home, "bridge", kind, `${taskId}.json`), JSON.stringify(data));
  }
}

test("the ticket page is served and carries no external requests", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  // The page must render with the server offline from any CDN — no remote fonts,
  // scripts, or stylesheets, matching the rest of public/.
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /https?:\/\/fonts\./i);
  assert.match(html, /\/api\/tasks\//);
  assert.match(html, /\/checkpoints/, "the ticket must load actionable checkpoints");
});

test("GET /ticket returns the page", async () => {
  await withHandler(async handler => {
    const res = await call(handler, "/ticket?id=abc");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["Content-Type"], /text\/html/);
    assert.match(res.body, /Answer these to start|id="root"/);
  });
});

test("the plan endpoint returns the plan and its progress together", async () => {
  await withHandler(async (handler, db, home) => {
    const task = db.createTask({ title: "brand work" });
    plantPlan(home, task.id,
      { steps: [{ step: 1, title: "tokens", verify_command: "bun test" }], parallel_groups: [[1]] },
      { steps: { "1": { status: "in_progress" } } });

    const res = await call(handler, `/api/tasks/${task.id}/plan`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.plan.steps[0].title, "tokens");
    assert.equal(body.progress.steps["1"].status, "in_progress");
  });
});

test("a task with no plan yet returns nulls, not an error", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "not planned" });
    const res = await call(handler, `/api/tasks/${task.id}/plan`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { plan: null, progress: null });
  });
});

test("the plan endpoint refuses to walk out of the plans directory", async () => {
  await withHandler(async (handler, _db, home) => {
    // Plant a file one level up that a traversal would reach.
    mkdirSync(join(home, "bridge"), { recursive: true });
    writeFileSync(join(home, "bridge", "secret.json"), JSON.stringify({ leaked: true }));

    for (const id of ["..%2Fsecret", "..%2F..%2Fetc%2Fpasswd", "a%2F..%2Fsecret"]) {
      const res = await call(handler, `/api/tasks/${id}/plan`);
      const body = JSON.parse(res.body);
      assert.equal(body.plan, null, `${id} must not resolve to a file`);
      assert.ok(!res.body.includes("leaked"), `${id} leaked file contents`);
    }
  });
});

test("the dashboard routes to the ticket page from both the card and the drawer", () => {
  // The page shipped once with no route to it at all — reachable only by typing the
  // URL. Both entry points are asserted because the card is the one people actually use.
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(appJs, /\/ticket\?id=\$\{encodeURIComponent\(task\.id\)\}/,
    "cards must link to the ticket page");
  assert.match(appJs, /TICKET/, "the card link needs a visible label");
  // Without stopPropagation the click toggles the card instead of following the link.
  assert.match(appJs, /TICKET[^`]*|onclick="event\.stopPropagation\(\)"/);
  assert.match(indexHtml, /id="drawer-ticket-link"/, "the drawer must link out too");
});

test("child processes never become standalone task cards when their parent is hidden", () => {
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appJs.indexOf("const getProcessedTasks = () => {");
  const end = appJs.indexOf("\n        const renderTasks = () => {", start);
  assert.ok(start >= 0 && end > start, "getProcessedTasks must remain extractable for regression coverage");

  const getProcessedTasks = new Function(
    "state",
    "STATUSES",
    "PRIORITIES",
    `${appJs.slice(start, end)}\nreturn getProcessedTasks;`,
  )(
    {
      filter: "all",
      showDoneCards: false,
      showClosedCards: false,
      sort: "newest",
      tasks: [
        { id: "parent", title: "MET-645", status: "done", created_at: "2026-08-20T17:00:00Z" },
        {
          id: "child",
          title: "MET-645 — wrong repo",
          status: "on_hold",
          parent_task_id: "parent",
          created_at: "2026-08-20T18:00:00Z",
        },
      ],
    },
    ["inbox", "planning", "in_progress", "assigned", "review", "on_hold", "done", "failed"],
    { low: 1, normal: 2, high: 3, urgent: 4 },
  );

  assert.deepEqual(getProcessedTasks(), [], "a child must not replace its filtered-out parent card");
});

test("visible parent cards retain their child process context regardless of child status", () => {
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appJs.indexOf("const getProcessedTasks = () => {");
  const end = appJs.indexOf("\n        const renderTasks = () => {", start);
  const state = {
    filter: "review",
    showDoneCards: false,
    showClosedCards: false,
    sort: "newest",
    tasks: [
      { id: "parent", title: "MET-645", status: "review", created_at: "2026-08-20T17:00:00Z" },
      {
        id: "child",
        title: "MET-645 — backend",
        status: "done",
        parent_task_id: "parent",
        created_at: "2026-08-20T18:00:00Z",
      },
    ],
  };
  const getProcessedTasks = new Function(
    "state",
    "STATUSES",
    "PRIORITIES",
    `${appJs.slice(start, end)}\nreturn getProcessedTasks;`,
  )(state, ["inbox", "planning", "in_progress", "assigned", "review", "on_hold", "done", "failed"], {
    low: 1, normal: 2, high: 3, urgent: 4,
  });

  const cards = getProcessedTasks();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "parent");
  assert.deepEqual(cards[0].children.map(child => child.id), ["child"]);
});

test("dashboard treats closed as a separate hidden archive from done", () => {
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appJs.indexOf("const getProcessedTasks = () => {");
  const end = appJs.indexOf("\n        const renderTasks = () => {", start);
  const state = {
    filter: "all",
    showDoneCards: true,
    showClosedCards: false,
    sort: "newest",
    tasks: [
      { id: "done", title: "Completed", status: "done", created_at: "2026-08-20T17:00:00Z" },
      { id: "closed", title: "Archived", status: "closed", created_at: "2026-08-20T18:00:00Z" },
    ],
  };
  const getProcessedTasks = new Function(
    "state",
    "STATUSES",
    "PRIORITIES",
    `${appJs.slice(start, end)}\nreturn getProcessedTasks;`,
  )(state, ["inbox", "planning", "in_progress", "assigned", "review", "on_hold", "done", "closed", "failed"], {
    low: 1, normal: 2, high: 3, urgent: 4,
  });

  assert.deepEqual(getProcessedTasks().map(task => task.id), ["done"]);
  state.showDoneCards = false;
  state.showClosedCards = true;
  assert.deepEqual(getProcessedTasks().map(task => task.id), ["closed"]);
  assert.match(appJs, /\{ id: 'closed', label: 'CLOSED' \}/);
});

// The plan graph is built client-side, so serving the page proves nothing about it.
// This extracts the page's own script and renders the map headlessly against a real
// plan shape — the earlier version shipped as flat cards with no edges at all.
test("the plan map draws steps, decisions and their dependency edges", async () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  // Cut at the bootstrap marker: the render helpers above it are pure, everything
  // below touches the live DOM. A string-replace of "load();" hits the call inside
  // the click handler instead, leaving the page bootstrap to run under the test.
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];

  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  const mod = new Function(`${shim}\n${body}\nreturn { planMap };`)();

  const plan = {
    steps: [
      { step: 1, title: "tokens", verify_command: "bun test && bun build" },
      { step: 2, title: "apply", depends_on: [1] },
      { step: 3, title: "page", depends_on: [1] },
      { step: 4, title: "verify", depends_on: [2, 3] },
    ],
    parallel_groups: [[1], [2, 3], [4]],
  };
  const triage = { questions: [{ id: "q1", question: "Which app?", answer: "apps/new-ui" }] };
  const svg = mod.planMap(plan, { steps: { "2": { status: "in_progress" } } }, triage);

  assert.equal((svg.match(/class="stepg/g) || []).length, 4, "one node per step");
  // `flow`, `flow done` or `flow run` — the edge takes the state of the step it leads
  // into, so the travelled part of the route reads green and the live part pulses.
  assert.equal((svg.match(/class="flow[ "]/g) || []).length, 4, "one edge per declared dependency");
  assert.match(svg, /class="flow run"/, "the edge into a running step is marked live");
  assert.match(svg, /class="dec set"/, "an answered decision renders as locked");
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, "the map needs a viewBox to scale");
  // A verify_command is the gate; it belongs on the node, not hidden in a tooltip only.
  assert.match(svg, /class="ctext"/);
});

test("open decisions mark the work provisional rather than settled", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  // Cut at the bootstrap marker: the render helpers above it are pure, everything
  // below touches the live DOM. A string-replace of "load();" hits the call inside
  // the click handler instead, leaving the page bootstrap to run under the test.
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  const mod = new Function(`${shim}\n${body}\nreturn { planMap };`)();

  const plan = { steps: [{ step: 1, title: "a" }], parallel_groups: [[1]] };
  const openSvg = mod.planMap(plan, {}, { questions: [{ id: "q", question: "?", answer: null }] });
  assert.match(openSvg, /class="dec open"/);
  assert.match(openSvg, /ghost/, "work under an open decision is drawn as provisional");
});

test("clicking a node yields full detail, since the node itself is truncated", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  const mod = new Function(`${shim}\n${body}\nreturn { stepDetail, planMap };`)();

  const plan = { steps: [{
    step: 1,
    title: "A title long enough that the node has to truncate it somewhere",
    description: "The full description that never fits in a 208px box",
    acceptance_criteria: ["first criterion", "second criterion"],
    verify_command: "bun install && bun run check && bun run build",
    repo: "org/repo",
  }] };
  const progress = { steps: { "1": {
    status: "blocked", agent_profile: "codex", gsd_ran: false,
    gsd_reason: "no .planning/ — the GSD workflow never ran",
    outcome: "verify_command fails on unmodified code",
  } } };

  const d = mod.stepDetail(plan, progress, 1);
  // Everything the node abbreviates must be recoverable here, untruncated.
  assert.match(d, /A title long enough that the node has to truncate it somewhere/);
  assert.match(d, /The full description that never fits/);
  assert.match(d, /first criterion/);
  assert.match(d, /second criterion/);
  // The command is HTML-escaped on the way in (&& becomes &amp;&amp;), so assert on
  // the parts rather than the raw shell text.
  assert.match(d, /bun install/);
  assert.match(d, /bun run build/);
  assert.match(d, /&amp;&amp;/, "shell operators must be escaped, not injected as markup");
  assert.match(d, /codex/);
  assert.match(d, /no \.planning/);

  // The "no GSD" mark is an edge stripe now: right-aligned text collided with the title.
  const svg = mod.planMap(plan, progress, { questions: [] });
  assert.match(svg, /class="nogsd-edge"/);
  assert.doesNotMatch(svg, /no GSD<\/text>/);
});

test("the board flags a task whose planning is blocked, at any status", () => {
  // The existing triage indicator only renders while status === 'planning', which is
  // exactly when planner follow-ups have not been raised yet. Without a second badge a
  // blocked spec is invisible from the board.
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appJs, /PLANNING BLOCKED/);
  assert.match(appJs, /q\.source === 'planner'/,
    "the badge must key off planner questions, not any unanswered question");
  assert.doesNotMatch(
    appJs.slice(appJs.indexOf("let followUpBadge"), appJs.indexOf("let needsHumanBadge")),
    /task\.status === 'planning'/,
    "the badge must not be gated on the planning status");
  // Malformed state on one task must not take down the whole board.
  assert.match(appJs, /malformed triage_state must not break the board/);
});

test("the canvas grows to fit its decisions instead of clipping them", () => {
  // Height was reserved at (DEC_H + 12) per decision while layout placed them
  // (DEC_H + GAP_Y) apart, so the column overflowed top and bottom as answers piled up.
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  const mod = new Function(`${shim}\n${body}\nreturn { planMap };`)();

  const plan = { steps: [{ step: 1, title: "one" }], parallel_groups: [[1]] };
  const many = { questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: `Q${i}`, answer: `A${i}` })) };
  const svg = mod.planMap(plan, {}, many);

  const height = Number(/viewBox="0 0 \d+ (\d+)"/.exec(svg)[1]);
  const ys = [...svg.matchAll(/<rect[^>]*y="(\d+)"[^>]*height="(\d+)"/g)]
    .map(m => Number(m[1]) + Number(m[2]));
  assert.ok(Math.max(...ys) <= height, `a node ends at ${Math.max(...ys)} beyond canvas ${height}`);
  const tops = [...svg.matchAll(/<rect[^>]*y="(-?\d+)"/g)].map(m => Number(m[1]));
  assert.ok(Math.min(...tops) >= 0, "no node may start above the canvas");

  // Every decision is drawn — a placeholder saying "+N more" explained nothing.
  assert.equal((svg.match(/class="dec /g) || []).length, 9);
});

// ─────────── the question endpoints ───────────

/** POST an action to one question and return the parsed response. */
async function act(handler, taskId, qid, action, body) {
  const res = mockRes();
  await handler(mockReq({
    url: `/api/tasks/${taskId}/questions/${qid}/${action}`,
    method: "POST",
    body: body ?? {},
  }), res);
  return res;
}

const seedQuestions = (db, task) => db.replaceTriageState(task.id, {
  questions: [{ id: "q1", question: "Which font licence?", source: "planner" }],
});

test("asking back appends to the thread rather than answering", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "fonts" });
    seedQuestions(db, task);

    const res = await act(handler, task.id, "q1", "ask", { text: "what are the options?" });
    assert.equal(res.statusCode, 200);
    const q = JSON.parse(res.body).triage_state.questions[0];
    assert.equal(q.thread.length, 1);
    assert.equal(q.thread[0].role, "you");
    assert.equal(q.answer, undefined, "asking is not answering");
  });
});

test("an empty ask is refused rather than stored", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "fonts" });
    seedQuestions(db, task);
    const res = await act(handler, task.id, "q1", "ask", { text: "   " });
    assert.equal(res.statusCode, 400);
  });
});

test("delegating and deferring are mutually exclusive", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "fonts" });
    seedQuestions(db, task);

    let q = JSON.parse((await act(handler, task.id, "q1", "delegate")).body).triage_state.questions[0];
    assert.equal(q.delegate_requested, true);
    assert.equal(q.deferred, false);

    await act(handler, task.id, "q1", "delegate");
    assert.equal(db.listActivities(task.id).filter(a => a.activity_type === "question_delegated").length, 1,
      "a stale double-click must not create repeated handoff events");

    q = JSON.parse((await act(handler, task.id, "q1", "defer")).body).triage_state.questions[0];
    assert.equal(q.deferred, true);
    assert.equal(q.delegate_requested, false, "deferring cancels the handover");
  });
});

test("reopening clears the answer and the deferral, and keeps the reasoning", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "fonts" });
    db.replaceTriageState(task.id, {
      questions: [{
        id: "q1", question: "Page size?", answer: "50",
        answered_by: "agent", reason: "easiest to reverse", deferred: true,
      }],
    });

    const q = JSON.parse((await act(handler, task.id, "q1", "reopen")).body).triage_state.questions[0];
    assert.equal(q.answer, null);
    assert.equal(q.deferred, false, "bringing it back is the same edit");
    // Whoever overrides the pick should be able to read why it was made.
    assert.equal(q.reason, "easiest to reverse");
  });
});

test("an unknown action or question is refused, not silently applied", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "fonts" });
    seedQuestions(db, task);
    assert.equal((await act(handler, task.id, "q1", "destroy")).statusCode, 400);
    assert.equal((await act(handler, task.id, "nope", "defer")).statusCode, 404);
  });
});

test("each action leaves a trace on the ticket", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "fonts" });
    seedQuestions(db, task);
    await act(handler, task.id, "q1", "ask", { text: "what changes?" });
    await act(handler, task.id, "q1", "delegate");

    const types = db.listActivities(task.id).map(a => a.activity_type);
    // A dedicated type so the bridge can see a reply is owed.
    assert.ok(types.includes("question_asked"), types.join(","));
    assert.ok(types.includes("question_delegated"), types.join(","));
  });
});

test("resetting triage archives the plan, so a kicked-back ticket is not still planned", async () => {
  await withHandler(async (handler, db, home) => {
    const task = db.createTask({ title: "brand work" });
    plantPlan(home, task.id,
      { steps: [{ step: 1, title: "tokens" }] },
      { status: "in_progress", steps: { "1": { status: "blocked" }, "2": { status: "pending" } } });

    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/reset-triage`, method: "POST", body: {} }), res);
    assert.equal(res.statusCode, 200);

    // The page must not show a plan from the run that was just discarded.
    const after = JSON.parse((await call(handler, `/api/tasks/${task.id}/plan`)).body);
    assert.equal(after.plan, null);
    // And the daemon must not find a progress file still claiming in_progress with
    // pending steps — that is enough for it to dispatch agents against a plan for a
    // ticket sitting in the inbox being re-triaged.
    assert.equal(after.progress, null);

    // Archived, not destroyed: the reset keeps activity history for the same reason.
    const archived = readdirSync(join(home, "bridge", "archive", "plans"));
    assert.equal(archived.length, 1);
    assert.match(archived[0], new RegExp(`^${task.id}\\.`));
    assert.match(JSON.parse(readFileSync(join(home, "bridge", "archive", "plans", archived[0]), "utf8")).steps[0].title, /tokens/);
  });
});

test("resetting triage stops and archives the detached planning run", async () => {
  await withHandler(async (handler, db, home) => {
    const task = db.createTask({ title: "restart planning" });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const jobDir = join(home, "bridge", "plan-stage");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, `${task.id}.job.json`), JSON.stringify({
      state: "running",
      pid: child.pid,
      task: { id: task.id },
    }));

    try {
      const res = mockRes();
      await handler(mockReq({ url: `/api/tasks/${task.id}/reset-triage`, method: "POST", body: {} }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(!existsSync(join(jobDir, `${task.id}.job.json`)), "the stale live receipt is gone");
      assert.equal(readdirSync(join(home, "bridge", "archive", "plan-stage")).length, 1);

      await new Promise(resolve => setTimeout(resolve, 100));
      assert.throws(() => process.kill(child.pid, 0), err => err?.code === "ESRCH");
      assert.match(db.listActivities(task.id)[0].message, /active planning run was stopped/i);
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  });
});

test("resetting a task that was never planned is not an error", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "never planned" });
    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/reset-triage`, method: "POST", body: {} }), res);
    assert.equal(res.statusCode, 200);
  });
});

test("resetting a review task closes its PR and records that it can be reused", async () => {
  const seen = [];
  const prUrl = "https://github.com/acme/backend/pull/42";
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "MET-42 revise it", status: "review" });
    db.createDeliverable({ task_id: task.id, deliverable_type: "pr", title: "PR #42", path: prUrl });
    const staleCheckpoint = db.createCheckpoint({
      task_id: task.id,
      kind: "choice",
      prompt: "What should happen to the old PR?",
    });

    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/reset-triage`, method: "POST", body: {} }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "inbox");
    assert.deepEqual(seen, [prUrl]);
    assert.equal(db.getCheckpoint(staleCheckpoint.id).status, "cancelled");
    assert.equal(db.countPendingCheckpoints(task.id), 0);

    const reset = db.listActivities(task.id).find(activity => activity.activity_type === "triage_reset");
    assert.ok(reset);
    assert.match(reset.message, /same PR will be reopened/i);
    assert.deepEqual(JSON.parse(reset.metadata), {
      pr_url: prUrl,
      pr_state: "CLOSED",
      pr_disposition: "reuse_if_same_repo",
    });
  }, {
    resetPullRequest: async url => {
      seen.push(url);
      return { url, state: "CLOSED", closed: true };
    },
  });
});

test("a reset fails closed when GitHub cannot close the review PR", async () => {
  const prUrl = "https://github.com/acme/backend/pull/43";
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "MET-43 keep review intact", status: "review" });
    db.replaceTriageState(task.id, { confirmed: true, questions: [] });
    db.createDeliverable({ task_id: task.id, deliverable_type: "pr", title: "PR #43", path: prUrl });

    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/reset-triage`, method: "POST", body: {} }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(db.getTask(task.id).status, "review");
    assert.equal(db.getTriageState(task.id).confirmed, true);
    assert.match(JSON.parse(res.body).error, /could not be closed/i);
    assert.equal(db.listActivities(task.id).some(activity => activity.activity_type === "triage_reset"), false);
  }, {
    resetPullRequest: async () => { throw new Error("not authenticated"); },
  });
});

// ─────────── the conversation surface ───────────
// The card layout put a text box on every question down a list that re-rendered on
// a timer, and buried the actual conversation inside whichever card was open. The
// agent has one surface now: everything asked, everything said back, everything
// decided, in one stream — with the durable record beside it, because "what is
// settled and what is blocking" is exactly what a transcript is worst at.

function convoHelpers() {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  return new Function(`${shim}\n${body}\nreturn { renderConversation, chatTimeline, activeQuestion, blockingQuestions };`)();
}

const CONVO = [
  { id: "p1", source: "planner", becomes: "D-01",
    question: "Which Aktiv Grotesk licence covers the web build?",
    why: "Adobe forbids self-hosting; Host & Link permits it.",
    options: ["Host & Link", "Adobe Web Project"],
    thread: [
      { role: "you", text: "what changes between them?", at: "2026-08-13T01:00:00Z" },
      { role: "research", text: "Self-hosting means files in static/fonts plus a CORP header.", at: "2026-08-13T01:01:00Z" },
    ] },
  { id: "t1", becomes: "D-03", question: "Default page size?", answer: "50",
    answered_by: "agent", reason: "the list renders 20 and prefetches one page ahead",
    answered_at: "2026-08-13T00:30:00Z" },
  { id: "t2", becomes: "D-04", question: "Rate-limit now?", deferred: true },
];

test("pending checkpoints replace the idle composer with resolvable actions", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [] }, null, {
    checkpoints: [{
      id: "cp-focus-ring",
      kind: "choice",
      prompt: "Choose the focus-ring treatment",
      options: JSON.stringify(["Inverse ring", "Plain outline", "Accept as-is"]),
      status: "pending",
    }],
  });

  assert.match(out, /Your input is needed/);
  assert.match(out, /Choose the focus-ring treatment/);
  assert.match(out, /Choose an option or write the answer the agent needs/);
  assert.match(out, /placeholder="Write your answer…"/);
  assert.match(out, />Submit answer</);
  assert.match(out, /data-checkpoint="cp-focus-ring"/);
  assert.match(out, /data-cp-response="Plain outline"/);
  assert.match(out, /data-cp-submit/);
  assert.doesNotMatch(out, /Nothing is waiting on you/);
});

test("everything the agent asked and everything said back is one stream", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: CONVO }, null);

  assert.match(out, /Which Aktiv Grotesk licence/);
  assert.match(out, /Adobe forbids self-hosting/, "why it is asked travels with the question");
  assert.match(out, /what changes between them/, "your message is in the same stream");
  assert.match(out, /CORP header/, "and so is the reply");
  assert.match(out, /Recorded as <b>D-03<\/b>/, "so is a decision the agent made");
  assert.match(out, /set aside — not blocking planning/, "and one you set aside");
  // One composer for the whole conversation, not one box per question.
  assert.equal((out.match(/class="composer/g) || []).length, 1);
  assert.equal((out.match(/id="say"/g) || []).length, 1);
});

test("the stream reads in the order things happened", () => {
  const { chatTimeline } = convoHelpers();
  const kinds = chatTimeline(CONVO).map(e => `${e.q.id}:${e.kind}`);
  // A question is asked before it is answered, and its thread sits between.
  assert.ok(kinds.indexOf("p1:asked") < kinds.indexOf("p1:said"));
  assert.ok(kinds.indexOf("t1:asked") < kinds.indexOf("t1:decided"));
  // Undated events must not leap to the front and scramble the reading order.
  assert.equal(kinds[0], "p1:asked");
});

test("the composer points at what is blocking, planner questions first", () => {
  const { activeQuestion } = convoHelpers();
  // Work is halted behind a planner question, so it leads.
  assert.equal(activeQuestion(CONVO, null).id, "p1");
  // Unless you pick another from the panel.
  assert.equal(activeQuestion(CONVO, "t2").id, "t2");
  // Answered and deferred ones are not waiting on anyone.
  assert.equal(activeQuestion([CONVO[1], CONVO[2]], null), null);
});

test("answering and chatting use separate fields and separate actions", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: CONVO }, null);
  // An option settles the question outright.
  assert.match(out, /data-answer="Host &amp; Link"/);
  // A free-text answer belongs to the live question and has one outcome.
  assert.match(out, /data-answer-box="p1"/);
  assert.match(out, /data-free="p1"/);
  assert.match(out, /data-submit-answer="p1"/);
  assert.match(out, />Submit answer</);
  // The footer composer only talks to the agent.
  assert.match(out, /data-send="ask"/);
  assert.doesNotMatch(out, /data-send="answer"/);
  assert.match(out, /Ask a follow-up about this question/);
  assert.match(out, /Messages here only continue the conversation/);
  assert.match(out, /placeholder="Ask a follow-up question…"/);
  assert.match(out, />Ask</);
  // Delegation stays with the question instead of masquerading as chat.
  assert.match(out, /data-act="delegate"/);
  assert.match(out, />Let the agent decide</);
  assert.doesNotMatch(out, />You decide</);
  assert.doesNotMatch(out, />Decide for me</);
});

test("the panel says what is settled and what is blocking, without scrolling", () => {
  const { renderConversation, blockingQuestions } = convoHelpers();
  const out = renderConversation({ questions: CONVO }, null);
  assert.match(out, /class="decisions"/);
  assert.match(out, /D-01/);
  assert.match(out, /D-03/);
  assert.match(out, /1<\/b> blocking planning/);
  assert.equal(blockingQuestions(CONVO).length, 1, "deferred and answered do not block");
  // Every question is reachable from the panel, so nothing is lost up the stream.
  assert.equal((out.match(/data-focus=/g) || []).length, CONVO.length);
});

test("with nothing open the composer stops asking for an answer", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [CONVO[1]] }, null);
  assert.doesNotMatch(out, /data-submit-answer/, "there is nothing to answer");
  // Nothing to answer is not nothing to do: the daemon will not dispatch until a
  // human confirms, so that is what the composer offers instead.
  assert.match(out, /data-act="confirm"/);

  const confirmed = renderConversation({ questions: [CONVO[1]], confirmed: true }, null);
  assert.match(confirmed, /Nothing is waiting on you/);
});

test("a pill is only highlighted when the agent actually recommended it", () => {
  // Cyan on the first option by position invents a recommendation nobody made, and
  // reads as a value already chosen on a question that is still open — six
  // questions each showing a selected-looking answer while nothing was settled.
  const { renderConversation } = convoHelpers();
  const plain = renderConversation({ questions: [
    { id: "a", becomes: "D-01", question: "Which licence?", options: ["Host & Link", "Adobe"] }] }, null);
  assert.doesNotMatch(plain, /class="cpill rec"/, "no recommendation in the data, none on screen");

  const withRec = renderConversation({ questions: [
    { id: "a", becomes: "D-01", question: "Which licence?", options: ["Host & Link", "Adobe"],
      recommended: "Adobe" }] }, null);
  assert.match(withRec, /class="cpill rec" data-answer="Adobe"/, "and it lands on the one named");
});

test("the stream asks one question, not all of them at once", () => {
  // Six questions stacked with their options is a form, not a conversation — and it
  // forced the composer to restate which one you were on, so the same question
  // appeared twice: full size in the stream and as a grey line by the box.
  const { renderConversation } = convoHelpers();
  const qs = [
    { id: "a", becomes: "D-01", question: "Which licence?", answer: "Host & Link", answered_by: "you" },
    { id: "b", becomes: "D-02", question: "Variable or static?", options: ["Variable"] },
    { id: "c", becomes: "D-03", question: "Rate limit?", options: ["Yes"] },
    { id: "d", becomes: "D-04", question: "Feature flag?", options: ["No"] },
  ];
  const out = renderConversation({ questions: qs }, null);

  assert.match(out, /Which licence\?/, "settled ones stay — they are the record");
  assert.match(out, /Variable or static\?/, "the one being answered is shown");
  assert.doesNotMatch(out, /Rate limit\?[\s\S]*data-answer/, "later ones are not asked yet");
  assert.doesNotMatch(out, /Feature flag\?[\s\S]*data-answer/);

  // The answer field says what it settles and is attached to the question itself.
  assert.match(out, /data-answer-box="b"/);
  assert.match(out, /<span>settles D-02<\/span>/);
  assert.match(out, /2 more after this/);
  // Exactly one askable question: only the live one carries pills. Settled ones
  // still hold their own question text inside their collapsed group, which is the
  // record, not a second thing to answer.
  assert.equal((out.match(/class="cpills"/g) || []).length, 1);
  assert.equal((out.match(/class="qanswer"/g) || []).length, 1);
  assert.match(out, /title="Variable or static\?"/, "the rail keeps the full text on hover");
});

test("the last question says so", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [
    { id: "a", becomes: "D-01", question: "Which licence?", options: ["Host & Link"] }] }, null);
  assert.match(out, /last one — planning starts when this is settled/);
});

test("what was said about a question stays with that question", () => {
  // Sorting on the timestamp first put every question at the front — they carry no
  // asked_at, and an empty string sorts before everything — so a reply you typed
  // trailed at the bottom, detached, looking like it came from nowhere.
  const { chatTimeline } = convoHelpers();
  const order = chatTimeline([
    { id: "q1", question: "Which repo?", answer: "the other one", answered_at: "2026-08-13T17:10:00Z",
      thread: [{ role: "you", text: "there should be a repo on metadao/backend", at: "2026-08-13T17:09:19Z" },
               { role: "research", text: "then pick the separate repo", at: "2026-08-13T17:09:36Z" }] },
    { id: "q2", question: "Which font?" },
  ]).map(e => `${e.q.id}:${e.kind}`);

  assert.deepEqual(order, [
    "q1:asked", "q1:said", "q1:said", "q1:decided", "q2:asked",
  ]);
});

test("a settled question collapses to one line but keeps its exchange", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [
    { id: "q1", becomes: "D-01", question: "Which repo?", answer: "the separate one",
      answered_by: "you", answered_at: "2026-08-13T17:10:00Z",
      thread: [{ role: "you", text: "there should be a repo on metadao/backend", at: "2026-08-13T17:09:19Z" },
               { role: "research", text: "then pick the separate repo", at: "2026-08-13T17:09:36Z" }] },
    { id: "q2", becomes: "D-02", question: "Which font?", options: ["Variable"] },
  ] }, null);

  // Collapsed: the outcome is on the summary line, so the record reads at a glance.
  assert.match(out, /<details class="csettled">/);
  assert.match(out, /class="cs-a">the separate one/);
  assert.match(out, /2 messages/);
  // But nothing is thrown away — the exchange is inside.
  assert.match(out, /there should be a repo on metadao\/backend/);
  // The live question is not collapsed.
  assert.doesNotMatch(out.split("Which font?")[1] || "", /csettled/);
  assert.equal((out.match(/<details class="csettled">/g) || []).length, 1);
});

test("a question shows the decision id its answer will bind", () => {
  // Without it, the receipt underneath says "Recorded as D-02" and nothing on
  // screen ever said which question D-02 was.
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [
    { id: "q2", becomes: "D-02", question: "Which font?", options: ["Variable"] }] }, null);
  assert.match(out, /class="cbecomes">becomes D-02</);
});

test("a research reply says which model produced it", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [{ id: "q1", becomes: "D-01", question: "Which repo?",
    thread: [{ role: "research", text: "pick the separate repo", model: "claude-opus-5", at: "1" }] }] }, null);
  assert.match(out, /research · claude-opus-5/, "an answer can be weighed, not just read");
});

test("a suggestion from research is labelled as a suggestion", () => {
  // A bare cyan pill says "the agent recommends this" without saying who or that
  // it is still yours to decide.
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [{ id: "q1", becomes: "D-01", question: "Which repo?",
    options: ["separate repo", "same repo"], recommended: "separate repo" }] }, null);
  assert.match(out, /research suggests <b>separate repo<\/b> — still your call/);
  assert.match(out, /class="cpill rec" data-answer="separate repo"/);
});

test("the rail names what is being decided, not the whole question", () => {
  // MET-635's questions run to 511 characters. Truncating one lands mid-parenthesis,
  // so triage writes a short summary and the fallback keeps the opening words
  // rather than pretending to summarise.
  const { renderConversation } = convoHelpers();
  const long = "The ticket names target app `apps/new-ui` (SvelteKit) living only on branch "
    + "`coda/new-ui`, but the only frontend repo in the manifest is `metadao/metadao-frontend-v2`, "
    + "whose visible structure doesn't match. Is it a new workspace, or a different repo?";

  const written = renderConversation({ questions: [
    { id: "a", becomes: "D-01", question: long, summary: "target repo" }] }, null);
  assert.match(written, /class="dq2">target repo</);

  const fallback = renderConversation({ questions: [
    { id: "a", becomes: "D-01", question: long }] }, null);
  const label = /class="dq2">([^<]*)</.exec(fallback)[1];
  assert.ok(label.length <= 60, `rail label still long: ${label.length}`);
  assert.ok(label.endsWith("…"), "and says it was cut");
  assert.ok(!/\s$/.test(label.replace("…", "")), "cut on a word, not mid-word");
});

test("a very long question cannot push the composer off the screen", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  // It scrolls where it stands: nothing hidden, and the answer box stays reachable.
  assert.match(html, /\.cq \{[^}]*max-height: 30vh; overflow-y: auto;/s);
  assert.match(html, /\.cfind \.fb \{ max-height: 18vh; overflow-y: auto; \}/);
});

test("a settled question stops offering its options", () => {
  // Inside its collapsed group it was still rendering clickable pills — inviting you
  // to answer something already decided, with the receipt saying so directly below.
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [
    { id: "a", becomes: "D-01", question: "Which licence?", options: ["Host & Link", "Adobe"],
      answer: "Host & Link", answered_by: "you" },
    { id: "b", becomes: "D-02", question: "Which font?", options: ["Variable"] },
  ] }, null);
  assert.equal((out.match(/class="cpills"/g) || []).length, 1, "only the live question offers options");
  assert.doesNotMatch(out, /data-answer="Adobe"/, "the settled one offers nothing");
  assert.match(out, /data-answer="Variable"/);
});

test("a delegated question stays visible while the agent decides", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [{
    id: "a", becomes: "D-01", question: "Which fallback?", options: ["A", "B"],
    delegate_requested: true,
  }] }, null);
  assert.match(out, /Agent deciding…/);
  assert.match(out, /question stays open/);
  assert.doesNotMatch(out, /data-submit-answer/);
  assert.doesNotMatch(out, /Let the agent decide/);
});

test("an answer returned from delegation opens its receipt", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: [{
    id: "a", becomes: "D-01", question: "Which fallback?", answer: "A",
    answered_by: "agent", delegated_answer: true,
  }] }, null);
  assert.match(out, /<details class="csettled" open>/);
  assert.match(out, /A · chosen for you/);
});

// ─────────── the thread after triage settles (design 2c) ───────────
// The same thread keeps going: no new screen and no "submit". The plan arrives as
// a message, because that is when it arrives, and the decisions it was built from
// are three lines above it.

function threadHelpers() {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  return new Function(`${shim}\n${body}\nreturn { renderConversation, renderPlanCard, renderTicket, brief, runStatus, renderRail, renderNav };`)();
}

const SETTLED = [
  { id: "a", becomes: "D-01", question: "Which cursor column?", answer: "created_at",
    answered_by: "you", answered_at: "2026-08-13T17:12:00Z" },
  { id: "b", becomes: "D-02", question: "Default page size?", answer: "50",
    answered_by: "agent", reason: "the list renders 20", answered_at: "2026-08-13T17:10:00Z" },
];
const PLAN = {
  steps: [{ step: 1, title: "Cursor query in src/db.ts" }, { step: 2, title: "Endpoint accepts ?cursor" },
          { step: 3, title: "Board consumes pages" }, { step: 4, title: "Update board tests" }],
  parallel_groups: [[1, 2], [3, 4]],
};
const PROGRESS = { steps: { 1: { status: "completed" }, 2: { status: "completed" },
                            3: { status: "in_progress" }, 4: { status: "pending" } } };

test("with the questions settled the thread marks the moment and keeps going", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED }, null, { plan: PLAN, progress: PROGRESS });
  assert.match(out, /TRIAGE SETTLED/, "the rule says where triage ended");
  assert.match(out, /class="pcard"/, "and the plan lands under it, in the same stream");
  // Nothing is waiting, so the composer reports rather than asks.
  assert.doesNotMatch(out, /data-send="answer"/);
  const confirmed = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { plan: PLAN, progress: PROGRESS });
  assert.match(confirmed, /Nothing is waiting on you/);
});

test("a pending checkpoint is a full question in the conversation with one attached answer flow", () => {
  const { renderConversation } = threadHelpers();
  const prompt = "MET-651 draft PR #700 is up. Please re-check the visual items against the recording before merge.";
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "review",
    checkpoints: [{
      id: "cp-1", kind: "question", status: "pending", prompt,
      created_at: "2026-08-21T17:00:00Z",
    }],
    activities: [{
      activity_type: "checkpoint_raised", message: prompt,
      created_at: "2026-08-21T17:00:00Z",
    }],
  });

  assert.equal((out.match(/MET-651 draft PR #700 is up/g) || []).length, 1,
    "the prompt is not duplicated between the conversation, composer, and activity rail");
  assert.match(out, /class="cmsg checkpoint-message"/);
  assert.match(out, /agent · input needed/);
  assert.match(out, /id="checkpoint-reply"/);
  assert.match(out, /Answer the question above/);
});

test("the mark is not drawn before there is anything to mark", () => {
  const { renderConversation } = threadHelpers();
  const open = renderConversation({ questions: [{ id: "a", becomes: "D-01", question: "Which repo?" }] }, null);
  assert.doesNotMatch(open, /TRIAGE SETTLED/, "one open question means triage has not settled");
  assert.doesNotMatch(open, /class="pcard"/, "and there is no plan to show");
});

test("the plan card reads its state off progress, not off the ticket status", () => {
  const { renderPlanCard } = threadHelpers();
  const out = renderPlanCard(PLAN, PROGRESS, SETTLED);
  assert.match(out, /4 steps, 2 waves/);
  assert.match(out, /Step 3 is running/, "what is actually running, not what the status claims");
  assert.match(out, /class="prow done"[\s\S]*Cursor query/);
  assert.match(out, /class="prow run"[\s\S]*Board consumes pages/);
  assert.match(out, /wave 2/, "a step not yet dispatched says which wave it is in");
  // The decisions it was built from, named — but not claimed to be cited, which is
  // a statement about a document nobody here has read.
  assert.match(out, /from D-01 · D-02/);
  assert.doesNotMatch(out, /cites/);
});

test("a plan with no steps produces no card at all", () => {
  const { renderPlanCard } = threadHelpers();
  assert.equal(renderPlanCard(null, null, SETTLED), "");
  assert.equal(renderPlanCard({ steps: [] }, null, SETTLED), "");
});

test("the footer says what is happening, counted rather than asserted", () => {
  const { runStatus } = threadHelpers();
  assert.match(runStatus({}, PLAN, PROGRESS), /2 of 4 done, 1 running/);
  assert.match(runStatus({}, PLAN, { steps: { 1: { status: "blocked" } } }), /1 step stopped/);
  assert.match(runStatus({}, PLAN, { steps: {} }), /nothing running/);
  assert.match(runStatus({}, null, null), /planning starts when the questions are settled/);
});

// ─────────── the brief (design 2b, revised) ───────────
// A Linear description arrives with its attachment URLs inline — MET-635's are 140
// characters each — and rendered raw they were four lines of signed query string
// above the conversation the page exists for.

test("the brief is prose, and the attachments are counted rather than printed", () => {
  const { brief } = threadHelpers();
  const b = brief("base-branch: coda/new-ui\ntarget app: `apps/new-ui`\n"
    + "Apply the [brand guidelines](https://app.paper.design/file/01KYD?x=1) using the "
    + "attached <https://uploads.linear.app/f029a4b7-dfc2-4af1-900a-ca31b97ff707/b1f34867.zip>.");
  assert.match(b.lead, /Apply the brand guidelines using the attached/, "the words survive, the urls do not");
  assert.doesNotMatch(b.lead, /https?:/);
  assert.equal(b.attachments, 2);
  // The two lines the meta row repeats verbatim are not repeated in the brief.
  assert.doesNotMatch(b.lead, /coda\/new-ui/);
  assert.doesNotMatch(b.lead, /apps\/new-ui/);
});

test("the brief collapses to one line with the whole thing behind a toggle", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\.tk-brief \.lead \{[^}]*white-space: nowrap;/s);
  const { renderTicket } = threadHelpers();
  const out = renderTicket({ id: "t1", title: "T", status: "planning", created_at: "2026-08-11T10:00:00Z",
    updated_at: "2026-08-13T10:00:00Z", description: "A line.\nAnother line." }, { questions: SETTLED }, []);
  assert.match(out, /▾ description/);
  assert.match(out, /data-fulldesc hidden/, "the rest is present and closed, not thrown away");
});

test("a leg the ticket has not reached carries no date", () => {
  // The activity patterns are loose on purpose — "review" appears in plenty of
  // messages — so legs ahead of the current one were picking up a stamp and
  // claiming the ticket had already been there.
  const { renderTicket } = threadHelpers();
  const out = renderTicket(
    { id: "t1", title: "T", status: "planning", created_at: "2026-08-11T10:00:00Z", updated_at: "2026-08-13T10:00:00Z" },
    null,
    [{ activity_type: "review", message: "Review found blocking issues", created_at: "2026-08-12T10:00:00Z" }]);
  const after = out.slice(out.indexOf(">Review<"));
  assert.doesNotMatch(after, /class="t"/, "Review is ahead of Triage, so it is undated");
});

test("the count turns green only when nothing is blocking", () => {
  const { renderTicket } = threadHelpers();
  const base = { id: "t1", title: "T", status: "planning", created_at: "2026-08-11T10:00:00Z", updated_at: "2026-08-13T10:00:00Z" };
  assert.match(renderTicket(base, { questions: SETTLED }, []), /class="tk-count set">2 of 2 settled/);
  assert.match(renderTicket(base, { questions: [...SETTLED, { id: "c", question: "open?" }] }, []),
    /class="tk-count ">2 of 3 settled/);
});

test("the ticket summary leaves execution detail to the right status card", () => {
  const { renderTicket, renderConversation } = threadHelpers();
  const task = {
    id: "t1",
    title: "[MET-635] Implement brand guideline changes",
    status: "in_progress",
    created_at: "2026-08-11T10:00:00Z",
    updated_at: "2026-08-13T10:00:00Z",
    external_url: "https://linear.app/example/MET-635",
    description: "base-branch: coda/new-ui\ntarget app: `apps/new-ui`\nApply the canonical prototype.",
  };
  const triage = {
    questions: SETTLED,
    execution_target: {
      repos: [{ project: "GitProjects", repo: "backend", label: "GitProjects/backend", base_branch: "origin/master" }],
      apps: ["apps/frontend"],
    },
  };
  const out = renderTicket(task, triage, [], { plan: PLAN, progress: PROGRESS });
  const status = renderConversation(triage, null, { task, plan: PLAN, progress: PROGRESS });

  assert.match(out, /class="ticket-summary"/);
  assert.doesNotMatch(out, /class="stage-flow"/,
    "the ticket summary no longer repeats execution state as a large process chart");
  assert.match(out, /class="tk-title"[^>]*>Implement brand guideline changes</,
    "the reference is printed beside the title, not repeated inside it");
  assert.doesNotMatch(out, /<span class="k">(?:repo|base|app)<\/span>/,
    "execution facts no longer lengthen the main ticket card");
  assert.match(status, /class="status-target"/);
  assert.match(status, /<span class="k">repo<\/span><span class="v"[^>]*>GitProjects\/backend/);
  assert.match(status, /<span class="k">base<\/span><span class="v"[^>]*>origin\/master/);
  assert.match(status, /<span class="k">app<\/span><span class="v"[^>]*>apps\/frontend/);
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\.status-target-grid\s*\{[^}]*grid-template-columns:[^;]*1\.35fr[^;]*repeat\(2,/s,
    "Repo, Base, and App stay on one compact line in the right card");
  assert.doesNotMatch(out, /<span class="k">(?:source|handoff|state)<\/span>/,
    "the summary keeps one useful metadata row instead of repeating ticket state and source context");
  assert.doesNotMatch(out, /View source|https:\/\/linear\.app\/example\/MET-635/,
    "the main card does not duplicate the source-ticket link from the status card");
  assert.match(out, /class="summary-action primary" data-planopen>Open plan</);
  assert.match(out, /class="summary-action hold" data-hold-task>Pause task<\/button>/);
});

test("the ticket detail offers the existing local preview flow", () => {
  const { renderTicket } = threadHelpers();
  const base = { id: "t1", title: "Preview me", status: "in_progress", updated_at: "2026-08-20T20:00:00Z" };
  assert.doesNotMatch(renderTicket(base, null, []), /data-start-preview|>Start preview<|>Open preview|Preview after build/,
    "an active build does not offer preview before the work is ready");
  assert.doesNotMatch(renderTicket({ ...base, status: "planning" }, null, []),
    /data-start-preview|>Start preview<|>Open preview|Preview after build/,
    "pre-build tickets omit the action instead of showing a disabled placeholder");
  assert.match(renderTicket({ ...base, status: "review" }, null, []),
    /data-start-preview[^>]*>Start preview<\/button>/);
  assert.match(renderTicket({ ...base, status: "review", preview: { url: "http:\/\/127.0.0.1:4173", app: "apps\/new-ui" } }, null, []),
    /href="http:\/\/127.0.0.1:4173"[^>]*>Open preview<\/a>/);
  assert.match(renderTicket({ ...base, status: "done", preview: { url: "http:\/\/127.0.0.1:4173", app: "apps\/new-ui", apiReadOnly: true } }, null, []),
    />Open preview · prod read-only<\/a>/);
  assert.doesNotMatch(renderTicket({ ...base, status: "on_hold" }, null, []), /data-start-preview|>Open preview/,
    "holding an unfinished build does not make it preview-ready");
  assert.match(renderTicket({ ...base, status: "on_hold", pr_url: "https:\/\/github.com\/acme\/app\/pull\/700" }, null, []),
    /data-start-preview[^>]*>Start preview<\/button>/,
    "a review-ready ticket keeps preview access after it is put on hold");
  assert.match(renderTicket({ ...base, status: "on_hold" }, null, [], {
    plan: PLAN,
    progress: { steps: Object.fromEntries(PLAN.steps.map(step => [step.step, { status: "completed" }])) },
  }), /data-start-preview[^>]*>Start preview<\/button>/,
  "a completed plan is sufficient review evidence even when no PR is recorded");
  assert.match(renderTicket({ ...base, status: "on_hold", preview: { url: "http:\/\/127.0.0.1:4173" } }, null, []),
    />Open preview<\/a>/, "an already-running preview remains reachable while held");

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const fn = html.slice(html.indexOf("async function startTaskPreview("), html.indexOf("async function putTaskOnHold("));
  assert.match(fn, /\/preview`, \{ method: "POST" \}/);
  assert.match(fn, /window\.open\(data\.url, "_blank", "noopener"\)/);
});

test("the dead Open conversation action is not rendered or wired", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-open-conversation|Open conversation/);
});

test("the pause switch parks active work without offering to pause an already held task", () => {
  const { renderTicket } = threadHelpers();
  const task = { id: "t1", title: "T", status: "in_progress", updated_at: "2026-08-20T20:00:00Z" };
  assert.match(renderTicket(task, { questions: SETTLED }, [], { plan: PLAN }), /data-hold-task>Pause task/);
  assert.doesNotMatch(renderTicket({ ...task, status: "on_hold" }, { questions: SETTLED }, [], { plan: PLAN }), /data-hold-task/);

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const start = html.indexOf("async function putTaskOnHold(");
  const fn = html.slice(start, start + 1000);
  assert.match(fn, /method:\s*"PATCH"/);
  assert.match(fn, /JSON\.stringify\(\{ status: "on_hold" \}\)/,
    "pausing is a reversible status transition, not task deletion");
  assert.doesNotMatch(fn, /method:\s*"DELETE"/);
});

test("an open ticket can be closed from its detail page without deleting it", () => {
  const { renderTicket } = threadHelpers();
  const task = { id: "t1", title: "T", status: "review", updated_at: "2026-08-20T20:00:00Z" };
  assert.match(renderTicket(task, { questions: SETTLED }, [], { plan: PLAN }),
    /data-close-task>Close ticket<\/button>/);
  assert.match(renderTicket({ ...task, status: "on_hold" }, { questions: SETTLED }, [], { plan: PLAN }),
    /data-close-task>Close ticket<\/button>/,
    "a held ticket can still be deliberately closed");
  assert.match(renderTicket({ ...task, status: "done" }, { questions: SETTLED }, [], { plan: PLAN }),
    /data-close-task>Close ticket<\/button>/,
    "completed work can still be archived as closed");
  assert.doesNotMatch(renderTicket({ ...task, status: "closed" }, { questions: SETTLED }, [], { plan: PLAN }),
    /data-close-task/,
    "a closed ticket does not offer the action again");

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\[data-close-task\][\s\S]*closeTask\(ev\.currentTarget\)/,
    "the rendered button is wired to its action");
  const start = html.indexOf("async function closeTask(");
  const fn = html.slice(start, html.indexOf("async function resetTaskTriage(", start));
  assert.match(fn, /await confirmSafety\(/);
  assert.match(fn, /\/close`,\s*\{/);
  assert.match(fn, /method:\s*"POST"/);
  assert.doesNotMatch(fn, /method:\s*"DELETE"/,
    "closing uses its own terminal transition rather than deleting the record");
});

test("closing a Linear-linked ticket confirms Linear before recording closed in MC", async () => {
  const linearCalls = [];
  const runtimeCalls = [];
  await withHandler(async (handler, db) => {
    const task = db.createTask({
      title: "Close linked ticket",
      status: "review",
      source: "linear",
      external_id: "linear-uuid",
      external_url: "https://linear.app/acme/issue/MET-700/close-linked-ticket",
    });
    const res = mockRes();
    await handler(mockReq({
      url: `/api/tasks/${task.id}/close`,
      method: "POST",
      body: { reason: "No longer needed" },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(db.getTask(task.id).status, "closed");
    assert.deepEqual(linearCalls, ["linear-uuid"]);
    assert.deepEqual(runtimeCalls, [{ taskId: task.id, transition: "close" }]);
    const body = JSON.parse(res.body);
    assert.equal(body.linear.identifier, "MET-700");
    assert.match(db.listActivities(task.id)[0].message, /Linear MET-700 is Closed/);
  }, {
    closeLinearIssue: async issueId => {
      linearCalls.push(issueId);
      return { issueId, identifier: "MET-700", stateName: "Closed", alreadyClosed: false };
    },
    transitionTaskRuntime: async (taskId, transition) => {
      runtimeCalls.push({ taskId, transition });
      return { matched: 1, stopped: 1 };
    },
  });
});

test("a failed Linear close leaves the Mission Control ticket unchanged", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({
      title: "Linear must confirm",
      status: "review",
      source: "linear",
      external_id: "linear-uuid",
    });
    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/close`, method: "POST", body: {} }), res);

    assert.equal(res.statusCode, 502);
    assert.equal(db.getTask(task.id).status, "review");
    assert.match(JSON.parse(res.body).error, /Could not close linked Linear issue/);
  }, {
    closeLinearIssue: async () => { throw new Error("Linear unavailable"); },
  });
});

test("pause and triage reset share an explicit in-page safety panel", () => {
  const { renderTicket } = threadHelpers();
  const task = { id: "t1", title: "T", status: "in_progress", updated_at: "2026-08-20T20:00:00Z" };
  const out = renderTicket(task, { questions: SETTLED }, [], { plan: PLAN });
  assert.match(out, /data-reset-triage>Reset triage<\/button>/);

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /<dialog class="safety-dialog" id="safety-confirm">/);
  const pause = html.slice(html.indexOf("async function putTaskOnHold("), html.indexOf("async function resetTaskTriage("));
  const reset = html.slice(html.indexOf("async function resetTaskTriage("), html.indexOf("async function postNote("));
  assert.match(pause, /await confirmSafety\(/);
  assert.match(reset, /await confirmSafety\(/);
  assert.match(reset, /reset-triage`, \{ method: "POST" \}/);
  assert.match(reset, /delete ticketPlanCache\[taskId\]/,
    "reset removes the archived plan snapshot before repainting the ticket");
});

test("the colored status card carries a prominent link to the source ticket", () => {
  const { renderConversation } = threadHelpers();
  const url = "https://linear.app/acme/issue/MET-642/correct-focus-rings";
  const out = renderConversation({ questions: SETTLED }, null, {
    task: { id: "t1", title: "[MET-642] Correct focus rings", status: "review", external_url: url },
    taskStatus: "review", activities: [],
  });
  assert.match(out, new RegExp(`class="status-ticket-ref" href="${url}"[^>]*>MET-642 ↗<`));

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\.status-ticket-ref\s*\{[^}]*font-size:\s*18px;/s);
});

test("review puts its PR action on the colored status card", () => {
  const { renderConversation } = threadHelpers();
  const prUrl = "https://github.com/acme/app/pull/687";
  const out = renderConversation({ questions: SETTLED }, null, {
    task: { id: "t1", title: "Review me", status: "review", updated_at: "2026-08-20T20:00:00Z" },
    taskStatus: "review", plan: PLAN, progress: {}, activities: [], deliverables: [
      { deliverable_type: "pr", title: "Pull Request #687", path: prUrl },
    ],
  });

  assert.match(out, /class="ticket-status-panel tone-review"/);
  assert.doesNotMatch(out, />lifecycle<\/span>/);
  assert.match(out, new RegExp(`class="status-pr" href="${prUrl}"[^>]*>Go to pull request<`));
});

test("review omits the PR action when no link is recorded", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED }, null, {
    task: { id: "t1", title: "Review me", status: "review", updated_at: "2026-08-20T20:00:00Z" },
    taskStatus: "review", plan: PLAN, progress: {}, activities: [], deliverables: [],
  });
  assert.doesNotMatch(out, /PR not recorded/);
  assert.doesNotMatch(out, /class="status-pr"/);
});

test("the rail's segments follow the steps once there is a plan", () => {
  // Before it they are the questions, because that is the only progress triage has.
  const { renderRail } = threadHelpers();
  const task = { id: "t1", title: "T", status: "in_progress", updated_at: "2026-08-13T10:00:00Z", external_id: "MC-146" };
  const building = renderRail([task], task, { questions: SETTLED }, { plan: PLAN, progress: PROGRESS });
  assert.match(building, /class="dim">step<\/span>/);
  assert.match(building, /class="n">2\/4</);
  assert.match(building, /class="rt on build"/, "past triage the ticket is the agent's, not yours");

  const triaging = renderRail([{ ...task, status: "planning" }], { ...task, status: "planning" },
    { questions: SETTLED }, {});
  assert.match(triaging, /class="dim">triage<\/span>/);
  assert.match(triaging, /class="n">2\/2</);
});

test("selecting a single-agent ticket preserves its completed step count", () => {
  const { renderRail } = threadHelpers();
  const task = { id: "met724", title: "MET-724", status: "in_progress" };
  const plan = { steps: Array.from({ length: 38 }, (_, i) => ({ step: i + 1, plan: "01-01" })) };
  const snapshot = { plan, progress: null, agentProgress: { state: "done" } };
  for (const current of [null, task]) {
    const html = renderRail([task], current, null, snapshot, { [task.id]: snapshot });
    assert.match(html, /class="n">38\/38</);
    assert.equal((html.match(/<i class="done"><\/i>/g) || []).length, 38);
  }

  // Explicit step records still win over the coarse whole-agent completion signal.
  snapshot.progress = { steps: { "38": { status: "blocked" } } };
  for (const current of [null, task]) {
    const html = renderRail([task], current, null, snapshot, { [task.id]: snapshot });
    assert.match(html, /class="n">37\/38</);
    assert.equal((html.match(/<i class="now"><\/i>/g) || []).length, 1);
  }
});

test("ticket rail keeps the operational group order", () => {
  const { renderRail } = threadHelpers();
  const tasks = [
    { id: "triage", status: "planning", title: "Triage", external_id: "MET-1" },
    { id: "building", status: "in_progress", title: "Building", external_id: "MET-2" },
    { id: "holding", status: "on_hold", title: "Holding", external_id: "MET-3" },
    { id: "review", status: "review", title: "Review", external_id: "MET-2" },
    { id: "done", status: "done", title: "Done", external_id: "MET-4" },
    { id: "closed", status: "closed", title: "Closed", external_id: "MET-5" },
  ];
  const out = renderRail(tasks, tasks[0], null, {});
  const headings = [">TRIAGE<", ">BUILDING<", ">REVIEW<", ">HOLDING<", ">DONE<", ">CLOSED<"];
  for (let i = 1; i < headings.length; i += 1) {
    assert.ok(out.indexOf(headings[i - 1]) < out.indexOf(headings[i]),
      `${headings[i - 1]} must stay before ${headings[i]}`);
  }
});

test("selecting a ticket never reorders cards within its rail group", () => {
  const { renderRail } = threadHelpers();
  const tasks = [
    { id: "newest", external_id: "MET-3", title: "Newest", status: "in_progress" },
    { id: "middle", external_id: "MET-2", title: "Middle", status: "in_progress" },
    { id: "oldest", external_id: "MET-1", title: "Oldest", status: "in_progress" },
  ];
  const out = renderRail(tasks, tasks[1], { questions: [] });
  assert.ok(out.indexOf("MET-3") < out.indexOf("MET-2"));
  assert.ok(out.indexOf("MET-2") < out.indexOf("MET-1"),
    "the active card is highlighted in place instead of promoted to the top");
});

test("selecting another ticket does not clear a visited card's plan steps", () => {
  const { renderRail } = threadHelpers();
  const tasks = [
    { id: "first", external_id: "MET-3", title: "First", status: "in_progress" },
    { id: "second", external_id: "MET-2", title: "Second", status: "in_progress" },
  ];
  const firstPlan = {
    plan: PLAN,
    progress: { steps: { "1": { status: "completed" }, "2": { status: "in_progress" } } },
  };
  const out = renderRail(tasks, tasks[1], { questions: [] }, {}, { first: firstPlan });
  const firstCard = out.slice(out.indexOf('href="/ticket?id=first"'), out.indexOf('</a>', out.indexOf('href="/ticket?id=first"')));

  assert.match(firstCard, /class="dim">step<\/span>/);
  assert.match(firstCard, /class="n">1\/4<\/span>/);
  assert.equal((firstCard.match(/<i class=/g) || []).length, 4,
    "the remembered card retains its plan-step segments after selection moves away");
});

test("a non-selected planning ticket shows its answers, not lifecycle stage 2 of 6", () => {
  const { renderRail } = threadHelpers();
  const answered = Array.from({ length: 8 }, (_, i) => ({
    id: `q${i + 1}`, question: `Q${i + 1}`, answer: `A${i + 1}`,
  }));
  const tasks = [
    { id: "selected", status: "in_progress", title: "Selected" },
    { id: "met648", status: "planning", title: "MET-648", external_id: "MET-648",
      triage_state: JSON.stringify({ questions: answered }) },
  ];
  const out = renderRail(tasks, tasks[0], { questions: [] }, {});
  const card = out.slice(out.indexOf('href="/ticket?id=met648"'), out.indexOf("</a>", out.indexOf('href="/ticket?id=met648"')));
  assert.match(card, /triage/);
  assert.match(card, /8\/8/);
  assert.doesNotMatch(card, /2\/6/);
});

test("the ticket rail marks every ticket that is waiting on the operator", () => {
  const { renderRail } = threadHelpers();
  const tasks = [
    { id: "question", status: "planning", title: "Choose a repo", external_id: "MET-1",
      triage_state: JSON.stringify({ questions: [{ id: "q1", question: "Which repo?" }] }) },
    { id: "confirm", status: "planning", title: "Confirm the plan", external_id: "MET-2",
      triage_state: JSON.stringify({ questions: [], confirmed: false }) },
    { id: "checkpoint", status: "on_hold", title: "Approve a decision", external_id: "MET-3",
      pending_checkpoints: 1 },
    { id: "review", status: "review", title: "Review the pull request", external_id: "MET-4" },
    { id: "building", status: "in_progress", title: "Agent is working", external_id: "MET-5" },
  ];
  const out = renderRail(tasks, tasks[4], null, {});
  const card = id => {
    const href = out.indexOf(`href="/ticket?id=${id}"`);
    const start = out.lastIndexOf("<a ", href);
    return out.slice(start, out.indexOf("</a>", start));
  };

  for (const id of ["question", "confirm", "checkpoint"]) {
    assert.match(card(id), /class="rt needs-you/,
      `${id} should receive the amber attention treatment`);
    assert.match(card(id), /class="rt-needs-icon"/,
      `${id} should carry the bell icon`);
    assert.match(card(id), /aria-label="Needs your attention:/,
      `${id} needs a non-color accessible explanation`);
  }
  assert.doesNotMatch(card("building"), /needs-you|rt-needs-icon/,
    "ordinary agent-owned work must not look like it is waiting on the operator");
  // "In review" is what the column already says, and it is a state no action on
  // this page clears — so the bell would be permanent for every reviewable task.
  // Spending the amber on the expected state of a whole column is how the signal
  // stops being read.
  assert.doesNotMatch(card("review"), /needs-you|rt-needs-icon/,
    "review status alone is not a concrete outstanding item");
});

test("a task in review still raises the bell for a real outstanding item", () => {
  const { renderRail } = threadHelpers();
  // The distinction that matters: the bell tracks the checkpoint, not the status.
  const tasks = [
    { id: "plain", status: "review", title: "Review the pull request", external_id: "MET-7" },
    { id: "asking", status: "review", title: "Review, but blocked", external_id: "MET-8",
      pending_checkpoints: 1 },
  ];
  const out = renderRail(tasks, tasks[0], null, {});
  const card = id => {
    const href = out.indexOf(`href="/ticket?id=${id}"`);
    const start = out.lastIndexOf("<a ", href);
    return out.slice(start, out.indexOf("</a>", start));
  };

  assert.doesNotMatch(card("plain"), /needs-you|rt-needs-icon/);
  assert.match(card("asking"), /class="rt needs-you/,
    "a pending decision is actionable regardless of which column it sits in");
  assert.match(card("asking"), /aria-label="Needs your attention: 1 pending decision"/);
});

test("a resolved human action clears the rail attention treatment", () => {
  const { renderRail } = threadHelpers();
  const settled = {
    id: "settled", status: "planning", title: "Ready to go", external_id: "MET-6",
    pending_checkpoints: 0,
    triage_state: JSON.stringify({
      confirmed: true,
      questions: [{ id: "q1", question: "Which repo?", answer: "GitProjects/backend" }],
    }),
  };
  const out = renderRail([settled], settled, JSON.parse(settled.triage_state), {});

  assert.doesNotMatch(out, /needs-you|rt-needs-icon/);
});

// ─────────── the top nav (design 2b, revised) ───────────
// The wordmark moved out of the ticket rail: it names the app, and the rail names
// one list inside it. Every count comes off the ticket list the rail already
// needed, so the bar costs no extra request.

test("the nav counts what is actually there, and links where something exists", () => {
  const { renderNav } = threadHelpers();
  const blocked = JSON.stringify({ questions: [{ id: "q" }, { id: "r" }] });
  const tasks = [
    { id: "a", status: "planning", triage_state: blocked },
    { id: "b", status: "in_progress" },
    { id: "c", status: "review" },
    { id: "d", status: "done" },
  ];
  const out = renderNav(tasks, tasks[0]);

  assert.match(out, /MISSION CONTROL/);
  assert.match(out, /Inbox<span class="c need">1<\/span>/, "one ticket is blocked on a human");
  assert.match(out, /Tickets<span class="c ">3<\/span>/, "done does not count as open");
  assert.match(out, /Swarm<span class="c run">1<\/span>/);
  assert.match(out, /Review<span class="c rev">1<\/span>/);
  assert.match(out, /class="tab on" href="\/"/, "Tickets is the tab you are on");
  // Every href must resolve to a served route — a tab that goes nowhere is worse
  // than one that is absent, which is why the design's Knowledge tab is not here.
  for (const href of [...out.matchAll(/href="([^"]+)"/g)].map(m => m[1])) {
    assert.match(href, /^\/(#(planning|review))?$|^\/space$/, `nav links somewhere unserved: ${href}`);
  }
  assert.doesNotMatch(out, /Knowledge/);
});

test("a count of zero is left off rather than shown as a zero", () => {
  const { renderNav } = threadHelpers();
  const out = renderNav([{ id: "a", status: "planning" }], { id: "a" });
  assert.doesNotMatch(out, /class="c run">0/);
  assert.doesNotMatch(out, /need you/, "nothing is blocked, so nothing claims to be");
});

test("the dashboard honours the filter the nav links to", () => {
  // Otherwise the tab saying "Review 2" lands on the whole board and the count has
  // to be taken on trust.
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appJs, /location\.hash\.slice\(1\)/);
  assert.match(appJs, /\['planning', 'in_progress', 'review', 'on_hold', 'done', 'closed'\]/);
});

// ─────────── the confirm gate (design 3d, on the thread) ───────────
// bridge.py:5050 refuses to dispatch until `confirmed` is true, and polls the
// ticket every 60 seconds while it waits. That gate only ever had a button in the
// dashboard's triage modal — so a ticket settled entirely in this thread sat
// unplanned while the page reported that the planner would run next. MET-635 sat
// that way for two days, once a minute, saying so in the log.

test("settling every question is not the same as starting the work", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED }, null, {});
  assert.match(out, /data-act="confirm"/, "the gate the daemon enforces has a button");
  assert.match(out, /Nothing has been dispatched yet/);
  // And it must not claim planning is already under way.
  assert.doesNotMatch(out, /the planner runs next/);
  assert.doesNotMatch(out, /no plan on disk yet/);
  assert.match(out, /confirming creates the branch and worktree/, "the write says what it writes");
});

test("a new ticket confirms one repository before it can confirm planning", () => {
  const { renderConversation, renderTicket } = threadHelpers();
  const triage = {
    questions: SETTLED,
    triage_repos: [{ project: "GitProjects", repo: "backend" }],
    execution_target: { repos: [{ project: "GitProjects", repo: "backend", label: "GitProjects/backend" }] },
  };
  const task = {
    id: "t", external_id: "MET-648", title: "Carousel", status: "planning",
    description: "Target app: apps/new-ui", created_at: "2026-08-20T17:00:00Z",
    updated_at: "2026-08-20T18:00:00Z",
  };
  const ticket = renderTicket(task, triage, [], { repoOptions: ["GitProjects/backend"] });
  const target = renderConversation(triage, null, { task, repoOptions: ["GitProjects/backend"] });
  assert.doesNotMatch(ticket, /data-repo-select|class="status-target"/,
    "the main ticket card does not duplicate execution targeting");
  assert.match(target, /data-repo-select/);
  assert.match(target, /<div class="fld repo-field"><span class="k">repo<\/span>/);
  assert.match(target, /Select repository…/,
    "an unconfirmed suggestion must require an explicit dropdown choice");
  assert.doesNotMatch(target, /repo-confirm|data-confirm-repo|Repository confirmed/,
    "repository selection belongs in the right-side execution facts, not a confirmation row");
  assert.equal((target.match(/<option value="GitProjects\/backend"/g) || []).length, 1);
  assert.doesNotMatch(target, /worktrees\/|external\//,
    "generated worktrees and reference checkouts are not execution choices");

  const gated = renderConversation(triage, null, { task });
  assert.match(gated, /Choose one repository in the status card/);
  assert.match(gated, /Use the Repo dropdown on the right/);
  assert.doesNotMatch(gated, /data-act="confirm"/);

  const repoConfirmed = renderConversation({ ...triage, repo_confirmed: "GitProjects/backend" }, null, { task });
  assert.match(repoConfirmed, /data-act="confirm"/, "repo receipt unlocks the separate start gate");
});

test("a dispatched ticket never asks for an impossible repository confirmation", () => {
  const { renderConversation } = threadHelpers();
  const triage = {
    questions: [],
    triage_repos: [{ project: "GitProjects", repo: "backend" }],
    execution_target: {
      repos: [{ project: "GitProjects", repo: "backend", label: "GitProjects/backend" }],
    },
  };
  const out = renderConversation(triage, null, {
    task: { id: "t", external_id: "MET-651", status: "in_progress" },
    taskStatus: "in_progress",
  });

  assert.doesNotMatch(out, /Choose one repository|Repo dropdown|confirm repository/);
  assert.doesNotMatch(out, /data-act="confirm"/);
  assert.match(out, /Nothing is waiting on you/);
});

test("once confirmed the thread stops asking and starts reporting", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { status: "nothing needs you · 2 of 4 done, 1 running" });
  assert.doesNotMatch(out, /data-act="confirm"/, "confirming twice is not a thing");
  assert.match(out, /Nothing is waiting on you/);
  assert.match(out, /2 of 4 done, 1 running/);
});

test("a deferred question cannot be confirmed away", () => {
  // The thread lets a question be set aside; the bridge's confirm path requires
  // every question answered. Offering confirm here would write a state the daemon
  // then refuses to act on, which is the same silent stall in a new place.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: [
    ...SETTLED, { id: "z", becomes: "D-09", question: "Rate limit?", deferred: true }] }, null, {});
  assert.doesNotMatch(out, /data-act="confirm"/);
});

test("confirm is a deliberate write, and it is the only one", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /async function confirmTriage\(/);
  // It writes what the dashboard's modal writes, so the two surfaces agree.
  const fn = html.slice(html.indexOf("async function confirmTriage("));
  assert.match(fn.slice(0, 600), /next\.confirmed = true/);
  assert.match(fn.slice(0, 600), /next\.status = "answered"/);
  // A failed confirm must put the button back rather than stranding it disabled.
  assert.match(fn.slice(0, 1200), /btn\.disabled = false/);
});

// ─────────── talking to the ticket, not to a question (2c mid-run) ───────────
// Every message used to be scoped to a question, so the box went dead the moment
// the last one settled — exactly when "how was this implemented" and "change this"
// become the things you want to say. The channel already existed: the dashboard
// drawer posts to /api/tasks/:id/activities with a type chosen by ticket status,
// and bridge.py:4561 turns unacknowledged manual_feedback into a relaunch.

test("the composer stays live once the questions are settled", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { taskStatus: "in_progress", status: "nothing needs you" });
  assert.doesNotMatch(out, /id="say"[^>]*disabled/, "the box is not dead");
  assert.match(out, /data-send="note"/);
  assert.match(out, /Ask about this ticket, or say what to change/);
});

test("a note goes down the channel the ticket's status implies", () => {
  // Same mapping as the drawer (app.js). Diverging would mean a note typed here
  // and one typed there reach the agent differently.
  const { renderConversation } = threadHelpers();
  const at = s => renderConversation({ questions: SETTLED, confirmed: true }, null, { taskStatus: s });
  assert.match(at("review"), /data-note="manual_feedback"/);
  assert.match(at("testing"), /data-note="manual_feedback"/);
  assert.match(at("planning"), /data-note="planning_answer"/);
  assert.match(at("in_progress"), /data-note="updated"/);
  // And it says which way it travels, because "change this" at review relaunches
  // an agent while a planning note only lands in the next planner pass.
  assert.match(at("review"), /change requests reach the agent/);
});

test("the exchange shows what people said, not the bridge narrating itself", () => {
  const { renderConversation } = threadHelpers();
  const activities = [
    { activity_type: "manual_feedback", message: "why is the header duplicated?", created_at: "3" },
    { activity_type: "agent_reply", agent_id: "a1", message: "It reuses SiteHeader twice.", created_at: "4" },
    { activity_type: "updated", message: "All questions answered — dispatching for 1 repo(s)", created_at: "1" },
    { activity_type: "status_changed", message: "Task triaged as ready", created_at: "2" },
  ];
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { activities, taskStatus: "review" });
  const conversation = out.split('<aside class="decisions">')[0];
  const timeline = out.split('<aside class="decisions">')[1];

  assert.match(conversation, /why is the header duplicated\?/);
  assert.match(conversation, /It reuses SiteHeader twice\./);
  assert.doesNotMatch(conversation, /dispatching for 1 repo/,
    "the bridge narrating itself is not conversation");
  // Lifecycle narration remains available as timeline history, never as speech.
  assert.match(timeline, /dispatching for 1 repo/);
  assert.doesNotMatch(conversation, /class="cmsg me"><div class="cbody">Task triaged/);
  // Yours reads as yours; an agent's carries its avatar.
  assert.match(conversation, /class="cmsg me"><div class="cbody">why is the header/);
});

test("the exchange reads in the order it happened", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    activities: [
      { activity_type: "manual_feedback", message: "SECOND", created_at: "2026-08-14T02:00:00Z" },
      { activity_type: "manual_feedback", message: "FIRST", created_at: "2026-08-14T01:00:00Z" },
    ], taskStatus: "review" });
  assert.ok(out.indexOf("FIRST") < out.indexOf("SECOND"));
});

test("a note is posted, not silently dropped, and clears the box only on success", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /async function postNote\(/);
  const fn = html.slice(html.indexOf("async function postNote("), html.indexOf("async function postNote(") + 900);
  assert.match(fn, /\/activities/);
  assert.match(fn, /activity_type: kind \|\| "updated"/);
  // The throw precedes the clear, so a failed send never eats what was typed.
  assert.ok(fn.indexOf("throw new Error") < fn.indexOf("say.value = \"\""));
});

// ─────────── the rail is the thread list for the whole board ───────────

test("every ticket appears in the rail, whatever its status", () => {
  // It built groups from LEGS alone and dropped anything matching none, so
  // on_hold / testing / pending_dispatch tickets simply were not there — while the
  // nav counted them. A parked ticket vanishing is the worst case: it is parked
  // precisely because someone has to come back to it.
  const { renderRail } = threadHelpers();
  const tasks = [
    { id: "a", status: "planning", title: "In triage", external_id: "T-1" },
    { id: "b", status: "on_hold", title: "Parked one", external_id: "T-2" },
    { id: "c", status: "testing", title: "Being tested", external_id: "T-3" },
    { id: "d", status: "in_progress", title: "Building", external_id: "T-4" },
    { id: "e", status: "closed", title: "Closed", external_id: "T-5" },
  ];
  const out = renderRail(tasks, tasks[0], null, {});
  for (const t of tasks) {
    assert.match(out, new RegExp(t.external_id), `${t.status} ticket is missing from the rail`);
  }
  assert.match(out, /HOLDING · 1/);
  assert.match(out, /class="rgroup tone-hold"/);
  assert.match(out, /class="rgroup tone-building"/);
  assert.match(out, /class="rgroup tone-review"/);
  assert.match(out, /<b>1<\/b>/, "the count has the reference's detached header cell");
});

test("a parked ticket does not borrow the colour that means an agent has it", () => {
  const { renderRail } = threadHelpers();
  const parked = { id: "b", status: "on_hold", title: "Parked", external_id: "T-2" };
  const out = renderRail([parked], parked, null, {});
  assert.doesNotMatch(out, /class="rt on build"/, "on_hold is not building");
});

test("done and closed tickets are separate collapsed categories", () => {
  const { renderRail } = threadHelpers();
  const tasks = [
    { id: "active", status: "in_progress", title: "Building", external_id: "T-1" },
    { id: "done", status: "done", title: "Finished", external_id: "T-2" },
    { id: "closed", status: "closed", title: "Archived", external_id: "T-3" },
  ];
  const out = renderRail(tasks, tasks[0], null, {});

  assert.match(out, /<details class="rsection tone-building" open>/,
    "active groups remain expanded");
  assert.match(out, /<details class="rsection tone-done" >/,
    "Done uses a closed native disclosure, so clicking its summary reveals the cards");
  assert.match(out, /<summary class="rgroup tone-done"[^>]*><span>DONE<\/span><b>1<\/b><\/summary>/);
  assert.match(out, /Finished/, "collapsed tickets remain available inside the disclosure");
  assert.match(out, /<details class="rsection tone-closed" >/);
  assert.match(out, /<summary class="rgroup tone-closed"[^>]*><span>CLOSED<\/span><b>1<\/b><\/summary>/);
  assert.match(out, /Archived/);
});

test("every ticket is a thread, including one triage had no questions about", () => {
  // These used to get a different page — findings and a plan, no stream and no
  // composer — so the tickets triage was most confident about were the ones you
  // could say least about.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: [], triage_reasoning: "Single file, clear scope." },
    null, { taskStatus: "planning" });
  assert.match(out, /class="stream"/);
  assert.match(out, /Single file, clear scope\./, "and what triage found is in the stream");
  // Unconfirmed, so the composer is the confirm gate rather than a text box —
  // there is still somewhere to act, which is the point.
  assert.match(out, /data-act="confirm"/);

  const confirmed = renderConversation(
    { questions: [], confirmed: true, triage_reasoning: "Single file." }, null, { taskStatus: "in_progress" });
  assert.match(confirmed, /id="say"/, "once confirmed there is somewhere to type");
});

test("what triage found shows a concise task, issues, and proposed solution", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({
    questions: [],
    triage_reasoning: "The recording and target application are clear.",
    triage_brief: {
      task: "Bring the company page in line with the recorded feedback.",
      issues: "Numeric text is too heavy, the tab strip scrolls, and Execution Route should be removed.",
      solution: "Adjust scoped typography and tabs, remove the obsolete section, and reposition the badge.",
    },
  }, null, { taskStatus: "planning" });

  assert.match(out, /What triage found/);
  assert.match(out, /<span class="fk">Task<\/span>/);
  assert.match(out, /<span class="fk">Issues<\/span>/);
  assert.match(out, /<span class="fk">Solution<\/span>/);
  assert.match(out, /Numeric text is too heavy/);
  assert.match(out, /remove the obsolete section/);
});

test("triage having no questions reads differently from triage not having run", () => {
  // Opposite facts: one means nobody need do anything, the other means nothing has
  // happened yet. The no-questions case is also the one that dispatches unconfirmed.
  const { renderConversation } = threadHelpers();
  const ran = renderConversation({ questions: [] }, null, {});
  assert.match(ran, /had no questions/);
  // And it is confirmable: a ticket triage waved through is exactly the one that
  // used to reach a branch and a worktree with nobody asked.
  assert.match(ran, /data-act="confirm"/);

  const never = renderConversation(null, null, {});
  assert.match(never, /triage hasn't run/);

  // A ready ticket persists no triage_state at all, so the only trace that it was
  // assessed and waved through is the activity marker. Without reading it the page
  // reports "triage hasn't run" about a ticket triage read and dispatched.
  const readyNoState = renderConversation(null, null, {
    activities: [{ activity_type: "status_changed", message: "Task triaged as ready (implementation) — assigning to agents" }] });
  assert.match(readyNoState, /had no questions/);
});

// ─────────── attribution and noise in the ticket thread ───────────
// The first version treated "no agent_id" as "the human said this". MC writes
// plenty of agent-less activities, so 37 entries on MET-635 — almost all identical
// heartbeats — rendered as right-aligned messages from the user.

test("nothing is attributed to a person unless a person is on it", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "updated", message: "Agent heartbeat: task x running (attempt 1/3)." },
      { activity_type: "updated", message: "Some bridge narration nobody typed." },
      { activity_type: "manual_feedback", message: "please use UTC" },
      { activity_type: "updated", message: "typed on the ticket page",
        metadata: JSON.stringify({ source: "human", via: "ticket-page" }) },
    ] });
  // Exactly the two a person actually wrote.
  assert.equal((out.match(/class="cmsg me"/g) || []).length, 2);
  assert.match(out, /please use UTC/);
  assert.match(out, /typed on the ticket page/);
  assert.doesNotMatch(out, /class="cmsg me"><div class="cbody">Agent heartbeat/);
});

test("routine transport chatter is omitted from the activity timeline", () => {
  const { renderConversation } = threadHelpers();
  const beats = Array.from({ length: 12 }, (_, i) => ({
    activity_type: "updated", message: "Agent heartbeat: task x running (attempt 1/3).",
    created_at: `2026-08-14T10:${String(i).padStart(2, "0")}:00Z` }));
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { taskStatus: "in_progress", activities: beats });
  assert.doesNotMatch(out, /Ticket activity timeline|routine updates|Agent heartbeat/,
    "heartbeats do not crowd real events out of the timeline");
});

test("trouble is never collapsed, whatever else is", () => {
  // A failure buried in "37 routine updates" is a failure nobody sees.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "updated", message: "Agent heartbeat: running.", created_at: "1" },
      { activity_type: "updated", message: "Agent spawn failed for repo/x (attempt 2).", created_at: "2" },
      { activity_type: "updated", message: "Agent heartbeat: running.", created_at: "3" },
    ] });
  assert.match(out, /class="activity-item cevent bad"/);
  assert.match(out, /Agent spawn failed/);
  assert.doesNotMatch(out, /Agent heartbeat|routine update/);
});

test("a milestone reads as an event, not as somebody speaking", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [{ activity_type: "step_completed", message: "Step 2 completed", created_at: "1" }] });
  assert.match(out, /class="activity-item cevent event"/);
  assert.match(out, /Step 2 completed/);
  assert.doesNotMatch(out, /class="cmsg me"/);
});

test("a note the page sends marks itself as a person's", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const fn = html.slice(html.indexOf("async function postNote("), html.indexOf("async function postNote(") + 1100);
  assert.match(fn, /source: "human"/);
  assert.match(fn, /expects_reply: true/,
    "ticket chat must enqueue a durable reply instead of drawing an unbacked spinner");
});

test("a message with nothing back yet shows that a reply is coming", () => {
  // Otherwise it just sits there and the page looks broken — the reply is a poll
  // away at best, and on a busy bridge a minute or more.
  const { renderConversation } = threadHelpers();
  const waiting = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "review",
    activities: [{ activity_type: "manual_feedback", message: "why UTC?", created_at: "1",
      expects_reply: 1 }] });
  assert.match(waiting, /class="cthink"/);

  const answered = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "review",
    activities: [
      { activity_type: "manual_feedback", message: "why UTC?", created_at: "1" },
      { activity_type: "agent_reply", agent_id: "a1", message: "Because the server is UTC.", created_at: "2" },
    ] });
  assert.doesNotMatch(answered, /class="cthink"/, "the reply landed, so nothing is pending");
});

test("lifecycle-handled follow-up changes do not leave a permanent reply animation", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "review",
    activities: [
      { activity_type: "manual_feedback", message: "move the badge onto the logo",
        created_at: "1", expects_reply: 0 },
      { activity_type: "updated", message: "Change request received from Mission Control — re-launching agent",
        created_at: "2" },
    ],
  });
  assert.doesNotMatch(out, /class="cthink"/,
    "a note not queued for chat reply must not claim Mission Control is still replying");
});

test("routine chatter after your message does not count as a reply", () => {
  // A heartbeat is not an answer, and letting one clear the indicator would say
  // the agent responded when it did not.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "review",
    activities: [
      { activity_type: "manual_feedback", message: "why UTC?", created_at: "1", expects_reply: 1 },
      { activity_type: "updated", message: "Agent heartbeat: running.", created_at: "2" },
    ] });
  assert.match(out, /class="cthink"/);
});

test("the dashboard note channel also requests a durable reply", () => {
  const dashboard = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = dashboard.indexOf("els.addNoteForm.addEventListener('submit'");
  const form = dashboard.slice(start, start + 2300);
  assert.match(form, /source: ['"]human['"]/);
  assert.match(form, /expects_reply: true/);
});

test("machine events live in the rail, not interleaved with the conversation", () => {
  // A conversation with "step 2 completed" every few lines is a log with speech in
  // it. The two are read at different moments, for different reasons.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "manual_feedback", message: "use UTC please", created_at: "1" },
      { activity_type: "step_completed", message: "Step 2 completed", created_at: "2" },
    ] });
  const [chat, rail] = out.split('<aside class="decisions">');
  assert.match(chat, /use UTC please/, "what a person said stays in the chat");
  assert.doesNotMatch(chat, /Step 2 completed/, "what the machine did does not");
  assert.match(rail, /Step 2 completed/);
  assert.match(rail, /Activity/);
});

test("the ticket rail leads with the reference's compact status record", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    task: { id: "t1", status: "in_progress", agent_profile: "codex" },
    taskStatus: "in_progress",
    plan: { steps: [{ step: 1 }, { step: 2 }], parallel_groups: [[1], [2]] },
    progress: { steps: {
      "1": { status: "completed" },
      "2": { status: "in_progress", agent_profile: "pi" },
    } },
    agentProgress: { state: "running", phase: "execute", step_label: "Applying company polish" },
    status: "nothing needs you · 1 of 2 done, 1 running",
    activities: [],
  });
  assert.match(out, /class="ticket-status-panel tone-building"/);
  assert.match(out, /class="status-kicker"><span class="status-symbol"[^>]*>↗<\/span>in progress</);
  assert.doesNotMatch(out, />agent<\/span>|>decisions<\/span>|>lifecycle<\/span>|>now<\/span>/);
  assert.match(out, /class="autos autonomy-badge"/);
  assert.match(out, /class="status-heading-actions"[\s\S]*class="autos autonomy-badge"/);
  assert.doesNotMatch(out, /status-autonomy-row|>Autonomy<\/span>/);
  assert.doesNotMatch(out, /class="wave-bars"/);

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\.shell\s*\{[^}]*width:\s*min\(100%, var\(--shell-max\)\);[^}]*margin:\s*0 auto;/s,
    "the entire workspace is centred instead of expanding toward the right on wide displays");
  assert.match(html, /\.ticket\s+\{\s*grid-column:\s*2;\s*grid-row:\s*2;/s);
  assert.match(html, /\.ticket-status-panel\s+\{\s*grid-column:\s*3;\s*grid-row:\s*2;/s,
    "the summary and status panel are sibling cells in the same grid row");
  assert.match(html, /\.rail\s*\{[^}]*padding:\s*28px 16px 20px;/s);
  assert.match(html, /\.ticket\s*\{[^}]*padding:\s*28px 0 18px var\(--workspace-gap\);/s,
    "the ticket card aligns with the first rail heading and uses a compact bottom gutter");
  assert.match(html, /\.ticket-status-panel\s*\{[^}]*margin:\s*28px var\(--workspace-gap\) 18px 0;/s,
    "the joined ticket card has equal outside spacing while Decisions stays in the right column");
  assert.match(html, /\.ticket-status-panel\s*\{[^}]*align-self:\s*stretch;/s,
    "the reduced status card keeps the main ticket card's full row height");
  assert.match(html, /\.status-controls\s*\{[^}]*margin-top:\s*auto;/s,
    "the remaining controls retain the old card's spacious vertical composition");
  assert.match(html, /\.summary-action\s*\{[^}]*min-height:\s*38px;/s,
    "the ticket summary remains intentionally compact");
  assert.ok(out.indexOf('class="ticket-status-panel') < out.indexOf('<aside class="decisions">'),
    "the lower decision/activity rail is a separate component after the shared ticket header");
});

test("the status card does not repeat detailed lifecycle state before a plan exists", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    task: { id: "t", external_id: "MET-648", status: "planning" },
    taskStatus: "planning",
    agentProgress: { phase: "planning" },
    plan: null,
    progress: null,
  });
  assert.doesNotMatch(out, />lifecycle<\/span>|class="status-current"/);
  assert.doesNotMatch(out, /class="wave-bars"/);
  assert.doesNotMatch(out, /status-wave-head/);
});

test("planning and review have unmistakably different status-card treatments", () => {
  const { renderConversation } = threadHelpers();
  const common = { questions: SETTLED, confirmed: true };
  const planning = renderConversation(common, null, {
    task: { id: "plan", status: "planning", agent_profile: "triage" },
    taskStatus: "planning", activities: [],
  });
  const review = renderConversation(common, null, {
    task: { id: "review", status: "review", agent_profile: "reviewer" },
    taskStatus: "review", activities: [],
  });

  assert.match(planning, /class="ticket-status-panel tone-planning"/);
  assert.match(planning, /class="status-symbol" aria-hidden="true">→<\/span>planning/);
  assert.match(review, /class="ticket-status-panel tone-review"/);
  assert.match(review, /class="status-symbol" aria-hidden="true">✓<\/span>review/);

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\.ticket-status-panel\s*\{[^}]*background:\s*linear-gradient\(145deg, var\(--status-surface\), var\(--status-surface-end\)\);/s);
  assert.doesNotMatch(html, /\.ticket-status-panel::after|radial-gradient\(circle at 88% 7%/,
    "the status card stays flat and boarding-pass-like, without decorative texture");
  assert.match(html, /\.ticket-status-panel\.tone-planning\s*\{[^}]*#0a2028/s);
  assert.match(html, /\.ticket-status-panel\.tone-review\s*\{[^}]*#1a1b32/s,
    "Planning uses a cyan gradient while Review uses a distinct indigo gradient");
});

test("review keeps only the compact actionable status strip", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    task: { id: "review", status: "review", agent_profile: "reviewer" },
    taskStatus: "review", plan: PLAN, progress: {}, agentProgress: {}, activities: [],
    status: "every step is done · human review required",
  });

  assert.doesNotMatch(out, />lifecycle<\/span>|>agent<\/span>|>decisions<\/span>|>now<\/span>/);
  assert.doesNotMatch(out, /status-wave-head|class="wave-bars"/);
  assert.doesNotMatch(out, /every step is done · human review required/,
    "the strip does not repeat the detailed current-state sentence");
  assert.match(out, /class="autos autonomy-badge"/);
});

test("review omits agent detail even while follow-up work is active", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    task: { id: "review", status: "review", agent_profile: "previous-builder" },
    taskStatus: "review", plan: PLAN,
    progress: { steps: { "1": { status: "in_progress", agent_profile: "review-fix" } } },
    agentProgress: {}, activities: [],
  });

  assert.doesNotMatch(out, /review-fix|waiting for human review|previous-builder/,
    "agent detail belongs in execution activity, not the compact status strip");
});

test("the deliverables rail shows one row for one PR URL", () => {
  const { renderConversation } = threadHelpers();
  const url = "https://github.com/acme/app/pull/687";
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    task: { id: "review", status: "review" }, taskStatus: "review", activities: [],
    deliverables: [
      { id: "a", deliverable_type: "pull_request", title: "Pull Request #687", path: url },
      { id: "b", deliverable_type: "pr", title: "Pull Request #687", path: url },
      { id: "c", deliverable_type: "pr", title: "Pull request", path: url },
    ],
  });

  assert.equal((out.match(/class="drow3"/g) || []).length, 1);
  assert.equal((out.match(/Pull Request #687/g) || []).length, 1);
});

test("the rail's activity reads newest first", () => {
  // The question it answers is "what is it doing now", and making someone scroll a
  // column to reach the answer defeats having a column.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "step_completed", message: "OLDEST", created_at: "2026-08-14T01:00:00Z" },
      { activity_type: "step_completed", message: "NEWEST", created_at: "2026-08-14T02:00:00Z" },
    ] });
  const rail = out.split('<aside class="decisions">')[1];
  assert.ok(rail.indexOf("NEWEST") < rail.indexOf("OLDEST"));
});

test("the activity timeline shows five rows before scrolling older events", () => {
  const { renderConversation } = threadHelpers();
  const activities = Array.from({ length: 7 }, (_, i) => ({
    activity_type: "step_completed",
    message: `Event ${i + 1}`,
    created_at: `2026-08-14T0${i + 1}:00:00Z`,
  }));
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress", activities,
  });
  const rail = out.split('<aside class="decisions">')[1];
  assert.equal((rail.match(/class="activity-item cevent event"/g) || []).length, 7,
    "older events remain in the scrollable timeline");
  assert.match(rail, /class="activity-count">7</);
  assert.match(rail, /class="dacts" tabindex="0" aria-label="Ticket activity timeline"/);

  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  assert.match(html, /\.dacts\s*\{[^}]*height:\s*340px;[^}]*overflow-y:\s*auto;/s);
  assert.match(html, /\.activity-item\s*\{[^}]*height:\s*68px;/s,
    "the scroll viewport is exactly five timeline rows tall");
});

test("settled decisions collapse while unfinished decisions stay open", () => {
  const { renderConversation } = threadHelpers();
  const settled = renderConversation({ questions: SETTLED, confirmed: true }, null, {});
  const open = renderConversation({ questions: [...SETTLED, { id: "c", question: "Which repo?" }] }, null, {});

  assert.match(settled, /<details class="dsec decision-section" >[\s\S]*?2\/2/,
    "the settled receipt stays available behind its summary");
  assert.doesNotMatch(settled, /<details class="dsec decision-section" open>/);
  assert.match(open, /<details class="dsec decision-section" open>[\s\S]*?2\/3/);
});

test("the gate says why it is stopping you", () => {
  // A verdict you cannot see is one you cannot disagree with — which is the exact
  // failure this gate replaces, not a property it should inherit.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({
    questions: SETTLED,
    assessed_level: "careful",
    assessed_why: ["spans 2 repos", "no verify command that runs on the base commit"],
  }, null, {});
  assert.match(out, /data-act="confirm"/);
  assert.match(out, /class="cwhy"/);
  assert.match(out, /careful/);
  assert.match(out, /spans 2 repos · no verify command/);
});

test("no assessment recorded means no invented explanation", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED }, null, {});
  assert.match(out, /data-act="confirm"/, "the gate still holds");
  assert.doesNotMatch(out, /class="cwhy"/, "but it does not make up a reason");
});

test("a parked ticket is not reported as being in Intake", () => {
  // `findIndex` returns -1 for a status that is not a leg, and clamping that to 0
  // said "Intake · now" about a ticket that had already planned and built.
  const { renderTicket } = threadHelpers();
  const base = { id: "t", title: "T", created_at: "2026-08-11T10:00:00Z", updated_at: "2026-08-14T10:00:00Z" };
  const parked = renderTicket({ ...base, status: "on_hold" }, { questions: SETTLED }, []);
  assert.match(parked, /class="tk-off">on hold</, "the status is named, since no leg can point at it");
  assert.doesNotMatch(parked, /class="now"/, "and no leg claims to be current");

  const live = renderTicket({ ...base, status: "planning" }, { questions: SETTLED }, []);
  assert.match(live, /class="now"/, "a real leg still lights up");
  assert.doesNotMatch(live, /class="tk-off"/);
});

test("every activity entry says when it happened", () => {
  // Without a time it is a list of things that happened in no particular when —
  // and "is it stuck?" is the question that column exists to answer.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "step_completed", message: "Step 2 completed", created_at: "2026-08-14T09:15:00Z" },
      { activity_type: "updated", message: "Agent spawn failed for repo/x", created_at: "2026-08-14T09:20:00Z" },
    ] });
  const rail = out.split('<aside class="decisions">')[1];
  assert.equal((rail.match(/class="ts"/g) || []).length, 2, "one stamp per entry");
  assert.match(rail, /class="activity-item cevent bad"[\s\S]*?class="ts"/,
    "including the ones that went wrong");
});

test("pure heartbeat history does not crowd the timeline", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "updated", message: "Agent heartbeat: running.", created_at: "2026-08-14T09:00:00Z" },
      { activity_type: "updated", message: "Agent heartbeat: running.", created_at: "2026-08-14T09:01:00Z" },
    ] });
  const rail = out.split('<aside class="decisions">')[1];
  assert.doesNotMatch(rail, /Activity|Agent heartbeat|routine updates/);
});

test("repeated real events remain individual timeline entries", () => {
  const { renderConversation } = threadHelpers();
  const repeated = Array.from({ length: 13 }, (_, i) => ({
    activity_type: "updated",
    message: "Agent spawn failed for GitProjects/mc-demo-sandbox (attempt 1).",
    created_at: `2026-08-14T10:${String(i).padStart(2, "0")}:00Z`,
  }));
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { taskStatus: "in_progress", activities: [
      ...repeated, { activity_type: "step_completed", message: "Step 1 completed", created_at: "2026-08-14T11:00:00Z" }] });
  const rail = out.split('<aside class="decisions">')[1];

  assert.equal((rail.match(/class="activity-item cevent bad"/g) || []).length, 13);
  assert.match(rail, /class="activity-count">14</);
  assert.match(rail, /Step 1 completed/);
});

test("different messages are not merged just because they are adjacent", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "step_completed", message: "Step 1 completed", created_at: "1" },
      { activity_type: "step_completed", message: "Step 2 completed", created_at: "2" },
    ] });
  const rail = out.split('<aside class="decisions">')[1];
  assert.match(rail, /Step 1 completed/);
  assert.match(rail, /Step 2 completed/);
  assert.doesNotMatch(rail, /class="xn"/);
});

test("quoting an error is not the same as being one", () => {
  // Matching "could not" anywhere turned the whole column amber: a planner
  // question quotes the error it is asking about, and a prompt dump quotes the
  // ticket. Trouble is anchored at the start now, plus the types that mean it
  // whatever the wording.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, confirmed: true }, null, {
    taskStatus: "in_progress",
    activities: [
      { activity_type: "updated", message: "Agent spawn failed for repo/x (attempt 1).", created_at: "3" },
      { activity_type: "step_escalated", message: "Step 2 handed to a deeper model", created_at: "4" },
      { activity_type: "plan_created", message: "Planning wrote 01-PLAN.md — it could not have been clearer", created_at: "5" },
    ] });
  const rail = out.split('<aside class="decisions">')[1];
  assert.equal((rail.match(/class="activity-item cevent bad"/g) || []).length, 2,
    "the failure and the escalation");
  assert.match(rail, /class="activity-item cevent event">[\s\S]*?Planning wrote/,
    "a milestone that merely says 'could not' is not one");
});

// ─────────── autonomy presets (design 4a) ───────────

test("Auto stays concise while its assessment can still be disagreed with", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({
    questions: SETTLED, assessed_level: "normal",
    assessed_why: ["one repo", "can push, so a mistake leaves this machine"],
  }, null, {});
  assert.match(out, /Autonomy/);
  assert.match(out, /<span class="cur">Auto<\/span>/);
  assert.doesNotMatch(out, /Auto · normal/, "the assessed level does not clutter the current autonomy label");
  for (const level of ["simple", "normal", "careful"]) {
    assert.match(out, new RegExp(`data-level="${level}"`), `${level} is choosable`);
  }
  assert.match(out, /data-level=""/, "and so is handing it back to the rules");
  assert.match(out, /can push, so a mistake leaves this machine/, "with the reasoning");
});

test("an explicit choice is marked, and Auto is not the marked one", () => {
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED, process_level: "careful" }, null, {});
  assert.match(out, /class="lvl on" data-level="careful"/);
  assert.doesNotMatch(out, /class="lvl on" data-level=""/);
});

test("no permission matrix is drawn, because nothing enforces one", () => {
  // The design's rows — push the branch, open the PR, install dependencies,
  // migrations — have no mechanism behind them: `no_pr` is a line in a prompt.
  // Switches would promise a guarantee the system cannot keep.
  const { renderConversation } = threadHelpers();
  const out = renderConversation({ questions: SETTLED }, null, {});
  for (const claim of [/Push the branch/, /Open the PR/, /Install dependencies/, /Migrations/]) {
    assert.doesNotMatch(out, claim);
  }
});

test("choosing a level writes where the bridge reads it", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const fn = html.slice(html.indexOf("async function setProcessLevel("), html.indexOf("async function setProcessLevel(") + 700);
  assert.match(fn, /process_level/);
  assert.match(fn, /triage-state/, "the same state process_level.requires_confirmation consults");
  assert.match(fn, /load\(\{ force: true \}\)/, "and the gate re-evaluates immediately");
});

test("repeated checkpoints stay separate while interleaved heartbeats are omitted", () => {
  const { renderConversation } = threadHelpers();
  const activities = [];
  for (let i = 0; i < 5; i++) {
    activities.push({ activity_type: "checkpoint_raised", message: "Escalated to human: planning could not start",
                      created_at: `2026-08-14T1${i}:00:00Z` });
    activities.push({ activity_type: "updated", message: "Agent heartbeat: running.",
                      created_at: `2026-08-14T1${i}:30:00Z` });
  }
  const rail = renderConversation({ questions: SETTLED, confirmed: true }, null,
    { taskStatus: "in_progress", activities }).split('<aside class="decisions">')[1];

  assert.equal((rail.match(/class="activity-item cevent bad"/g) || []).length, 5);
  assert.doesNotMatch(rail, /Agent heartbeat|class="xn"/);
});
