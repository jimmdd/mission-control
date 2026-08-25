import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";
import {
  readBusConfig,
  slackChannelInboundReady,
} from "../src/messagebus/config.ts";
import { createSlackChannelHandler } from "../src/messagebus/slack-channel.ts";
import { classifySlackEnvelope } from "../src/messagebus/slack.ts";

function withEnv(values) {
  const dir = mkdtempSync(join(tmpdir(), "mc-slack-channel-env-"));
  writeFileSync(join(dir, ".env"), Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"));
  return dir;
}

function mockReq(url, method = "GET", body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.url = url;
  stream.method = method;
  stream.headers = { host: "localhost", "sec-fetch-site": "same-origin" };
  return stream;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers ?? {}); },
    end(body) { this.body = body ?? ""; },
  };
}

test("channel listener is separately gated by an explicit channel allowlist", () => {
  const disabled = withEnv({
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_APP_TOKEN: "xapp-1",
    SLACK_ALLOWED_USER_IDS: "U1",
    SLACK_INTERACTION: "command",
  });
  const enabled = withEnv({
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_APP_TOKEN: "xapp-1",
    SLACK_ALLOWED_USER_IDS: "U1",
    SLACK_ALLOWED_CHANNEL_IDS: "C1, C2",
    SLACK_INTERACTION: "command",
  });
  try {
    assert.equal(slackChannelInboundReady(readBusConfig(disabled).slack), false);
    const cfg = readBusConfig(enabled).slack;
    assert.deepEqual(cfg.channelIds, ["C1", "C2"]);
    assert.equal(slackChannelInboundReady(cfg), true);
  } finally {
    rmSync(disabled, { recursive: true, force: true });
    rmSync(enabled, { recursive: true, force: true });
  }
});

test("the checked-in Slack manifest requests exactly the channel-listener contract", () => {
  const manifest = JSON.parse(readFileSync(new URL("../docs/slack-app-manifest.json", import.meta.url), "utf8"));
  const scopes = new Set(manifest.oauth_config.scopes.bot);
  const events = new Set(manifest.settings.event_subscriptions.bot_events);
  for (const scope of ["app_mentions:read", "channels:history", "chat:write", "im:history", "im:write"]) {
    assert.ok(scopes.has(scope), `missing Slack scope ${scope}`);
  }
  for (const event of ["app_mention", "message.channels", "message.im"]) {
    assert.ok(events.has(event), `missing Slack event ${event}`);
  }
  assert.equal(manifest.settings.socket_mode_enabled, true);
});

test("Slack envelopes admit mentions and followed-thread replies, not channel chatter", () => {
  const opts = { botUserId: "UBOT", userIds: ["U1"], channelIds: ["C1"] };
  const mention = classifySlackEnvelope({
    type: "events_api",
    payload: {
      event_id: "Ev1",
      event: {
        type: "app_mention",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "<@UBOT> ship the channel listener",
        ts: "1723497600.100001",
      },
    },
  }, opts);
  assert.deepEqual(mention, {
    kind: "mention",
    channelId: "C1",
    threadTs: "1723497600.100001",
    messageTs: "1723497600.100001",
    userId: "U1",
    text: "ship the channel listener",
  });

  const reply = classifySlackEnvelope({
    type: "events_api",
    payload: {
      event_id: "Ev2",
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "Use Socket Mode",
        ts: "1723497601.100002",
        thread_ts: "1723497600.100001",
      },
    },
  }, opts);
  assert.equal(reply.kind, "reply");
  assert.equal(reply.threadTs, "1723497600.100001");

  const chatter = classifySlackEnvelope({
    type: "events_api",
    payload: { event: { type: "message", channel_type: "channel", channel: "C1", user: "U1", text: "hello", ts: "2.0" } },
  }, opts);
  assert.equal(chatter, null, "ordinary top-level channel messages are ignored");

  const wrongUser = classifySlackEnvelope({
    type: "events_api",
    payload: { event: { type: "app_mention", channel_type: "channel", channel: "C1", user: "U2", text: "<@UBOT> hi", ts: "3.0" } },
  }, opts);
  assert.equal(wrongUser, null);

  const wrongChannel = classifySlackEnvelope({
    type: "events_api",
    payload: { event: { type: "app_mention", channel_type: "channel", channel: "C9", user: "U1", text: "<@UBOT> hi", ts: "4.0" } },
  }, opts);
  assert.equal(wrongChannel, null);
});

test("a Slack thread maps atomically to one task and cascades on task deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-slack-channel-db-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    const input = {
      surface: "slack",
      channel_id: "C1",
      thread_ts: "1723497600.100001",
      created_by_external_id: "U1",
      title: "ship the channel listener",
      description: "Created from a Slack channel mention.",
      source: "slack",
    };
    const first = db.createTaskForSurfaceThread(input);
    const retry = db.createTaskForSurfaceThread(input);

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.task.id, first.task.id);
    assert.equal(db.countTasks(), 1, "a retried Slack event cannot create a second ticket");
    assert.equal(db.getSurfaceThread("slack", "C1", input.thread_ts)?.task_id, first.task.id);

    db.deleteTask(first.task.id);
    assert.equal(db.getSurfaceThread("slack", "C1", input.thread_ts), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("surface-thread API creates once and resolves by indexed identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-slack-channel-api-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    const handler = createHandler(db, { info() {}, error() {} });
    const body = {
      surface: "slack",
      channel_id: "C123",
      thread_ts: "1723497600.100001",
      created_by_external_id: "U1",
      title: "ship listener",
      description: "ship listener",
    };
    const created = mockRes();
    await handler(mockReq("/api/surface-threads", "POST", body), created);
    assert.equal(created.statusCode, 201);

    const retry = mockRes();
    await handler(mockReq("/api/surface-threads", "POST", body), retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(JSON.parse(retry.body).task.id, JSON.parse(created.body).task.id);

    const found = mockRes();
    await handler(
      mockReq("/api/surface-threads?surface=slack&channel_id=C123&thread_ts=1723497600.100001"),
      found,
    );
    assert.equal(found.statusCode, 200);
    assert.equal(JSON.parse(found.body).task.title, "ship listener");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Linear issue API creates and links one MC task across retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-linear-create-api-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  const calls = [];
  try {
    const createLinearIssue = async (input) => {
      calls.push(input);
      return {
        created: calls.length === 1,
        issue: {
          id: "linear-uuid",
          identifier: "MET-700",
          title: "Fix payout totals",
          description: "Totals are stale",
          url: "https://linear.app/metadao/issue/MET-700/fix-payout-totals",
          priority: 2,
          assignee: { name: "Jinglun", email: "jinglun@metadao.fi" },
        },
      };
    };
    const handler = createHandler(db, { info() {}, error() {} }, undefined, { createLinearIssue });
    const body = {
      title: "Fix payout totals",
      description: "Totals are stale",
      request_id: "telegram:555:991",
      team_key: "MET",
      actor: "telegram:@jinglun",
    };

    const created = mockRes();
    await handler(mockReq("/api/linear/issues", "POST", body), created);
    assert.equal(created.statusCode, 201);
    const first = JSON.parse(created.body);
    assert.equal(first.task.external_id, "linear-uuid");
    assert.equal(first.task.external_url, "https://linear.app/metadao/issue/MET-700/fix-payout-totals");
    assert.equal(first.task.title, "[MET-700] Fix payout totals");
    assert.equal(first.task.priority, "high");

    const retried = mockRes();
    await handler(mockReq("/api/linear/issues", "POST", body), retried);
    assert.equal(retried.statusCode, 200);
    assert.equal(JSON.parse(retried.body).task.id, first.task.id);
    assert.equal(db.countTasks(), 1);
    assert.equal(calls[0].requestId, "telegram:555:991");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Linear creation failure leaves no orphan MC task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-linear-create-fail-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    const handler = createHandler(db, { info() {}, error() {} }, undefined, {
      createLinearIssue: async () => { throw new Error("Linear unavailable"); },
    });
    const response = mockRes();
    await handler(mockReq("/api/linear/issues", "POST", {
      title: "Do not orphan this",
      request_id: "telegram:555:992",
    }), response);
    assert.equal(response.statusCode, 502);
    assert.match(JSON.parse(response.body).error, /Linear unavailable/);
    assert.equal(db.countTasks(), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("channel mentions create a ticket and later thread replies use the ticket input path", async () => {
  const calls = [];
  const sent = [];
  const task = { id: "task-1234", title: "ship listener", status: "review", triage_state: null };
  const api = {
    async get(path) {
      calls.push(["GET", path]);
      if (path.startsWith("/surface-threads?")) return { task };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      calls.push(["POST", path, body]);
      if (path === "/surface-threads") return { created: true, task };
      if (path === `/tasks/${task.id}/activities`) return { id: "activity-1" };
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path, body) {
      calls.push(["PATCH", path, body]);
      return task;
    },
  };
  const handle = createSlackChannelHandler({
    api,
    send: async (channelId, threadTs, text) => sent.push([channelId, threadTs, text]),
  });

  await handle({
    kind: "mention",
    channelId: "C1",
    threadTs: "1723497600.100001",
    messageTs: "1723497600.100001",
    userId: "U1",
    text: "ship listener",
  });
  assert.equal(calls[0][0], "POST");
  assert.equal(calls[0][1], "/surface-threads");
  assert.match(sent[0][2], /thread is linked/i);

  await handle({
    kind: "reply",
    channelId: "C1",
    threadTs: "1723497600.100001",
    messageTs: "1723497601.100002",
    userId: "U1",
    text: "Use Socket Mode",
  });
  const activity = calls.find((c) => c[0] === "POST" && c[1].endsWith("/activities"));
  assert.equal(activity[2].activity_type, "manual_feedback");
  assert.equal(activity[2].message, "Use Socket Mode");
  assert.match(sent.at(-1)[2], /relaunch/i);
});

test("a redelivered root mention acknowledges the existing link without duplicating input", async () => {
  const calls = [];
  const sent = [];
  const task = { id: "task-1234", title: "ship listener", status: "inbox", triage_state: null };
  const api = {
    async get() { throw new Error("unexpected GET"); },
    async post(path, body) {
      calls.push([path, body]);
      return { created: false, task };
    },
    async patch() { throw new Error("unexpected PATCH"); },
  };
  const handle = createSlackChannelHandler({
    api,
    send: async (channelId, threadTs, text) => sent.push([channelId, threadTs, text]),
  });
  await handle({
    kind: "mention",
    channelId: "C1",
    threadTs: "1723497600.100001",
    messageTs: "1723497600.100001",
    userId: "U1",
    text: "ship listener",
  });
  assert.equal(calls.length, 1, "the root redelivery only resolves the durable mapping");
  assert.match(sent[0][2], /already linked/i);
});
