import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { McEventBus } from "../src/events.ts";
import { readBusConfig, telegramInboundReady, slackInboundReady } from "../src/messagebus/config.ts";
import { shouldSend, formatEvent } from "../src/messagebus/format.ts";
import { linearKey, normalizeRef, takeRef, taskLabel, taskTitle } from "../src/messagebus/ref.ts";
import { executeCommand, parseCommand, resolveTask } from "../src/messagebus/commands.ts";
import { startMessageBus, makeInboundHandler } from "../src/messagebus/index.ts";

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
