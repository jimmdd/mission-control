import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { McEventBus } from "../src/events.ts";
import { readBusConfig, telegramInboundReady, slackInboundReady } from "../src/messagebus/config.ts";
import { shouldSend, formatEvent } from "../src/messagebus/format.ts";
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

test("formatted alert names the ticket and how to act on it", () => {
  const text = formatEvent({ type: "needs_human", taskId: "0e46593f-f94e-4b32", message: "which repo?" });
  assert.match(text, /🔔/);
  assert.match(text, /which repo\?/);
  assert.match(text, /\/task 0e46593f/, "the alert must carry a usable ref");
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
  assert.equal((await resolveTask(api, "ownership")).task?.id, TASKS[1].id);
  assert.match((await resolveTask(api, "MET")).error ?? "", /matches 2 tickets/);
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
  assert.match(reply, /\/confirm 8225f25a/);
});

test("/answer on a review ticket lands as manual_feedback, which relaunches the agent", async () => {
  const api = stubApi(TASKS);
  const reply = await executeCommand("/answer 0e46593f the header is duplicated", ctxFor(api));
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

test("/approve needs no ref when exactly one checkpoint is pending; /deny needs a reason", async () => {
  const checkpoints = [{ id: "3f21aaaa-bbbb", task_id: TASKS[0].id, kind: "approval", prompt: "open the PR?" }];
  const api = stubApi(TASKS, { checkpoints, postResult: { checkpoint: { task_id: TASKS[0].id } } });
  const reply = await executeCommand("/approve", ctxFor(api));
  const post = api.calls.find((c) => c[0] === "POST");
  assert.equal(post[1], "/checkpoints/3f21aaaa-bbbb/resolve");
  assert.equal(post[2].decision, "approve");
  assert.match(reply, /Approved/);

  const two = stubApi(TASKS, { checkpoints: [...checkpoints, { id: "9999cccc", task_id: TASKS[1].id, prompt: "x" }] });
  assert.match(await executeCommand("/approve", ctxFor(two)), /2 pending — name one/);

  const noReason = stubApi(TASKS, { checkpoints });
  assert.match(await executeCommand("/deny 3f21", ctxFor(noReason)), /reason is what the agent acts on/);

  const denied = stubApi(TASKS, { checkpoints, postResult: { checkpoint: { task_id: TASKS[0].id } } });
  await executeCommand("/deny 3f21 wrong repo", ctxFor(denied));
  const denyPost = denied.calls.find((c) => c[0] === "POST");
  assert.equal(denyPost[2].decision, "reject");
  assert.equal(denyPost[2].response, "wrong repo");
});

test("/followup validates the action against the canned set", async () => {
  const api = stubApi(TASKS);
  assert.match(await executeCommand("/followup 0e46593f nonsense", ctxFor(api)), /actions: review_comments/);
  await executeCommand("/followup 0e46593f ci_lint", ctxFor(api));
  const post = api.calls.find((c) => c[0] === "POST");
  assert.equal(post[1], `/tasks/${TASKS[0].id}/followup`);
  assert.equal(post[2].action, "ci_lint");
});

test("/status and /tasks summarise without needing a ref", async () => {
  const api = stubApi(TASKS, { checkpoints: [{ id: "c1", task_id: TASKS[0].id, prompt: "p" }] });
  const status = await executeCommand("/status", ctxFor(api));
  assert.match(status, /review 1/);
  assert.match(status, /Pending approvals: 1/);
  assert.match(status, /unanswered questions: 1/);

  const list = await executeCommand("/tasks", ctxFor(api));
  assert.match(list, /needing attention/);
  assert.match(list, /0e46593f/);
  assert.match(await executeCommand("/tasks done", ctxFor(api)), /No tasks with status "done"/);
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
