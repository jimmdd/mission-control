import { createServer } from "node:http";
import { MissionControlDB } from "./src/db.js";
import { createHandler, getSwarmAgentStatusMap, getConnectionsReport } from "./src/routes.js";
import { McEventBus } from "./src/events.js";
import { startLivenessReaper } from "./src/reaper.js";
import { startNotifier } from "./src/notifier.js";

// Config
const PORT = parseInt(process.env.MC_PORT ?? "18790", 10);
const HOST = process.env.MC_HOST ?? "127.0.0.1";
const MC_HOME = process.env.MC_HOME ?? `${process.env.HOME}/.mission-control`;
const DB_PATH = process.env.MC_DB_PATH ?? `${MC_HOME}/data/mc.db`;
const ANY_ACCESS_TOKEN = [
  process.env.MISSION_CONTROL_ACCESS_TOKEN,
  process.env.MISSION_CONTROL_READ_ACCESS_TOKEN,
  process.env.MISSION_CONTROL_READ_TOKEN,
  process.env.MISSION_CONTROL_WRITE_TOKEN,
  process.env.MISSION_CONTROL_ADMIN_TOKEN,
  process.env.MISSION_CONTROL_WEBHOOK_SECRET,
].some(token => (token ?? "").trim());
const ALLOW_INSECURE_BIND = (process.env.MISSION_CONTROL_ALLOW_INSECURE_BIND ?? "").trim().toLowerCase();

if (
  !ANY_ACCESS_TOKEN &&
  HOST !== "127.0.0.1" &&
  HOST !== "localhost" &&
  HOST !== "::1" &&
  !["1", "true", "yes", "on"].includes(ALLOW_INSECURE_BIND)
) {
  throw new Error(
    "Refusing to bind Mission Control to a non-local host without an access token. " +
      "Set a token or MISSION_CONTROL_ALLOW_INSECURE_BIND=1 for a deliberate local-lab override.",
  );
}

// Init DB
const db = new MissionControlDB(DB_PATH);
db.initSchema();
db.seedDefaults();
console.log(`[mc] database initialized: ${DB_PATH}`);

// Event bus for reactive (SSE) updates, shared by the HTTP handler and the
// liveness reaper.
const events = new McEventBus();
const logger = { info: console.log, error: console.error };

// Create handler from routes
const handler = createHandler(db, logger, events);

// Detect dead/stalled agents promptly and surface them as events + activities,
// rather than waiting for the periodic monitor cron.
const REAPER_DISABLED = ["1", "true", "yes", "on"].includes(
  (process.env.MISSION_CONTROL_DISABLE_REAPER ?? "").trim().toLowerCase(),
);
const stopReaper = REAPER_DISABLED
  ? () => {}
  : startLivenessReaper(db, events, {
      getStatusMap: () => getSwarmAgentStatusMap(logger),
      intervalMs: Number.parseInt(process.env.MISSION_CONTROL_REAPER_INTERVAL_MS ?? "30000", 10),
      staleHeartbeatMs: Number.parseInt(process.env.MISSION_CONTROL_STALE_HEARTBEAT_MS ?? "300000", 10),
    });

// Push notifications for events that need a human (escalations, approval gates,
// dead/stalled agents) via an optional notify.sh hook and/or a webhook.
const stopNotifier = startNotifier(events, {
  notifyScript: `${MC_HOME}/swarm/notify.sh`,
  webhookUrl: (process.env.MISSION_CONTROL_NOTIFY_WEBHOOK ?? "").trim() || undefined,
  logger,
});

const server = createServer(async (req, res) => {
  // Health endpoint
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      dbPath: DB_PATH,
      pid: process.pid,
    }));
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error("[mc] unhandled error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mc] Mission Control listening on http://${HOST}:${PORT} (PID ${process.pid})`);
  console.log(`[mc] home directory: ${MC_HOME}`);
  console.log(`[mc] log file: ${MC_HOME}/logs/mc.log`);

  // Probe agent runtimes + sources on start and log a one-line readiness
  // summary, so you can see what's set up without doing anything.
  if (!["1", "true", "yes", "on"].includes((process.env.MISSION_CONTROL_SKIP_READINESS ?? "").trim().toLowerCase())) {
    getConnectionsReport()
      .then((report) => {
        const runtimes = Array.isArray(report.runtimes) ? (report.runtimes as Array<Record<string, unknown>>) : [];
        const sources = Array.isArray(report.sources) ? (report.sources as Array<Record<string, unknown>>) : [];
        const rt = runtimes.map((r) => `${r.name} ${r.authenticated ? "✓" : "✗"}`).join(", ");
        const ready = runtimes.filter((r) => r.installed && r.authenticated).length;
        const connected = sources.filter((s) => s.status === "connected").length;
        console.log(`[mc] readiness: runtimes ${ready}/${runtimes.length} (${rt}) · sources ${connected}/${sources.length} connected`);
        const needs = sources.filter((s) => s.status !== "connected").map((s) => s.name);
        if (needs.length) console.log(`[mc] not connected: ${needs.join(", ")} — run \`mc connections\` for details`);
      })
      .catch(() => {
        console.log("[mc] readiness check skipped (connections probe unavailable)");
      });
  }
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[mc] ${signal} received, shutting down`);
  stopReaper();
  stopNotifier();
  server.close(() => {
    db.close();
    console.log("[mc] stopped");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
