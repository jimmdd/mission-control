import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApiClient } from "./commands.js";

export type OneShotAgent = "claude" | "codex";

export interface ParsedOneShotCommand {
  agent: OneShotAgent;
  repo: string;
  instruction: string;
}

export interface OneShotRequest extends ParsedOneShotCommand {
  /** Originating Telegram chat. The detached worker reports only to this target. */
  target: string;
  actor: string;
  requestId?: string;
}

export interface OneShotStarted {
  jobId: string;
  agent: OneShotAgent;
  repo: string;
  alreadyStarted?: boolean;
}

export interface OneShotRunner {
  start(request: OneShotRequest): Promise<OneShotStarted>;
}

interface RepoRecord {
  repo: string;
  domain: string;
}

export interface ResolvedOneShotRepo {
  label: string;
  path: string;
}

export interface OneShotJobConfig {
  version: 1;
  jobId: string;
  agent: OneShotAgent;
  repoLabel: string;
  repoPath: string;
  instruction: string;
  telegramChatId: string;
  actor: string;
  mcHome: string;
  createdAt: string;
}

const USAGE = "Usage: /run <claude|codex> <repo> <instruction>";
const MAX_INSTRUCTION_LENGTH = 8_000;

/**
 * `/run` deliberately requires a slash. Natural language and Slack must never
 * accidentally cross the sidecar's execution boundary.
 */
export function parseOneShotCommand(text: string): ParsedOneShotCommand | null {
  const trimmed = text.trim();
  if (!/^\/run(?:@[\w_]+)?(?:\s|$)/i.test(trimmed)) return null;

  const match = /^\/run(?:@[\w_]+)?\s+(\S+)\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (!match) throw new Error(USAGE);

  const agent = match[1].toLowerCase();
  if (agent !== "claude" && agent !== "codex") {
    throw new Error(`Choose claude or codex. ${USAGE}`);
  }

  const repo = match[2].trim();
  const instruction = match[3].trim();
  if (!instruction) throw new Error(USAGE);
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error(`Instruction is too long (${instruction.length}/${MAX_INSTRUCTION_LENGTH} characters).`);
  }

  return { agent, repo, instruction };
}

function records(value: unknown): RepoRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.repo !== "string" || typeof row.domain !== "string") return [];
    return [{ repo: row.repo, domain: row.domain }];
  });
}

function repoPath(root: string, domain: string): string {
  if (!root || !domain || domain.startsWith("/") || domain.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Mission Control returned an invalid repository path");
  }
  const rootName = basename(root);
  const relative = domain.startsWith(`${rootName}/`) ? domain.slice(rootName.length + 1) : domain;
  const candidate = resolve(root, ...relative.split("/"));
  const boundary = `${resolve(root)}${sep}`;
  if (!candidate.startsWith(boundary)) throw new Error("Repository path escapes the configured root");
  return candidate;
}

/** Resolve only against `/repos`, which already applies REPO_WATCH_REPOS. */
export async function resolveOneShotRepo(api: ApiClient, ref: string): Promise<ResolvedOneShotRepo> {
  const payload = await api.get("/repos");
  const object = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const root = typeof object.root === "string" ? object.root : "";
  const repos = records(object.repos);
  const needle = ref.trim().toLowerCase();

  const domainMatches = repos.filter((repo) => repo.domain.toLowerCase() === needle);
  const matches = domainMatches.length ? domainMatches : repos.filter((repo) => repo.repo.toLowerCase() === needle);
  if (matches.length === 0) {
    const choices = repos.slice(0, 8).map((repo) => repo.domain).join(", ");
    throw new Error(
      `${ref} is not in Mission Control's repository allowlist.${choices ? ` Available: ${choices}` : ""}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Repository name is ambiguous; use one of: ${matches.map((repo) => repo.domain).join(", ")}`);
  }

  return { label: matches[0].domain, path: repoPath(root, matches[0].domain) };
}

function jobIdFor(request: OneShotRequest): string {
  if (request.requestId) {
    return `once-${createHash("sha256").update(request.requestId).digest("hex").slice(0, 12)}`;
  }
  return `once-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export interface CreateOneShotRunnerOptions {
  mcHome: string;
  api: ApiClient;
  /** Test seam. Production launches a detached Node worker. */
  launchWorker?: (configPath: string) => void;
}

function defaultLaunchWorker(configPath: string): void {
  const workerPath = fileURLToPath(new URL("./one-shot-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", workerPath, configPath], {
    cwd: dirname(workerPath),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function createOneShotRunner(opts: CreateOneShotRunnerOptions): OneShotRunner {
  return {
    async start(request): Promise<OneShotStarted> {
      const jobId = jobIdFor(request);
      const jobDir = join(opts.mcHome, "one-shot", "jobs", jobId);
      const configPath = join(jobDir, "job.json");

      try {
        const existing = JSON.parse(readFileSync(configPath, "utf-8")) as OneShotJobConfig;
        return { jobId, agent: existing.agent, repo: existing.repoLabel, alreadyStarted: true };
      } catch {
        // A new Telegram delivery has no job file yet. Create it below.
      }

      const resolvedRepo = await resolveOneShotRepo(opts.api, request.repo);
      mkdirSync(jobDir, { recursive: true, mode: 0o700 });
      const config: OneShotJobConfig = {
        version: 1,
        jobId,
        agent: request.agent,
        repoLabel: resolvedRepo.label,
        repoPath: resolvedRepo.path,
        instruction: request.instruction,
        telegramChatId: request.target,
        actor: request.actor,
        mcHome: opts.mcHome,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });

      (opts.launchWorker ?? defaultLaunchWorker)(configPath);
      return { jobId, agent: request.agent, repo: resolvedRepo.label };
    },
  };
}
