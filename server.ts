import { createServer } from "node:http";
import { MissionControlDB } from "./src/db.js";
import { createHandler } from "./src/routes.js";

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

server.listen(PORT, HOST, () => {
  console.log(`[mc] Mission Control listening on http://${HOST}:${PORT} (PID ${process.pid})`);
  console.log(`[mc] home directory: ${MC_HOME}`);
  console.log(`[mc] log file: ${MC_HOME}/logs/mc.log`);
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
