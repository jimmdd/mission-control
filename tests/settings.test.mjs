import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
  stream.headers = { host: "localhost", "sec-fetch-site": "same-origin", ...headers };
  return stream;
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: "",
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(c) { this.statusCode = c; },
    end(b) { this.body = b ?? ""; },
  };
}

// Each test gets an isolated MC_HOME so .env writes never touch real config.
async function withHandler(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-settings-"));
  const prevHome = process.env.MC_HOME;
  process.env.MC_HOME = dir;
  const db = new MissionControlDB(join(dir, "mc.db"));
  db.initSchema();
  db.seedDefaults();
  try {
    return await fn(createHandler(db, SILENT), db, dir);
  } finally {
    db.close();
    if (prevHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("settings GET reports config booleans and features, never secret values", async () => {
  await withHandler(async (handler) => {
    const before = mockRes();
    await handler(mockReq({ url: "/api/settings" }), before);
    const b = JSON.parse(before.body);
    assert.equal(b.configured.ANTHROPIC_API_KEY, false);
    assert.equal(b.features.generation, false);

    await handler(
      mockReq({ url: "/api/settings", method: "POST", body: { ANTHROPIC_API_KEY: "sk-secret-123" } }),
      mockRes(),
    );

    const after = mockRes();
    await handler(mockReq({ url: "/api/settings" }), after);
    assert.equal(after.statusCode, 200);
    assert.equal(JSON.parse(after.body).configured.ANTHROPIC_API_KEY, true);
    assert.equal(JSON.parse(after.body).features.generation, true);
    // The secret must never be echoed back to the client.
    assert.ok(!after.body.includes("sk-secret-123"), "GET /settings must not return secret values");
  });
});

test("settings POST writes only allowlisted keys to .env", async () => {
  await withHandler(async (handler, _db, dir) => {
    const res = mockRes();
    await handler(
      mockReq({
        url: "/api/settings",
        method: "POST",
        body: { CONTEXT_FABRICA_DSN: "postgresql://localhost/cf", PATH: "/evil", FOO: "bar" },
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.updated, ["CONTEXT_FABRICA_DSN"]);
    assert.ok(payload.rejected.includes("PATH"));
    assert.ok(payload.rejected.includes("FOO"));

    const envText = existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf-8") : "";
    assert.match(envText, /CONTEXT_FABRICA_DSN=postgresql:\/\/localhost\/cf/);
    assert.ok(!envText.includes("PATH=/evil"), "allowlist must block arbitrary env keys");
  });
});

test("settings POST upserts (replaces) an existing key", async () => {
  await withHandler(async (handler, _db, dir) => {
    await handler(mockReq({ url: "/api/settings", method: "POST", body: { LINEAR_API_KEY: "lin_old" } }), mockRes());
    await handler(mockReq({ url: "/api/settings", method: "POST", body: { LINEAR_API_KEY: "lin_new" } }), mockRes());
    const envText = readFileSync(join(dir, ".env"), "utf-8");
    assert.match(envText, /LINEAR_API_KEY=lin_new/);
    assert.doesNotMatch(envText, /lin_old/);
    assert.equal((envText.match(/LINEAR_API_KEY=/g) || []).length, 1, "should upsert, not duplicate");
  });
});

test("settings POST with no allowlisted keys is a 400", async () => {
  await withHandler(async (handler) => {
    const res = mockRes();
    await handler(mockReq({ url: "/api/settings", method: "POST", body: { NOPE: "x" } }), res);
    assert.equal(res.statusCode, 400);
  });
});
