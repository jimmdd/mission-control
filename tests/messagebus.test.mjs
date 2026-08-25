import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { McEventBus } from "../src/events.ts";
import { readBusConfig, telegramInboundReady, slackInboundReady } from "../src/messagebus/config.ts";
import { shouldSend, formatEvent } from "../src/messagebus/format.ts";
import { linearKey, normalizeRef, takeRef, taskLabel, taskTitle } from "../src/messagebus/ref.ts";
import { executeCommand, parseCommand, resolveTask } from "../src/messagebus/commands.ts";
import { startMessageBus, makeInboundHandler } from "../src/messagebus/index.ts";
import { askAssistant, boardSnapshot } from "../src/messagebus/assistant.ts";
import { createOneShotRunner, parseOneShotCommand, resolveOneShotRepo } from "../src/messagebus/one-shot.ts";
import { agentEnvironment } from "../src/messagebus/one-shot-worker.ts";

const SILENT = { info() {}, error() {} };

function withHome(env) {
  const home = mkdtempSync(join(tmpdir(), "mc-bus-"));
  writeFileSync(
    join(home, ".env"),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  return home;
}

// A stub of the local API: records writes, serves canned reads.
function stubApi(tasks = [], extras = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(["GET", path]);
      if (path === "/tasks") return tasks;
      if (path === "/checkpoints") return extras.checkpoints ?? [];
      if (path === "/agents") return extras.agents ?? [];
      if (path.endsWith("/activities")) return extras.activities ?? [];
      return null;
    },
    post: async (path, body) => {
      calls.push(["POST", path, body]);
      return extras.postResult ?? { success: true };
    },
    patch: async (path, body) => {
      calls.push(["PATCH", path, body]);
      return { success: true };
    },
  };
}

const ctxFor = (api) => ({ api, surface: "telegram", actor: "telegram:@tester" });

test("config is read live from MC_HOME/.env, not just process.env", () => {
  const home = withHome({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_CHAT_IDS: "555, 666",
    TELEGRAM_INTERACTION: "command",
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_ALLOWED_USER_IDS: "U123",
    SLACK_EVENTS: "all",
  });
  try {
    const cfg = readBusConfig(home);
    assert.equal(cfg.telegram.token, "123:abc");
    assert.deepEqual(cfg.telegram.chatIds, ["555", "666"]);
    assert.equal(cfg.telegram.interaction, "command");
    assert.equal(cfg.telegram.events, "action", "defaults to the quiet event set");
    assert.equal(cfg.slack.events, "all");
    assert.equal(cfg.slack.interaction, "notify", "defaults to outbound-only");

    // Telegram can command with just a bot token; Slack needs the Socket Mode app token.
    assert.equal(telegramInboundReady(cfg.telegram), true);
    assert.equal(slackInboundReady(cfg.slack), false);

    const withApp = readBusConfig(withHome({
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_APP_TOKEN: "xapp-1",
      SLACK_ALLOWED_USER_IDS: "U123",
      SLACK_INTERACTION: "command",
    }));
    assert.equal(slackInboundReady(withApp.slack), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/create makes one linked Linear + MC ticket with a transport idempotency key", async () => {
  const api = stubApi([], {
    postResult: {
      created: true,
      issue: { id: "linear-id", identifier: "MET-700", url: "https://linear.app/issue/MET-700" },
      task: { id: "task-id", title: "[MET-700] Fix payout totals" },
    },
  });
  const reply = await executeCommand(
    "/create [met] Fix payout totals | Totals are stale after settlement",
    { ...ctxFor(api), requestId: "telegram:555:991" },
  );
  const post = api.calls.find((call) => call[0] === "POST");
  assert.deepEqual(post, ["POST", "/linear/issues", {
    title: "Fix payout totals",
    description: "Totals are stale after settlement",
    team_key: "MET",
    request_id: "telegram:555:991",
    actor: "telegram:@tester",
  }]);
  assert.match(reply, /Created MET-700/);
  assert.match(reply, /linear\.app\/issue\/MET-700/);
  assert.match(reply, /will triage it now/);
});

test("/create accepts the configured default team and keeps long detail out of the title", async () => {
  const api = stubApi([], {
    postResult: {
      created: false,
      issue: { id: "linear-id", identifier: "MET-700", url: "https://linear.app/issue/MET-700" },
      task: { id: "task-id", title: "[MET-700] Fix payout totals" },
    },
  });
  const reply = await executeCommand(
    "/create Fix payout totals | Preserve this full detail",
    { ...ctxFor(api), requestId: "telegram:555:991" },
  );
  const body = api.calls.find((call) => call[0] === "POST")[2];
  assert.equal(body.title, "Fix payout totals");
  assert.equal(body.description, "Preserve this full detail");
  assert.equal("team_key" in body, false);
  assert.match(reply, /Already created MET-700/);
});

test("event routing: action set by default, never the chatty ones", () => {
  assert.equal(shouldSend("needs_human", "action"), true);
  assert.equal(shouldSend("task_completed", "action"), true);
  assert.equal(shouldSend("delegated", "action"), false);
  assert.equal(shouldSend("delegated", "all"), true);
  assert.equal(shouldSend("progress", "all"), false, "progress would flood the chat");
  assert.equal(shouldSend("liveness", "all"), false);
  assert.equal(shouldSend("settings_updated", "all"), false, "would echo the edit that enabled the bus");
});

test("an alert names the ticket the way a person does, not by UUID", () => {
  const text = formatEvent(
    { type: "needs_human", taskId: "0e46593f-f94e-4b32-a91a-1d8ce72f43c6", message: "which repo?" },
    { label: "MET-639", title: "metalex for new ui", url: "https://linear.app/x/issue/MET-639/metalex" },
  );
  assert.match(text, /🔔/);
  assert.match(text, /^🔔 MET-639 needs you$/m, "a key is a name — no \"Task\" prefix in front of it");
  assert.match(text, /metalex for new ui/, "and the title, so it needs no lookup");
  assert.match(text, /which repo\?/);
  assert.match(text, /↳ \/task MET-639/, "the footer must be typeable as-is");
  assert.doesNotMatch(text, /0e46593f/, "no raw id anywhere in a human-facing alert");
});

test("an alert falls back to the short id when the ticket cannot be resolved", () => {
  const stalled = formatEvent({ type: "agent_stalled", taskId: "df544305-b413-4f8e", reason: "no heartbeat" });
  assert.match(stalled, /Agent stalled on df544305/, "better a short id than nothing");
  assert.match(stalled, /no heartbeat/);

  // Unresolved, the shared wording keeps its "Task" prefix — "df544305 needs you" alone
  // does not read as a sentence, whereas "MET-639 needs you" does.
  const blocked = formatEvent({ type: "needs_human", taskId: "df544305-b413-4f8e", message: "stuck" });
  assert.match(blocked, /Task df544305 needs you/);
});

test("a terminal completion alert says the ticket is done", () => {
  const text = formatEvent(
    { type: "task_completed", taskId: "e46ee493-ac62-47cd-9eb9-4d49d99bfd75", status: "done" },
    { label: "MET-640", title: "Implement canonical navbar" },
  );
  assert.match(text, /^✅ MET-640 is done$/m);
  assert.match(text, /Implement canonical navbar/);
});

test("ref helpers: keys come from the title or the issue URL, loosely typed", () => {
  assert.equal(linearKey({ title: "[MET-639] metalex for new ui" }), "MET-639");
  assert.equal(linearKey({ external_url: "https://linear.app/org/issue/MET-501/foredefi" }), "MET-501");
  assert.equal(linearKey({ title: "no key here" }), null);
  assert.equal(taskLabel({ id: "0e46593f-f94e", title: "no key here" }), "0e46593f");
  assert.equal(taskTitle({ title: "[MET-639] metalex for new ui" }), "metalex for new ui");

  // "met 635" is how a person types it.
  assert.equal(normalizeRef("met 635"), "MET-635");
  assert.equal(normalizeRef("met-635"), "MET-635");
  assert.equal(normalizeRef("MET635"), "MET-635");
  assert.equal(normalizeRef("met_635"), "MET-635");
  assert.equal(normalizeRef("ownership card"), "ownership card", "prose is left alone");

  // A two-token key must not swallow the rest of the sentence, or eat the ref.
  assert.deepEqual(takeRef("met 635 use main"), { ref: "MET-635", rest: "use main" });
  assert.deepEqual(takeRef("MET-635 use main"), { ref: "MET-635", rest: "use main" });
  assert.deepEqual(takeRef("2 wrong repo"), { ref: "2", rest: "wrong repo" });
});

test("outbound fans out to both surfaces and dedups per surface+type+task", async () => {
  const home = withHome({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_ALLOWED_CHAT_IDS: "555",
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_ALLOWED_USER_IDS: "U1",
  });
  const events = new McEventBus();
  const sent = { telegram: [], slack: [] };
  let clock = 0;
  const stop = startMessageBus(events, {
    mcHome: home,
    apiBaseUrl: "http://127.0.0.1:1",
    logger: SILENT,
    inbound: false,
    cooldownMs: 60_000,
    now: () => clock,
    senders: {
      telegram: async (target, text) => { sent.telegram.push([target, text]); },
      slack: async (target, text) => { sent.slack.push([target, text]); },
    },
  });
  try {
    events.emit("needs_human", { taskId: "t1", message: "blocked" });
    events.emit("needs_human", { taskId: "t1", message: "blocked again" }); // inside cooldown
    events.emit("progress", { taskId: "t1" }); // never sent
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sent.telegram.length, 1, "second identical event is muted");
    assert.equal(sent.slack.length, 1);
    assert.equal(sent.telegram[0][0], "555");
    assert.equal(sent.slack[0][0], "U1");

    clock += 61_000; // cooldown elapsed
    events.emit("needs_human", { taskId: "t1", message: "still blocked" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.telegram.length, 2, "same event sends again once the window passes");
  } finally {
    stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a surface set to off receives nothing", async () => {
  const home = withHome({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_ALLOWED_CHAT_IDS: "555",
    TELEGRAM_INTERACTION: "off",
  });
  const events = new McEventBus();
  const sent = [];
  const stop = startMessageBus(events, {
    mcHome: home,
    apiBaseUrl: "http://127.0.0.1:1",
    logger: SILENT,
    inbound: false,
    senders: { telegram: async (t, x) => { sent.push([t, x]); } },
  });
  try {
    events.emit("needs_human", { taskId: "t1", message: "blocked" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 0);
  } finally {
    stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseCommand accepts slash, bare and @botname forms, ignores chatter", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status", rest: "" });
  assert.deepEqual(parseCommand("status"), { name: "status", rest: "" });
  assert.deepEqual(parseCommand("/status@mc_bot"), { name: "status", rest: "" });
  assert.deepEqual(parseCommand("/answer abc123 use UTC"), { name: "answer", rest: "abc123 use UTC" });
  assert.deepEqual(parseCommand("/hold@mc_bot MET-639"), { name: "hold", rest: "MET-639" });
  assert.equal(parseCommand("thanks, that worked"), null);
  assert.equal(parseCommand("/nonsense"), null);
});

const TASKS = [
  { id: "0e46593f-f94e-4b32-a91a-1d8ce72f43c6", title: "[MET-639] metalex for new ui", status: "review", priority: "normal" },
  { id: "8225f25a-1111-2222-3333-444455556666", title: "[MET-636] Ownership card", status: "planning", priority: "high",
    triage_state: JSON.stringify({ questions: [
      { id: "q1", question: "Which repo?", answer: "backend" },
      { id: "q2", question: "Base branch?" },
    ], confirmed: false }) },
];

test("refs resolve by short id, Linear key and title — ambiguity is reported", async () => {
  const api = stubApi(TASKS);
  assert.equal((await resolveTask(api, "0e46593f")).task?.id, TASKS[0].id);
  assert.equal((await resolveTask(api, "MET-636")).task?.id, TASKS[1].id);
  assert.equal((await resolveTask(api, "met-636")).task?.id, TASKS[1].id);
  assert.equal((await resolveTask(api, "met 636")).task?.id, TASKS[1].id, "spaced key is the natural form");
  assert.equal((await resolveTask(api, "MET636")).task?.id, TASKS[1].id);
  assert.equal((await resolveTask(api, "ownership")).task?.id, TASKS[1].id);
  const ambiguous = (await resolveTask(api, "MET")).error ?? "";
  assert.match(ambiguous, /matches 2 tickets/);
  assert.match(ambiguous, /MET-639/, "the disambiguation list uses keys, not UUIDs");
  assert.doesNotMatch(ambiguous, /0e46593f/);
  assert.match((await resolveTask(api, "nope")).error ?? "", /No ticket matches/);
});

test("/answer fills the next unanswered triage question and un-confirms", async () => {
  const api = stubApi(TASKS);
  const reply = await executeCommand("/answer MET-636 main", ctxFor(api));
  const patch = api.calls.find((c) => c[0] === "PATCH");
  assert.ok(patch, "answering a triage question patches the task");
  const state = JSON.parse(patch[2].triage_state);
  assert.equal(state.questions[1].answer, "main");
  assert.equal(state.questions[1].answered_by, "user");
  assert.equal(state.questions[1].answered_via, "telegram");
  assert.equal(state.confirmed, false, "an edited answer must re-require confirmation");
  assert.match(reply, /All 2 questions answered/);
  assert.match(reply, /\/confirm MET-636/, "tell them the command in the form they type");
});

test("/answer on a review ticket lands as manual_feedback, which relaunches the agent", async () => {
  const api = stubApi(TASKS);
  const reply = await executeCommand("/answer met 639 the header is duplicated", ctxFor(api));
  const post = api.calls.find((c) => c[0] === "POST");
  assert.equal(post[1], `/tasks/${TASKS[0].id}/activities`);
  assert.equal(post[2].activity_type, "manual_feedback");
  assert.equal(post[2].message, "the header is duplicated", "the instruction reaches the agent unpolluted");
  assert.match(JSON.parse(post[2].metadata).surface, /telegram/);
  assert.match(reply, /relaunch/);
});

test("/confirm refuses while questions are open, then confirms", async () => {
  const open = await executeCommand("/confirm MET-636", ctxFor(stubApi(TASKS)));
  assert.match(open, /1 question\(s\) still unanswered/);

  const answered = [{ ...TASKS[1], triage_state: JSON.stringify({ questions: [
    { id: "q1", question: "Which repo?", answer: "backend" },
  ], confirmed: false }) }];
  const api = stubApi(answered);
  const reply = await executeCommand("/confirm MET-636", ctxFor(api));
  const patch = api.calls.find((c) => c[0] === "PATCH");
  const state = JSON.parse(patch[2].triage_state);
  assert.equal(state.confirmed, true);
  assert.equal(state.status, "answered");
  assert.match(reply, /dispatch/);
});

test("checkpoints are addressed by ticket, list number, or nothing at all", async () => {
  const cp = (id, taskId, prompt) => ({ id, task_id: taskId, kind: "approval", prompt });
  const one = [cp("3f21aaaa-bbbb", TASKS[0].id, "open the PR?")];

  // The list itself must be readable: keys and numbers, no UUIDs.
  const listed = await executeCommand("/checkpoints", ctxFor(stubApi(TASKS, { checkpoints: one })));
  assert.match(listed, /1\. MET-639 · approval/);
  assert.match(listed, /open the PR\?/);
  assert.doesNotMatch(listed, /3f21aaaa/, "checkpoint UUIDs are not for humans");

  // Bare: unambiguous when only one is pending.
  const bare = stubApi(TASKS, { checkpoints: one });
  const reply = await executeCommand("/approve", ctxFor(bare));
  assert.equal(bare.calls.find((c) => c[0] === "POST")[1], "/checkpoints/3f21aaaa-bbbb/resolve");
  assert.match(reply, /Approved on MET-639: "open the PR\?"/, "echo what was resolved, so a mis-aim is visible");

  // By ticket key, loosely typed.
  const byKey = stubApi(TASKS, { checkpoints: one });
  await executeCommand("/approve met 639 ship it", ctxFor(byKey));
  const keyPost = byKey.calls.find((c) => c[0] === "POST");
  assert.equal(keyPost[1], "/checkpoints/3f21aaaa-bbbb/resolve");
  assert.equal(keyPost[2].response, "ship it");

  // By list number, when one ticket has several or many are pending.
  const two = [...one, cp("9999cccc", TASKS[1].id, "pick a base branch")];
  const byNumber = stubApi(TASKS, { checkpoints: two });
  await executeCommand("/approve 2", ctxFor(byNumber));
  assert.equal(byNumber.calls.find((c) => c[0] === "POST")[1], "/checkpoints/9999cccc/resolve");

  const outOfRange = stubApi(TASKS, { checkpoints: two });
  assert.match(await executeCommand("/approve 7", ctxFor(outOfRange)), /no #7 — 2 pending/);

  // Ambiguous with no ref: refuse rather than guess.
  assert.match(await executeCommand("/approve", ctxFor(stubApi(TASKS, { checkpoints: two }))), /2 pending — say which/);

  // A reason is required to deny, and a bare reason is prose, not a ref.
  assert.match(
    await executeCommand("/deny met 639", ctxFor(stubApi(TASKS, { checkpoints: one }))),
    /reason is what the agent acts on/,
  );
  const prose = stubApi(TASKS, { checkpoints: one });
  await executeCommand("/deny wrong repo entirely", ctxFor(prose));
  const denyPost = prose.calls.find((c) => c[0] === "POST");
  assert.equal(denyPost[2].decision, "reject");
  assert.equal(denyPost[2].response, "wrong repo entirely", "a plain sentence is the reason, not a ticket ref");
});

test("/followup validates the action against the canned set", async () => {
  const api = stubApi(TASKS);
  assert.match(await executeCommand("/followup 0e46593f nonsense", ctxFor(api)), /actions: review_comments/);
  await executeCommand("/followup 0e46593f ci_lint", ctxFor(api));
  const post = api.calls.find((c) => c[0] === "POST");
  assert.equal(post[1], `/tasks/${TASKS[0].id}/followup`);
  assert.equal(post[2].action, "ci_lint");
});

test("/hold parks an active ticket through the same status update as the dashboard", async () => {
  const api = stubApi(TASKS);
  const reply = await executeCommand("/hold met 639", ctxFor(api));
  assert.deepEqual(api.calls.find((c) => c[0] === "PATCH"), [
    "PATCH",
    `/tasks/${TASKS[0].id}`,
    { status: "on_hold" },
  ]);
  assert.match(reply, /Put MET-639 on hold/);
  assert.match(reply, /plan, history, branch, and worktree are preserved/);
});

test("/hold is idempotent and does not reopen completed tickets", async () => {
  const heldApi = stubApi([{ ...TASKS[0], status: "on_hold" }]);
  assert.match(await executeCommand("/hold MET-639", ctxFor(heldApi)), /already on hold/);
  assert.equal(heldApi.calls.some((c) => c[0] === "PATCH"), false);

  const doneApi = stubApi([{ ...TASKS[0], status: "done" }]);
  assert.match(await executeCommand("/hold MET-639", ctxFor(doneApi)), /completed tickets cannot be put on hold/);
  assert.equal(doneApi.calls.some((c) => c[0] === "PATCH"), false);
});

test("/unhold returns only held tickets to the dispatch inbox", async () => {
  const heldApi = stubApi([{ ...TASKS[0], status: "on_hold" }]);
  const reply = await executeCommand("/unhold MET-639", ctxFor(heldApi));
  assert.deepEqual(heldApi.calls.find((c) => c[0] === "PATCH"), [
    "PATCH",
    `/tasks/${TASKS[0].id}`,
    { status: "inbox" },
  ]);
  assert.match(reply, /Resumed MET-639/);

  const activeApi = stubApi(TASKS);
  assert.match(await executeCommand("/unhold MET-639", ctxFor(activeApi)), /only held tickets can be resumed/);
  assert.equal(activeApi.calls.some((c) => c[0] === "PATCH"), false);

  const doneApi = stubApi([{ ...TASKS[0], status: "done" }]);
  assert.match(await executeCommand("/unhold MET-639", ctxFor(doneApi)), /completed tickets cannot be resumed/);
  assert.equal(doneApi.calls.some((c) => c[0] === "PATCH"), false);
});

test("/task shows the newest activities — the API returns them newest-first", async () => {
  const api = stubApi(TASKS, {
    activities: [
      { activity_type: "manual_feedback", message: "NEWEST" },
      { activity_type: "updated", message: "middle" },
      { activity_type: "lease_claimed", message: "OLDEST" },
      { activity_type: "created", message: "older still" },
    ],
  });
  const reply = await executeCommand("/task 0e46593f", ctxFor(api));
  assert.match(reply, /NEWEST/);
  assert.doesNotMatch(reply, /older still/, "the tail of the list is stale history");
});

test("/status and /tasks summarise without needing a ref", async () => {
  const api = stubApi(TASKS, { checkpoints: [{ id: "c1", task_id: TASKS[0].id, prompt: "p" }] });
  const status = await executeCommand("/status", ctxFor(api));
  assert.match(status, /review 1/);
  assert.match(status, /Pending approvals: 1/);
  assert.match(status, /unanswered questions: 1 \(MET-636\)/, "named by key");

  const list = await executeCommand("/tasks", ctxFor(api));
  assert.match(list, /needing attention/);
  assert.match(list, /MET-639 · review · metalex for new ui/, "listings read as key · status · title");
  assert.doesNotMatch(list, /0e46593f/, "no UUIDs in a listing");
  assert.match(await executeCommand("/tasks done", ctxFor(api)), /No tickets are done/);
});

test("/search matches on key, title and description; more words narrow", async () => {
  const tasks = [
    ...TASKS,
    { id: "aaaa1111-2222", title: "[MET-501] Foredefi", status: "planning",
      description: "wire the metalex validation path into the signing flow" },
    { id: "bbbb2222-3333", title: "[MET-100] old thing", status: "done", description: "metalex leftovers" },
  ];
  const api = stubApi(tasks);

  const hits = await executeCommand("/search metalex", ctxFor(api));
  assert.match(hits, /3 match "metalex" \(2 open\)/);
  assert.match(hits, /MET-639/, "title hit");
  assert.match(hits, /MET-501/, "description-only hit still counts");
  // Open work ranks above closed, and a title hit above a description-only one.
  assert.ok(hits.indexOf("MET-639") < hits.indexOf("MET-100"), "done tickets sink");

  // Adding a word narrows rather than widens.
  const narrowed = await executeCommand("/search metalex signing", ctxFor(api));
  assert.match(narrowed, /1 match/);
  assert.match(narrowed, /MET-501/);

  assert.match(await executeCommand("/search nothinglikethis", ctxFor(api)), /Nothing matches/);
  assert.match(await executeCommand("/find ownership", ctxFor(api)), /MET-636/, "/find is an alias");
});

test("/tasks falls back to search when the argument is not a status", async () => {
  const api = stubApi(TASKS);
  // A real status still filters.
  assert.match(await executeCommand("/tasks review", ctxFor(api)), /1 review/);
  assert.match(await executeCommand("/tasks done", ctxFor(api)), /No tickets are done/);
  // Anything else is obviously a search, not a status typo to be scolded about.
  const searched = await executeCommand("/tasks ownership", ctxFor(api));
  assert.match(searched, /match "ownership"/);
  assert.match(searched, /MET-636/);
});

test("a failing API surfaces as text, never as a thrown command", async () => {
  const api = {
    get: async () => { throw new Error("connect ECONNREFUSED"); },
    post: async () => ({}),
    patch: async () => ({}),
  };
  const reply = await executeCommand("/status", ctxFor(api));
  assert.match(reply, /Command failed: connect ECONNREFUSED/);
});

test("inbound: a command is run and answered on the same surface and target", async () => {
  const api = stubApi(TASKS);
  const replies = [];
  const handle = makeInboundHandler({
    api,
    logger: SILENT,
    send: async (surface, target, text) => { replies.push([surface, target, text]); },
  });

  await handle({ surface: "telegram", target: "555", userId: "42", userName: "jinglun", text: "/tasks" });
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].slice(0, 2), ["telegram", "555"]);
  assert.match(replies[0][2], /needing attention/);

  // Slack DMs reply into the same DM channel.
  await handle({ surface: "slack", target: "D123", userId: "U1", text: "/status" });
  assert.deepEqual(replies[1].slice(0, 2), ["slack", "D123"]);

  // Ordinary chatter gets no reply at all; a mistyped command gets a nudge.
  await handle({ surface: "telegram", target: "555", userId: "42", text: "thanks!" });
  assert.equal(replies.length, 2, "the bot does not answer non-commands");
  await handle({ surface: "telegram", target: "555", userId: "42", text: "/nope" });
  assert.match(replies[2][2], /Unknown command/);
});

test("Telegram can launch a no-ticket one-shot with an explicitly selected agent", async () => {
  const api = stubApi(TASKS);
  const replies = [];
  const starts = [];
  const handle = makeInboundHandler({
    api,
    logger: SILENT,
    send: async (surface, target, text) => { replies.push([surface, target, text]); },
    oneShot: {
      start: async (request) => {
        starts.push(request);
        return { jobId: "once-123", agent: request.agent, repo: request.repo };
      },
    },
  });

  await handle({
    surface: "telegram",
    target: "555",
    chatType: "private",
    userId: "42",
    userName: "jinglun",
    messageId: "991",
    text: "/run codex backend fix the mobile wallet integration test",
  });

  assert.deepEqual(starts, [{
    agent: "codex",
    repo: "backend",
    instruction: "fix the mobile wallet integration test",
    target: "555",
    actor: "telegram:@jinglun",
    requestId: "telegram:555:991",
  }]);
  assert.equal(api.calls.some((call) => call[0] === "POST"), false, "one-shot work must not create or update a ticket");
  assert.deepEqual(replies[0].slice(0, 2), ["telegram", "555"]);
  assert.match(replies[0][2], /Started once-123/);
  assert.match(replies[0][2], /report back here/);
});

test("Slack has no one-shot route or help entry", async () => {
  const starts = [];
  const replies = [];
  const handle = makeInboundHandler({
    api: stubApi(TASKS),
    logger: SILENT,
    send: async (surface, target, text) => { replies.push([surface, target, text]); },
    oneShot: {
      start: async (request) => {
        starts.push(request);
        return { jobId: "unsafe", agent: request.agent, repo: request.repo };
      },
    },
  });

  await handle({ surface: "slack", target: "D1", userId: "U1", text: "/run claude backend do anything" });
  assert.equal(starts.length, 0, "Slack must never reach the one-shot runner");
  assert.match(replies[0][2], /Unknown command/);

  await handle({ surface: "slack", target: "D1", userId: "U1", text: "/help" });
  assert.doesNotMatch(replies[1][2], /\/run/);

  await handle({ surface: "telegram", target: "555", chatType: "private", userId: "42", text: "/help" });
  assert.match(replies[2][2], /Telegram only/);
  assert.match(replies[2][2], /\/run <claude\|codex>/);

  await handle({ surface: "telegram", target: "group-1", chatType: "group", userId: "42", text: "/run codex backend do anything" });
  assert.equal(starts.length, 0, "Telegram group chats must not reach the one-shot runner");
  assert.match(replies[3][2], /Unknown command/);
});

test("one-shot parsing is explicit and repo resolution stays inside the execution allowlist", async () => {
  assert.deepEqual(parseOneShotCommand("/run@mc_bot Claude external/mission-control review PR 740"), {
    agent: "claude",
    repo: "external/mission-control",
    instruction: "review PR 740",
  });
  assert.throws(() => parseOneShotCommand("/run gemini backend investigate"), /claude or codex/);
  assert.throws(() => parseOneShotCommand("/run codex backend"), /Usage/);
  assert.equal(parseOneShotCommand("run codex backend do work"), null, "a slash is required to prevent accidental launches");

  const api = {
    get: async () => ({
      root: "/srv/GitProjects",
      repos: [
        { project: "GitProjects", repo: "backend", domain: "GitProjects/backend" },
        { project: "external", repo: "mission-control", domain: "external/mission-control" },
      ],
    }),
    post: async () => ({}),
    patch: async () => ({}),
  };
  assert.deepEqual(await resolveOneShotRepo(api, "backend"), {
    label: "GitProjects/backend",
    path: "/srv/GitProjects/backend",
  });
  assert.deepEqual(await resolveOneShotRepo(api, "external/mission-control"), {
    label: "external/mission-control",
    path: "/srv/GitProjects/external/mission-control",
  });
  await assert.rejects(() => resolveOneShotRepo(api, "not-allowed"), /not in Mission Control's repository allowlist/);
});

test("one-shot launch persists the Telegram return target and deduplicates a delivery retry", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-one-shot-"));
  const launched = [];
  const api = {
    get: async () => ({
      root: "/srv/GitProjects",
      repos: [{ project: "GitProjects", repo: "backend", domain: "GitProjects/backend" }],
    }),
    post: async () => { throw new Error("one-shot must not write to the task API"); },
    patch: async () => { throw new Error("one-shot must not write to the task API"); },
  };
  const runner = createOneShotRunner({ mcHome: home, api, launchWorker: (path) => { launched.push(path); } });
  const request = {
    agent: "claude",
    repo: "backend",
    instruction: "review the wallet integration test",
    target: "555",
    actor: "telegram:@jinglun",
    requestId: "telegram:555:991",
  };

  try {
    const first = await runner.start(request);
    const second = await runner.start(request);
    assert.equal(launched.length, 1, "the same Telegram update starts only one worker");
    assert.equal(second.alreadyStarted, true);
    assert.equal(second.jobId, first.jobId);
    const config = JSON.parse(readFileSync(launched[0], "utf-8"));
    assert.equal(config.telegramChatId, "555");
    assert.equal(config.agent, "claude");
    assert.equal(config.repoPath, "/srv/GitProjects/backend");
    assert.equal("taskId" in config, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the one-shot coding agent never receives chat or Mission Control control credentials", () => {
  const sensitive = {
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    SLACK_BOT_TOKEN: "slack-secret",
    SLACK_APP_TOKEN: "slack-app-secret",
    MISSION_CONTROL_ACCESS_TOKEN: "mc-secret",
    MISSION_CONTROL_ADMIN_TOKEN: "mc-admin-secret",
    MISSION_CONTROL_READ_ACCESS_TOKEN: "mc-read-secret",
    MISSION_CONTROL_READ_TOKEN: "mc-scoped-read-secret",
    MISSION_CONTROL_WRITE_TOKEN: "mc-write-secret",
    LINEAR_API_KEY: "linear-secret",
  };
  const previous = Object.fromEntries(Object.keys(sensitive).map((key) => [key, process.env[key]]));
  Object.assign(process.env, sensitive);
  try {
    const env = agentEnvironment({
      MC_AGENT_GIT_NAME: "MetaDAO Bot",
      MC_AGENT_GIT_EMAIL: "bot@example.com",
      MC_AGENT_GH_TOKEN: "github-bot-token",
    });
    for (const key of Object.keys(sensitive)) assert.equal(env[key], undefined, `${key} must be stripped`);
    assert.equal(env.GH_TOKEN, "github-bot-token");
    assert.equal(env.GIT_AUTHOR_NAME, "MetaDAO Bot");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("inbound: the actor is attributed in the activity metadata", async () => {
  const api = stubApi(TASKS);
  const handle = makeInboundHandler({ api, logger: SILENT, send: async () => {} });
  await handle({ surface: "telegram", target: "555", userId: "42", userName: "jinglun", text: "/answer 0e46593f fix it" });
  const post = api.calls.find((c) => c[0] === "POST");
  assert.equal(JSON.parse(post[2].metadata).actor, "telegram:@jinglun");
});

test("a reply that fails to send does not take the process down", async () => {
  const handle = makeInboundHandler({
    api: stubApi(TASKS),
    logger: SILENT,
    send: async () => { throw new Error("Telegram 403: bot blocked"); },
  });
  await handle({ surface: "telegram", target: "555", userId: "42", text: "/status" });
});

// ── natural-language assistant (Telegram only) ────────────────────────────────

// A stub model: returns whatever JSON the test wants, and records the prompt it saw.
function stubLlm(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const seen = [];
  const fn = async ({ system, prompt }) => {
    seen.push({ system, prompt });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === "string" ? next : JSON.stringify(next);
  };
  fn.seen = seen;
  return fn;
}

const assistantFor = (api, llm) => ({
  ask: (question) => askAssistant(question, { api, llm, logger: SILENT }),
  enabled: (surface) => surface === "telegram",
});

test("assistant answers a question from the board snapshot, no command", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm({ reply: "MET-636 is the only one in review.", command: null });
  const replies = [];
  const handle = makeInboundHandler({
    api, logger: SILENT,
    send: async (s, t, text) => { replies.push(text); },
    assistant: assistantFor(api, llm),
  });

  await handle({ surface: "telegram", target: "555", userId: "42", text: "what's in review?" });
  assert.equal(replies[0], "MET-636 is the only one in review.");
  // The snapshot must actually carry the board, or the model is guessing.
  assert.match(llm.seen[0].prompt, /MET-639/);
  assert.match(llm.seen[0].prompt, /Open tickets/);
  assert.match(llm.seen[0].prompt, /what's in review\?/);
});

test("a read-only proposal runs straight away", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm({ reply: "Here's what needs you:", command: "/tasks" });
  const replies = [];
  const handle = makeInboundHandler({
    api, logger: SILENT,
    send: async (s, t, text) => { replies.push(text); },
    assistant: assistantFor(api, llm),
  });

  await handle({ surface: "telegram", target: "555", userId: "42", text: "anything waiting on me?" });
  assert.match(replies[0], /Here's what needs you:/);
  assert.match(replies[0], /MET-639 · review/, "the command's own output is appended");
});

test("a write proposal is held until /yes, and /no drops it", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm({ reply: 'Post to MET-639 as feedback: "use UTC everywhere"', command: "/answer MET-639 use UTC everywhere" });
  const replies = [];
  const handle = makeInboundHandler({
    api, logger: SILENT,
    send: async (s, t, text) => { replies.push(text); },
    assistant: assistantFor(api, llm),
  });
  const msg = (text) => handle({ surface: "telegram", target: "555", userId: "42", text });

  await msg("tell 639 to use UTC everywhere");
  assert.match(replies[0], /→ \/answer MET-639 use UTC everywhere/);
  assert.match(replies[0], /Confirm\? \/yes · \/no/);
  assert.equal(api.calls.filter((c) => c[0] === "POST").length, 0, "nothing may be written before /yes");

  await msg("/yes");
  const post = api.calls.find((c) => c[0] === "POST");
  assert.equal(post[1], `/tasks/${TASKS[0].id}/activities`);
  assert.equal(post[2].message, "use UTC everywhere");

  // /no drops the next one without writing.
  await msg("tell 639 to use UTC everywhere");
  const before = api.calls.filter((c) => c[0] === "POST").length;
  await msg("/no");
  assert.match(replies.at(-1), /Dropped/);
  assert.equal(api.calls.filter((c) => c[0] === "POST").length, before);

  // A bare /yes with nothing pending must not resolve a stale proposal.
  await msg("yes");
  assert.match(replies.at(-1), /Nothing is waiting for confirmation/);
});

test("the Telegram assistant treats putting a ticket on hold as a confirmation-gated write", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm({ reply: "Put MET-639 on hold.", command: "/hold MET-639" });
  const outcome = await askAssistant("put 639 on hold", { api, llm, logger: SILENT });
  assert.deepEqual(outcome, {
    reply: "Put MET-639 on hold.",
    command: "/hold MET-639",
    kind: "write",
  });
  assert.equal(api.calls.some((c) => c[0] === "PATCH"), false, "classification alone must not mutate the ticket");
});

test("the Telegram assistant treats unhold as a confirmation-gated write", async () => {
  const api = stubApi([{ ...TASKS[0], status: "on_hold" }]);
  const llm = stubLlm({ reply: "Resume MET-639.", command: "/unhold MET-639" });
  const outcome = await askAssistant("unhold 639", { api, llm, logger: SILENT });
  assert.equal(outcome.kind, "write");
  assert.equal(outcome.command, "/unhold MET-639");
  assert.equal(api.calls.some((c) => c[0] === "PATCH"), false, "classification alone must not mutate the ticket");
});

test("the assistant never reaches Slack", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm({ reply: "should not be called", command: null });
  const replies = [];
  const handle = makeInboundHandler({
    api, logger: SILENT,
    send: async (s, t, text) => { replies.push([s, text]); },
    assistant: assistantFor(api, llm),
  });

  await handle({ surface: "slack", target: "D1", userId: "U1", text: "what's blocked?" });
  assert.equal(llm.seen.length, 0, "no generation call may be spent on a Slack message");
  assert.equal(replies.length, 0, "Slack stays commands-only");

  // Commands still work on Slack.
  await handle({ surface: "slack", target: "D1", userId: "U1", text: "/tasks" });
  assert.match(replies[0][1], /needing attention/);
});

test("a hallucinated or unparseable proposal is dropped, not offered", async () => {
  const api = stubApi(TASKS);
  const invented = stubLlm({ reply: "Deleting the repo now.", command: "/rm-rf --all" });
  let out = [];
  let handle = makeInboundHandler({
    api, logger: SILENT, send: async (s, t, text) => { out.push(text); }, assistant: assistantFor(api, invented),
  });
  await handle({ surface: "telegram", target: "555", userId: "42", text: "do something drastic" });
  assert.doesNotMatch(out[0], /rm-rf/, "an unknown command must never be offered for confirmation");
  assert.equal(api.calls.filter((c) => c[0] === "POST").length, 0);

  // Garbage instead of JSON degrades to a pointer at /help.
  out = [];
  const garbage = stubLlm("I'm afraid I can't do that, Dave.");
  handle = makeInboundHandler({
    api, logger: SILENT, send: async (s, t, text) => { out.push(text); }, assistant: assistantFor(api, garbage),
  });
  await handle({ surface: "telegram", target: "555", userId: "42", text: "hello" });
  assert.match(out[0], /\/help/);
});

test("a model that errors out reports as text, and writes nothing", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm(new Error("Gemini 429 rate limited"));
  const out = [];
  const handle = makeInboundHandler({
    api, logger: SILENT, send: async (s, t, text) => { out.push(text); }, assistant: assistantFor(api, llm),
  });
  await handle({ surface: "telegram", target: "555", userId: "42", text: "what's blocked?" });
  assert.match(out[0], /rate limited/);
  assert.equal(api.calls.filter((c) => c[0] === "POST").length, 0);
});

test("commands still win over the assistant", async () => {
  const api = stubApi(TASKS);
  const llm = stubLlm({ reply: "should not be called", command: null });
  const out = [];
  const handle = makeInboundHandler({
    api, logger: SILENT, send: async (s, t, text) => { out.push(text); }, assistant: assistantFor(api, llm),
  });
  await handle({ surface: "telegram", target: "555", userId: "42", text: "/status" });
  assert.equal(llm.seen.length, 0, "an exact command must not pay for a model call");
  assert.match(out[0], /Board:/);
});
