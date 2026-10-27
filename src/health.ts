import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MissionControlDB } from "./db.js";

function receipt(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function operationalHealth(db: MissionControlDB, home: string, options: {
  now?: number; uptime?: number; linearEnabled?: boolean; bridgeEnabled?: boolean;
} = {}) {
  const now = options.now ?? Date.now();
  const uptime = options.uptime ?? process.uptime();
  const config = receipt(join(home, "swarm", "swarm-config.json"));
  const linearEnabled = options.linearEnabled ?? (Boolean(process.env.LINEAR_API_KEY) && config?.linear?.enabled !== false);
  const bridgeEnabled = options.bridgeEnabled ?? existsSync(join(home, "swarm", "swarm-config.json"));
  const age = (value: unknown): number | null => {
    const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? Math.max(0, (now - time) / 1000) : null;
  };
  const reasons: string[] = [];
  const database = db.runtimeHealth();
  const pendingCheckpointCounts = db.getPendingCheckpointCounts();
  if (!database.schemaReady) reasons.push("database_schema_outdated");
  const sync = receipt(join(home, "sync", "linear-state.json"));
  const syncAge = age(sync?.last_sync);
  if (linearEnabled) {
    if (sync?.last_error || Object.keys(sync?.failed_issues ?? {}).length) reasons.push("linear_sync_failed");
    if ((syncAge === null && uptime > 900) || (syncAge !== null && syncAge > 900)) reasons.push("linear_sync_stale");
  }
  const bridge = receipt(join(home, "bridge", "health.json"));
  const bridgeAge = age(bridge?.finished_at ?? bridge?.started_at);
  if (bridgeEnabled) {
    if (bridge?.last_error) reasons.push("bridge_cycle_failed");
    if ((bridgeAge === null && uptime > 900) || (bridgeAge !== null && bridgeAge > 900)) reasons.push("bridge_stale");
  }
  const queueAge = age(database.oldestQueuedAt);
  if (bridgeEnabled && queueAge !== null && queueAge > 1800) reasons.push("dispatch_queue_stale");
  const registry = receipt(join(home, "swarm", "active-tasks.json"));
  const entries: Array<Record<string, any>> = Array.isArray(registry) ? registry : [];
  // Keep task failure health separate from process liveness. Old attempts cannot
  // override a newer healthy retry, and completed task history is not an outage.
  const stamp = (entry: Record<string, any>) => {
    const values = (keys: string[]) => keys.map(key => typeof entry[key] === "number" ? entry[key] : Date.parse(entry[key] ?? "")).filter(Number.isFinite);
    const attempts = values(["lastAttemptAt", "lastRespawnAt", "runStartedAt", "startedAt"]);
    return Math.max(0, ...(attempts.length ? attempts : values(["failedAt", "lastHeartbeatAt"])));
  };
  const current = new Map<string, Record<string, any>>();
  entries.forEach((entry, index) => {
    const key = String(entry.mcTaskId || entry.id || `unidentified-${index}`);
    const prior = current.get(key);
    if (!prior || stamp(entry) >= stamp(prior)) current.set(key, entry);
  });
  const failureCheckpointCounts = db.getPendingCheckpointCounts?.() ?? {};
  const relevant = [...current.values()].filter(entry => {
    if (!entry.mcTaskId || typeof db.getTask !== "function") return true;
    const task = db.getTask(entry.mcTaskId);
    return task && !["done", "closed"].includes(task.status);
  });
  let failedWorkers = 0, retryScheduled = 0, waitingForHuman = 0;
  for (const entry of relevant) {
    if (failureCheckpointCounts[entry.mcTaskId] > 0) waitingForHuman++;
    if (entry.status === "rate_limited") retryScheduled++;
    if (["failed", "blocked", "auth_blocked"].includes(entry.status)) failedWorkers++;
  }
  if (failedWorkers) reasons.push("agent_execution_blocked");
  let running = 0, awaitingDelivery = 0, unacknowledged = 0, stalled = 0;
  for (const entry of relevant) {
    // The execution has finished; delivery/review may still need work or a
    // human decision, but there is no agent left to send heartbeats.
    if (entry.deliveryPending === true) {
      awaitingDelivery++;
      continue;
    }
    if (entry.status !== "running") continue;
    running++;
    if (entry.launchState === "starting" && !entry.launchAcknowledgedAt && (age(entry.startedAt) ?? Infinity) > 90) unacknowledged++;
    if ((age(entry.lastHeartbeatAt ?? entry.startedAt) ?? Infinity) > 300) stalled++;
  }
  if (unacknowledged) reasons.push("launch_acknowledgement_overdue");
  if (stalled) reasons.push("agent_heartbeat_stale");
  return {
    status: reasons.length ? "degraded" : "ok", reasons,
    schemaReady: database.schemaReady,
    workerHealth: { status: failedWorkers ? "blocked" : unacknowledged || stalled ? "degraded" : waitingForHuman ? "waiting" : "ok", failed: failedWorkers, waitingForHuman, retryScheduled },
    linear: { enabled: linearEnabled, lastSuccessAt: sync?.last_sync ?? null, ageSeconds: syncAge, failedIssues: Object.keys(sync?.failed_issues ?? {}).length },
    bridge: { enabled: bridgeEnabled, ageSeconds: bridgeAge, consecutiveFailures: bridge?.consecutive_failures ?? 0 },
    queue: { oldestAgeSeconds: queueAge },
    agents: { running, awaitingDelivery, unacknowledged, stalled },
    checkpoints: {
      pending: Object.values(pendingCheckpointCounts).reduce((total, count) => total + count, 0),
      tasksAwaitingHuman: Object.keys(pendingCheckpointCounts).length,
    },
  };
}
