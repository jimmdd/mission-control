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

  // Nine locked decisions would dwarf a one-step plan, so the column is capped.
  assert.match(svg, /\+4 more, listed above/);
});
