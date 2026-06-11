import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";
import { createHandler } from "../src/routes.ts";

const SILENT = { info() {}, error() {} };

function mockReq({ url, method = "GET", headers = {}, body }) {
  const payload =
    body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.url = url;
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body ?? "";
      this.ended = true;
    },
  };
}

async function withHandler(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-security-"));
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  const handler = createHandler(db, SILENT);
  try {
    return await fn(handler, db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Anti DNS-rebinding: a foreign Host header must be rejected even on a GET.
test("requests with a non-allowlisted Host header are rejected", async () => {
  await withHandler(async (handler) => {
    const evil = mockRes();
    await handler(mockReq({ url: "/api/meta", headers: { host: "evil.example.com" } }), evil);
    assert.equal(evil.statusCode, 403);

    for (const host of ["127.0.0.1:18790", "localhost", "localhost:18790"]) {
      const ok = mockRes();
      await handler(mockReq({ url: "/api/meta", headers: { host } }), ok);
      assert.equal(ok.statusCode, 200, `host ${host} should be allowed`);
    }

    // Non-browser clients may omit Host entirely.
    const noHost = mockRes();
    await handler(mockReq({ url: "/api/meta", headers: {} }), noHost);
    assert.equal(noHost.statusCode, 200);
  });
});

// Anti-CSRF: cross-site browser writes blocked; same-origin and non-browser allowed.
test("cross-site state-changing requests are blocked, same-origin allowed", async () => {
  await withHandler(async (handler) => {
    const crossSite = mockRes();
    await handler(
      mockReq({
        url: "/api/tasks",
        method: "POST",
        headers: { host: "localhost", "sec-fetch-site": "cross-site" },
        body: { title: "csrf" },
      }),
      crossSite,
    );
    assert.equal(crossSite.statusCode, 403);

    const sameOrigin = mockRes();
    await handler(
      mockReq({
        url: "/api/tasks",
        method: "POST",
        headers: { host: "localhost", "sec-fetch-site": "same-origin" },
        body: { title: "ok" },
      }),
      sameOrigin,
    );
    assert.equal(sameOrigin.statusCode, 201);

    // Cross-origin via Origin header (older browsers without Sec-Fetch).
    const crossOrigin = mockRes();
    await handler(
      mockReq({
        url: "/api/tasks",
        method: "POST",
        headers: { host: "localhost", origin: "https://evil.example.com" },
        body: { title: "csrf2" },
      }),
      crossOrigin,
    );
    assert.equal(crossOrigin.statusCode, 403);

    // Non-browser client (CLI/bridge): no Sec-Fetch, no Origin -> allowed.
    const cli = mockRes();
    await handler(
      mockReq({ url: "/api/tasks", method: "POST", headers: { host: "localhost" }, body: { title: "cli" } }),
      cli,
    );
    assert.equal(cli.statusCode, 201);
  });
});

// SSRF: the fetch-url endpoint must reject loopback/private/localhost targets,
// including integer-encoded IP literals that decode to 127.0.0.1.
test("fetch-url rejects loopback and private targets", async () => {
  await withHandler(async (handler) => {
    const targets = ["http://127.0.0.1/", "http://localhost/", "http://2130706433/", "http://[::1]/"];
    for (const url of targets) {
      const res = mockRes();
      await handler(
        mockReq({ url: "/api/knowledge/fetch-url", method: "POST", headers: { host: "localhost" }, body: { url } }),
        res,
      );
      assert.equal(res.statusCode, 400, `${url} should be rejected as unsafe`);
    }
  });
});

// Fresh-install regression: /board must not 500 when the swarm registry file
// does not exist yet.
test("board endpoint works before any swarm registry exists", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "mc-home-"));
  const prevHome = process.env.MC_HOME;
  process.env.MC_HOME = homeDir; // no swarm/active-tasks.json here
  try {
    await withHandler(async (handler, db) => {
      db.createTask({ title: "visible-on-board" });
      const res = mockRes();
      await handler(mockReq({ url: "/api/board", headers: { host: "localhost" } }), res);
      assert.equal(res.statusCode, 200);
      const payload = JSON.parse(res.body);
      assert.equal(payload.summary.totalTasks, 1);
      assert.deepEqual(payload.swarm, {});
    });
  } finally {
    if (prevHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
