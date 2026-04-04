import { createServer } from "node:http";
import { MissionControlDB } from "./src/db.js";
import { createHandler } from "./src/routes.js";

// Config
const PORT = parseInt(process.env.MC_PORT ?? "18790", 10);
const DB_PATH = process.env.MC_DB_PATH ?? `${process.env.HOME}/.openclaw/mission-control/mc.db`;

// Init DB
const db = new MissionControlDB(DB_PATH);
db.initSchema();
db.seedDefaults();
console.log(`[mc] database initialized: ${DB_PATH}`);

// Create handler from routes
const handler = createHandler(db);

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

const HOST = process.env.MC_HOST ?? "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`[mc] Mission Control listening on http://${HOST}:${PORT} (PID ${process.pid})`);
  console.log(`[mc] log file: ${process.env.HOME}/.openclaw/mission-control/logs/mc.log`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[mc] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    console.log("[mc] stopped");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
