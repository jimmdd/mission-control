import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionControlDB } from "./db.js";

// Runs the periodic Python jobs from inside the server process.
//
// These jobs are normally driven by launchd (`ai.mission-control.linear-sync`
// et al, RunAtLoad + StartInterval). On 2026-08-18 launchd on the primary host
// stopped spawning *every* non-demand job in the gui/501 domain: the jobs stayed
// loaded and `launchctl kickstart` still worked, but the interval never fired
// again, so Linear tickets silently stopped syncing for thirteen hours. A
// throwaway LaunchAgent with a 60s interval never fired either, which is what
// ruled out anything Mission-Control-specific. launchd is PID 1, so there is no
// way to restart it short of rebooting the machine — and rebooting strands
// whatever agents are mid-run.
//
// The server is a long-lived process that survives that failure, so it can drive
// the same scripts itself. Off by default: when launchd is healthy it is already
// running them, and two schedulers on one job means double comment posts to
// Linear. Set MISSION_CONTROL_INTERNAL_SCHEDULER=1 to turn it on, and turn it
// back off once launchd is fixed.

export interface SchedulerJob {
  /** launchd label suffix, e.g. "linear-sync" — also the script's basename. */
  name: string;
  /** Path segments of the script, relative to the repo root or $MC_HOME. */
  segments: string[];
  intervalMs: number;
  /** Matches what the job's plist runs it with. check-agents is shell, not Python. */
  interpreter: "python" | "bash";
}

export interface SchedulerOptions {
  jobs?: SchedulerJob[];
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /** Delay before the first tick, so a restart does not stampede every job. */
  initialDelayMs?: number;
}

// The launchd cadences these mirror, so behaviour does not change when the
// scheduler takes over: linear-sync 300s, check-agents 600s, repo-watcher 1800s,
// cleanup-worktrees 600s.
//
// cleanup-worktrees runs behind linear-sync deliberately. linear-sync is what
// writes `done` when a Linear issue is completed, cancelled, or deleted; this is
// what acts on that status, releasing the ticket's tmux session and worktree. Two
// halves of one loop — without the second, a ticket closed in Linear left its
// agent running and its checkout on disk indefinitely.
export const DEFAULT_JOBS: SchedulerJob[] = [
  { name: "linear-sync", segments: ["integrations", "linear", "linear-sync.py"], intervalMs: 300_000, interpreter: "python" },
  { name: "check-agents", segments: ["swarm", "check-agents.sh"], intervalMs: 600_000, interpreter: "bash" },
  { name: "cleanup-worktrees", segments: ["swarm", "cleanup-worktrees.sh"], intervalMs: 600_000, interpreter: "bash" },
  { name: "repo-watcher", segments: ["swarm", "repo-watcher.py"], intervalMs: 1_800_000, interpreter: "python" },
];

function resolveRuntimePath(...segments: string[]): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const repoPath = join(repoRoot, ...segments);
  if (existsSync(repoPath)) return repoPath;
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  return join(mcHome, ...segments);
}

function resolvePythonBin(): string {
  const override = (process.env.MC_PYTHON_BIN ?? "").trim();
  if (override) return override;
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  const venvPython = join(mcHome, "venv-3.12", "bin", "python3");
  return existsSync(venvPython) ? venvPython : "python3";
}

// The file each job's plist already points StandardOutPath at, so the scheduler's
// runs land in the same place as launchd's and the history stays contiguous.
function jobLogPath(name: string): string {
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  return join(mcHome, "logs", `${name}.launchd.log`);
}

/**
 * Run one job, appending its output where launchd put it.
 *
 * Keeping the same log file matters more than it looks: this incident went
 * unnoticed for thirteen hours because a stopped job and a quiet job are
 * indistinguishable, and `linear-sync.launchd.log` is the file anyone debugging
 * it actually tails. Capturing the output into the server process instead would
 * have made a silent success and a job that never ran look identical again.
 */
function runScript(
  script: string,
  interpreter: SchedulerJob["interpreter"],
  timeoutMs: number,
  logPath: string,
): Promise<{ ok: boolean; output: string }> {
  const bin = interpreter === "bash" ? "/bin/bash" : resolvePythonBin();
  return new Promise((resolve) => {
    let log: ReturnType<typeof createWriteStream> | null = null;
    try {
      log = createWriteStream(logPath, { flags: "a" });
    } catch {
      // An unwritable log must not stop the job from running.
    }
    const child = spawn(bin, [script], { cwd: dirname(script) });
    // Keep only the tail in memory: a full Linear sync writes hundreds of lines.
    const tail: string[] = [];
    const absorb = (chunk: Buffer): void => {
      log?.write(chunk);
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 12) tail.shift();
      }
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (ok: boolean, note?: string): void => {
      clearTimeout(killer);
      if (note) log?.write(`${note}\n`);
      log?.end();
      resolve({ ok, output: tail.slice(-6).join("\n") });
    };
    child.on("error", (e) => finish(false, `[scheduler] failed to start: ${e.message}`));
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL") finish(false, `[scheduler] killed after ${Math.round(timeoutMs / 1000)}s timeout`);
      else finish(code === 0);
    });
  });
}

export function isInternalSchedulerEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.MISSION_CONTROL_INTERNAL_SCHEDULER ?? "").trim().toLowerCase(),
  );
}

/**
 * Start the in-process job scheduler. Returns a stop function.
 *
 * Each job is serialised against itself: a run that outlasts its own interval
 * (a full Linear sync over 60+ issues takes tens of seconds, and longer when
 * Linear is slow) must not have a second copy started on top of it, because both
 * would write comments back to the same issues.
 */
export function startJobScheduler(
  db: MissionControlDB,
  opts: SchedulerOptions = {},
): () => void {
  const jobs = opts.jobs ?? DEFAULT_JOBS;
  const logger = opts.logger ?? { info: console.log, error: console.error };
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();
  let stopped = false;

  const tick = async (job: SchedulerJob): Promise<void> => {
    if (stopped || running.has(job.name)) {
      if (running.has(job.name)) logger.info(`[mc] scheduler: ${job.name} still running, skipping this tick`);
      return;
    }
    const script = resolveRuntimePath(...job.segments);
    if (!existsSync(script)) {
      logger.error(`[mc] scheduler: ${job.name} script not found at ${script}`);
      return;
    }
    running.add(job.name);
    try {
      // Cap a run at its own interval so a wedged script cannot block the job
      // forever — the next tick gets a clean shot.
      const result = await runScript(script, job.interpreter, job.intervalMs, jobLogPath(job.name));
      if (!result.ok) {
        logger.error(`[mc] scheduler: ${job.name} failed: ${result.output}`);
        db.createEvent({
          type: "scheduled_job_failed",
          message: `Scheduled ${job.name} failed: ${result.output.slice(0, 500)}`,
        });
      }
    } catch (e) {
      logger.error(`[mc] scheduler: ${job.name} threw: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running.delete(job.name);
    }
  };

  for (const job of jobs) {
    // Stagger the first run per job rather than firing all three at once on boot.
    const delay = (opts.initialDelayMs ?? 10_000) + jobs.indexOf(job) * 5_000;
    const timer = setTimeout(() => {
      void tick(job);
      const interval = setInterval(() => void tick(job), job.intervalMs);
      if (typeof interval.unref === "function") interval.unref();
      timers.push(interval);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    timers.push(timer);
  }

  logger.info(
    `[mc] internal job scheduler on: ${jobs.map((j) => `${j.name}/${Math.round(j.intervalMs / 1000)}s`).join(", ")}`,
  );

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t as NodeJS.Timeout);
  };
}
