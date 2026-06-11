import type { MissionControlDB } from "./db.js";
import type { McEventBus } from "./events.js";

type StatusMap = Record<string, Record<string, unknown>>;

export interface ReaperOptions {
  getStatusMap: () => Promise<StatusMap>;
  intervalMs?: number;
  staleHeartbeatMs?: number;
}

// Detects agents that have died (tmux session gone while the registry still
// thinks they are running) or stalled (heartbeat gone quiet) and reports them
// immediately — recording an activity, marking the task's progress blocked, and
// emitting an event — instead of waiting for the 10-minute monitor cron. It only
// detects and reports; remediation (respawn/retry) remains the bridge's job.
export function startLivenessReaper(db: MissionControlDB, events: McEventBus, opts: ReaperOptions): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const staleMs = opts.staleHeartbeatMs ?? 300_000;
  const flagged = new Set<string>();

  async function tick(): Promise<void> {
    let statusMap: StatusMap;
    try {
      statusMap = await opts.getStatusMap();
    } catch {
      return;
    }

    const now = Date.now();
    const stillHolding = new Set<string>();

    for (const [taskId, entry] of Object.entries(statusMap)) {
      const liveStatus = entry.liveStatus as string | undefined;
      const lastHeartbeatAt = typeof entry.lastHeartbeatAt === "number" ? entry.lastHeartbeatAt : null;

      let condition: "agent_exited" | "agent_stalled" | null = null;
      let reason = "";
      if (liveStatus === "completed_by_agent") {
        condition = "agent_exited";
        reason = "agent session exited without reporting completion";
      } else if (liveStatus === "running" && lastHeartbeatAt !== null && now - lastHeartbeatAt > staleMs) {
        condition = "agent_stalled";
        reason = `no heartbeat for ${Math.round((now - lastHeartbeatAt) / 1000)}s`;
      }

      if (!condition) continue;

      const key = `${taskId}:${condition}`;
      stillHolding.add(key);
      if (flagged.has(key)) continue; // only act on the transition
      flagged.add(key);

      try {
        db.createActivity({
          task_id: taskId,
          activity_type: "liveness",
          message: `Agent ${condition === "agent_exited" ? "exited" : "stalled"}: ${reason}`,
        });
        db.upsertProgress(taskId, { state: "blocked", blocked_reason: reason });
      } catch {
        // Task may not exist locally (FK) — still emit the event for listeners.
      }
      events.emit(condition, { taskId, reason });
    }

    // Re-arm conditions that have recovered so a future recurrence re-fires.
    for (const key of [...flagged]) {
      if (!stillHolding.has(key)) flagged.delete(key);
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
