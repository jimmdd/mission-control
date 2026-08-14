// The ticket page is one ticket end to end: brief, what triage found, the open
// questions, the plan. The plan and its per-step progress are still written to disk
// by the Python planner, so the page reads them through /api/tasks/:id/plan.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
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

test("resetting a task that was never planned is not an error", async () => {
  await withHandler(async (handler, db) => {
    const task = db.createTask({ title: "never planned" });
    const res = mockRes();
    await handler(mockReq({ url: `/api/tasks/${task.id}/reset-triage`, method: "POST", body: {} }), res);
    assert.equal(res.statusCode, 200);
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

test("clicking decides and typing talks", () => {
  const { renderConversation } = convoHelpers();
  const out = renderConversation({ questions: CONVO }, null);
  // An option settles the question outright.
  assert.match(out, /data-answer="Host &amp; Link"/);
  // Typing has two destinations, and the safe one is a message.
  assert.match(out, /data-send="ask"/);
  assert.match(out, /data-send="answer"/);
  // The exits stay available on whichever question is in focus.
  assert.match(out, /data-act="delegate"/);
  assert.match(out, /data-act="defer"/);
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
  assert.doesNotMatch(out, /data-send="answer"/, "there is nothing to answer");
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

  // The composer says what the answer binds and what is left, not the question again.
  assert.match(out, /Your answer becomes <b>D-02<\/b>/);
  assert.match(out, /2 more after this/);
  // Exactly one askable question: only the live one carries pills. Settled ones
  // still hold their own question text inside their collapsed group, which is the
  // record, not a second thing to answer.
  assert.equal((out.match(/class="cpills"/g) || []).length, 1);
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
  assert.match(appJs, /\['planning', 'in_progress', 'review', 'on_hold', 'done'\]/);
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
