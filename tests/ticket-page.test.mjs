// The ticket page is one ticket end to end: brief, what triage found, the open
// questions, the plan. The plan and its per-step progress are still written to disk
// by the Python planner, so the page reads them through /api/tasks/:id/plan.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
async function withHandler(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-ticket-"));
  const priorHome = process.env.MC_HOME;
  process.env.MC_HOME = dir;
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    return await fn(createHandler(db, SILENT), db, dir);
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
  assert.equal((svg.match(/class="flow"/g) || []).length, 4, "one edge per declared dependency");
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

test("planner follow-ups lead the page and hide what is already answered", () => {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  const mod = new Function(`${shim}\n${body}\nreturn { followUps, renderFollowUps };`)();

  const qs = [
    { id: "t1", question: "Which app?", answer: "apps/new-ui", source: "triage" },
    { id: "p1", question: "Self-host the font or use Adobe CDN?", source: "planner" },
    { id: "p2", question: "Answered planner question", answer: "yes", source: "planner" },
  ];
  const open = mod.followUps(qs);
  assert.equal(open.length, 1, "only unanswered planner questions are follow-ups");
  assert.equal(open[0].id, "p1");

  const out = mod.renderFollowUps(open);
  assert.match(out, /Self-host the font/);
  // Answered ones belong in the collapsed decisions list, not here.
  assert.doesNotMatch(out, /Answered planner question/);
  assert.doesNotMatch(out, /Which app\?/, "triage questions are not follow-ups");
  // A follow-up means planning is stopped, and that has to be said, not implied.
  assert.match(out, /plan cannot be written until these are settled/);
  assert.match(out, /no code\s+should be written before the plan/);
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

// ─────────── the question block ───────────
// A question used to be a prompt and some options: enough to collect an answer, not
// enough to get a good one. These cover what it carries now, and the three exits
// that stop one unanswerable question holding up the other eight.

/** The page's pure render helpers, extracted headlessly. */
function questionHelpers() {
  const html = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*)<\/script>/.exec(html)[1].split("// ---- BOOTSTRAP ----")[0];
  const shim = `
    const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
  `;
  return new Function(`${shim}\n${body}\nreturn { renderQuestion, renderQuestions, renderFollowUps, followUps };`)();
}

test("a question says why it is being asked and what its answer binds", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({
    id: "q1",
    question: "Which font licence did we buy?",
    why: "Adobe Fonts terms forbid self-hosting; the implementation differs per licence.",
    becomes: "D-01",
    options: ["Web Project", "Desktop only"],
  }, "01");

  assert.match(out, /Adobe Fonts terms forbid self-hosting/, "the reason is shown");
  assert.match(out, /D-01/, "the decision it locks is named");
  // Without this the answer is a comment; with it, it is a spec.
  assert.match(out, /when answered/);
});

test("every open question offers the three exits", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({ id: "q1", question: "Page size?" }, "01");
  assert.match(out, /Ask about this/);
  assert.match(out, /Decide for me/);
  assert.match(out, /Decide later/);
  // Answering stays the default: the exits come after the ways to answer.
  assert.ok(out.indexOf("qadd") < out.indexOf("qouts"), "the exits follow the answer box");
});

test("an agent's pick reads as delegated, shows its reasoning, and can be taken back", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({
    id: "q3", question: "Default page size?", answer: "50",
    answered_by: "agent", reason: "the list renders 20 and prefetches one page ahead",
  }, "03");

  assert.match(out, /chosen by the agent/);
  assert.match(out, /Why:.*prefetches one page ahead/s, "the reasoning is legible enough to disagree with");
  assert.match(out, /data-act="reopen"/, "it can be taken back");
});

test("a human's answer is not dressed up as a delegated one", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({ id: "q1", question: "Which licence?", answer: "Web Project", answered_by: "you" }, "01");
  assert.doesNotMatch(out, /chosen by the agent/);
  assert.doesNotMatch(out, /data-act="reopen"/);
});

test("a deferred question is set aside, not counted as open", () => {
  const { renderQuestion, renderQuestions, followUps } = questionHelpers();
  const q = { id: "q2", question: "Rate limit?", deferred: true, source: "planner" };

  const out = renderQuestion(q, "02");
  assert.match(out, /not blocking anything/);
  assert.match(out, /Bring it back/);
  assert.doesNotMatch(out, /Decide for me/, "a set-aside question offers no exits");

  // Counting it would make "Decide later" a lie.
  assert.equal(followUps([q]).length, 0, "deferred follow-ups stop blocking");
  // But it is not answered either, and the header must not claim it was.
  const card = renderQuestions({ questions: [q] });
  assert.match(card, /0\/1/);
  assert.match(card, /1 set aside/);
});

test("a thread shows both sides, and says when a reply is owed", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({
    id: "q2", question: "Cursor on created_at or id?",
    thread: [
      { role: "you", text: "what would you pick, and why?" },
      { role: "research", text: "created_at, with id as a tiebreaker." },
      { role: "you", text: "is created_at indexed on that hypertable?" },
    ],
  }, "02");

  assert.match(out, /what would you pick/);
  assert.match(out, /created_at, with id as a tiebreaker/);
  // The last word is the human's, so an answer is owed — saying so beats an empty
  // box that looks like nothing happened.
  assert.match(out, /Working out an answer/);
  // The thread is already open, so the button that opens it is redundant — the
  // input's own placeholder still reads "Ask about this…".
  assert.doesNotMatch(out, /<button[^>]*>Ask about this<\/button>/);
});

test("a settled thread does not claim a reply is coming", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({
    id: "q2", question: "Cursor?",
    thread: [{ role: "you", text: "?" }, { role: "research", text: "created_at" }],
  }, "02");
  assert.doesNotMatch(out, /Working out an answer/);
});

test("a delegated question shows the handover instead of pretending to wait on you", () => {
  const { renderQuestion } = questionHelpers();
  const out = renderQuestion({ id: "q1", question: "Page size?", delegate_requested: true }, "01");
  assert.match(out, /the agent is deciding/);
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

test("a question appears in exactly one card", () => {
  // The follow-up card showed the planner's questions and the second card showed
  // all of them, so each planner question rendered twice — with two elements
  // sharing id="submit" (the second button wired to nothing) and two radio groups
  // sharing a name, so clicking an option in one silently drove the other.
  const { renderFollowUps, renderQuestions, followUps } = questionHelpers();
  const qs = [
    { id: "p1", source: "planner", question: "Which licence?" },
    { id: "t1", question: "Which base branch?", answer: "coda/new-ui", answered_by: "you" },
    { id: "t2", question: "Rate limit?", deferred: true },
  ];
  const page = renderFollowUps(followUps(qs)) + renderQuestions({ questions: qs });

  const times = (s) => (page.match(new RegExp(s, "g")) || []).length;
  assert.equal(times("Which licence\\?"), 1, "the planner question is not repeated");
  assert.equal(times('id="submit"'), 0, "no shared id");
  assert.equal(times('name="q-p1"'), 0, "an answered-elsewhere question has no stray radio group");
  // The opening questions still show — they are the decisions the planner was given.
  assert.match(page, /Which base branch/);
});

test("with nothing left outside the follow-ups, the second card does not appear", () => {
  const { renderFollowUps, renderQuestions, followUps } = questionHelpers();
  const qs = [{ id: "p1", source: "planner", question: "Which licence?" }];
  assert.equal(renderQuestions({ questions: qs }), "", "an empty card is not rendered");
  assert.match(renderFollowUps(followUps(qs)), /Which licence/);
});

test("each card carries its own submit, scoped to its own questions", () => {
  const { renderFollowUps, renderQuestions, followUps } = questionHelpers();
  const qs = [
    { id: "p1", source: "planner", question: "Which licence?" },
    { id: "t1", question: "Which base branch?" },
  ];
  const page = renderFollowUps(followUps(qs)) + renderQuestions({ questions: qs });
  assert.match(page, /data-submit="followups"/);
  assert.match(page, /data-submit="triage"/);
  assert.equal((page.match(/data-submit=/g) || []).length, 2);
  // Once the planner is the one asking, "Answer these to start" is no longer true.
  assert.match(page, /Already decided/);
});
