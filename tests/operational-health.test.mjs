import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { operationalHealth } from "../src/health.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const now = 1_700_000_000_000;

function health(entries, checkpoints = {}, receipts = {}) {
  const home = mkdtempSync(join(tmpdir(), "mc-operational-health-"));
  const db = {
    runtimeHealth: () => ({ schemaReady: true, oldestQueuedAt: null }),
    getPendingCheckpointCounts: () => checkpoints,
  };
  try {
    const files = { "swarm/active-tasks.json": entries, ...receipts };
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), JSON.stringify(data));
    }
    return operationalHealth(db, home, { now, uptime: 3600, linearEnabled: false, bridgeEnabled: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("finished executions awaiting delivery are visible without heartbeat or launch outages", () => {
  const result = health([
    { status: "running", deliveryPending: true, launchState: "starting", startedAt: now - 600_000 },
    // A finished execution may no longer have any timestamps at all.
    { status: "running", deliveryPending: true, launchState: "starting" },
  ]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.agents, { running: 0, awaitingDelivery: 2, unacknowledged: 0, stalled: 0 });
  assert.deepEqual(result.checkpoints, { pending: 0, tasksAwaitingHuman: 0 });
});

test("intentional human waits retain task and checkpoint counts without claiming an outage", () => {
  const result = health([
    { mcTaskId: "waiting-a", status: "paused", startedAt: now - 600_000 },
    { mcTaskId: "waiting-b", status: "running", deliveryPending: true, startedAt: now - 600_000 },
  ], { "waiting-a": 2, "waiting-b": 1 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.agents.awaitingDelivery, 1);
  assert.deepEqual(result.checkpoints, { pending: 3, tasksAwaitingHuman: 2 });
});

test("delivery and human waits do not hide genuinely stale active agents", () => {
  const result = health([
    { status: "running", deliveryPending: true, startedAt: now - 600_000 },
    { mcTaskId: "still-working", status: "running", deliveryPending: false, launchState: "starting", startedAt: now - 600_000 },
    { status: "running", launchState: "acknowledged", launchAcknowledgedAt: now - 600_000, lastHeartbeatAt: now - 600_000 },
    { status: "running", launchState: "starting", startedAt: now - 90_000, lastHeartbeatAt: now - 300_000 },
  ], { "still-working": 1 });
  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["launch_acknowledgement_overdue", "agent_heartbeat_stale"]);
  assert.deepEqual(result.agents, { running: 3, awaitingDelivery: 1, unacknowledged: 1, stalled: 2 });
  assert.deepEqual(result.checkpoints, { pending: 1, tasksAwaitingHuman: 1 });
});

function monitorPython(source) {
  return JSON.parse(execFileSync("python3", ["-c", `
import importlib.util, io, json, urllib.error
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("service_health_under_test", ${JSON.stringify(join(root, "health/service-health.py"))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def probe(code, body):
    error = urllib.error.HTTPError("http://health.invalid/health", code, "Service Unavailable", {}, io.BytesIO(body))
    with patch.object(m.urllib.request, "urlopen", side_effect=error):
        return m.check_http_service("Mission Control", "http://health.invalid/health")
${source}
`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", MC_HOME: "/nonexistent-mc-test-home" },
    timeout: 5000,
  }));
}

test("a structured degraded 503 preserves reasons, PID and uptime", () => {
  const result = monitorPython(`
payload = {"status": "degraded", "reasons": ["agent_heartbeat_stale", "bridge_stale"], "pid": 2058, "uptime": 3661.5}
print(json.dumps(probe(503, json.dumps(payload).encode())))
`);
  assert.equal(result.status, "degraded");
  assert.equal(result.pid, 2058);
  assert.equal(result.uptime, "01:01:01");
  assert.deepEqual(result.reasons, ["agent_heartbeat_stale", "bridge_stale"]);
  assert.equal(result.details, "degraded: agent_heartbeat_stale, bridge_stale");
});

test("proxy, malformed and unrelated error responses remain down", () => {
  const results = monitorPython(`
valid = {"status": "degraded", "reasons": ["bridge_stale"], "pid": 2058, "uptime": 3661}
cases = {
    "html": b"<h1>Service unavailable</h1>",
    "invalid_json": b"{",
    "invalid_utf8": b"\\xff",
    "array": b"[]",
    "no_reasons": json.dumps({**valid, "reasons": []}).encode(),
    "bad_reasons": json.dumps({**valid, "reasons": [42]}).encode(),
    "missing_pid": json.dumps({k:v for k,v in valid.items() if k != "pid"}).encode(),
    "bad_uptime": json.dumps({**valid, "uptime": -1}).encode(),
    "nonfinite_uptime": json.dumps({**valid, "uptime": float("nan")}).encode(),
    "wrong_status": json.dumps({**valid, "status": "ok"}).encode(),
}
results = {name:probe(503, body) for name,body in cases.items()}
results["other_http_error"] = probe(500, json.dumps(valid).encode())
with patch.object(m.urllib.request, "urlopen", side_effect=urllib.error.URLError("connection refused")):
    results["connection_refused"] = m.check_http_service("Mission Control", "http://health.invalid/health")
class Unreadable(io.BytesIO):
    def read(self, *args): raise OSError("response read failed")
error = urllib.error.HTTPError("u", 503, "Service Unavailable", {}, Unreadable())
with patch.object(m.urllib.request, "urlopen", side_effect=error):
    results["unreadable_body"] = m.check_http_service("Mission Control", "http://health.invalid/health")
print(json.dumps(results))
`);
  for (const [name, result] of Object.entries(results)) {
    assert.equal(result.status, "down", name);
    assert.equal(result.pid, null, name);
    assert.equal(result.uptime, null, name);
    assert.equal(result.reasons, undefined, name);
  }
  assert.match(results.connection_refused.details, /connection refused/);
});

test("healthy HTTP 200 responses keep their existing up semantics", () => {
  const results = monitorPython(`
results = []
for body in (b'{"status":"ok","pid":42,"uptime":0}', b"alive"):
    with patch.object(m.urllib.request, "urlopen", return_value=io.BytesIO(body)) as request:
        results.append(m.check_http_service("Mission Control", "http://health.invalid/health", timeout=3))
        req = request.call_args.args[0]
        assert req.get_method() == "GET"
        assert req.full_url == "http://health.invalid/health"
        assert request.call_args.kwargs == {"timeout":3}
print(json.dumps(results))
`);
  assert.equal(results[0].status, "up");
  assert.equal(results[0].pid, 42);
  assert.equal(results[0].uptime, "00:00:00");
  assert.equal(results[0].details, "ok");
  assert.equal(results[1].status, "up");
  assert.equal(results[1].details, "responding");
});

test("a degraded Mission Control is not critical, while a core outage still is", () => {
  const results = monitorPython(`
def services(mc="up", pg="up", bridge="up"):
    return [{"name":"Mission Control","status":mc}, {"name":"PostgreSQL","status":pg}, {"name":"Bridge","status":bridge}]
print(json.dumps({
    "healthy":m.overall_status(services()),
    "mc_degraded":m.overall_status(services(mc="degraded")),
    "mc_down":m.overall_status(services(mc="down")),
    "pg_down":m.overall_status(services(pg="down")),
    "bridge_down":m.overall_status(services(bridge="down")),
}))
`);
  assert.deepEqual(results, { healthy: "healthy", mc_degraded: "degraded", mc_down: "critical", pg_down: "critical", bridge_down: "degraded" });
});

function renderedService(data) {
  const source = readFileSync(join(root, "public/app.js"), "utf8");
  const escapeStart = source.indexOf("const escapeHtml = (unsafe) => {");
  const escapeEnd = source.indexOf("const parseMarkdown", escapeStart);
  const renderStart = source.indexOf("function renderServiceHealth(data) {");
  const renderEnd = source.indexOf("function applyServicesPanelPref()", renderStart);
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart && renderStart >= 0 && renderEnd > renderStart);
  const elements = { "services-overall-indicator": { innerHTML: "" }, "services-grid": { innerHTML: "" } };
  runInNewContext(`${source.slice(escapeStart, escapeEnd)}\n${source.slice(renderStart, renderEnd)}\nrenderServiceHealth(data);`, {
    data,
    document: { getElementById: (id) => elements[id] },
    applyServicesPanelPref: () => {},
  });
  return { indicator: elements["services-overall-indicator"].innerHTML, grid: elements["services-grid"].innerHTML };
}

test("the service card shows escaped degraded reasons alongside PID and uptime", () => {
  const rendered = renderedService({ overall: "degraded", services: [{ name: "Mission Control", status: "degraded", pid: 2058, uptime: "01:01:01", details: "degraded: agent_heartbeat_stale <bad>" }] });
  assert.match(rendered.indicator, /DEGRADED/);
  assert.match(rendered.grid, /PID 2058 \/ 01:01:01/);
  assert.match(rendered.grid, /degraded: agent_heartbeat_stale &lt;bad&gt;/);
  assert.doesNotMatch(rendered.grid, /<bad>/);
});

test("healthy service cards retain their PID, uptime and operational label", () => {
  const rendered = renderedService({ overall: "healthy", services: [{ name: "Mission Control", status: "up", pid: 2058, uptime: "01:01:01", details: "ok" }] });
  assert.match(rendered.indicator, /ALL SYSTEMS OPERATIONAL/);
  assert.match(rendered.grid, /PID 2058 \/ 01:01:01/);
  assert.match(rendered.grid, /svc-badge up/);
});
