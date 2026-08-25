import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile } from "./config.js";
import type { OneShotAgent, OneShotJobConfig } from "./one-shot.js";
import { sendTelegramMessage } from "./telegram.js";

interface CommandResult {
  code: number;
  output: string;
}

export interface BranchTarget {
  kind: "branch";
  branch: string;
  baseRef: string;
}

export interface PullRequestTarget {
  kind: "pull_request";
  number: number;
  headRefName: string;
  baseRefName: string;
  initialHeadSha: string;
}

export type OneShotWorkTarget = BranchTarget | PullRequestTarget;

const MAX_REPORT_OUTPUT = 2_500;

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, path);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = options.log ? createWriteStream(options.log, { flags: "a", mode: 0o600 }) : null;
    let output = "";
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      log?.write(text);
      output = `${output}${text}`.slice(-24_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      log?.end();
      reject(error);
    });
    child.once("close", (code) => {
      log?.end();
      resolve({ code: code ?? 1, output });
    });
  });
}

async function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return runCommand("git", ["-C", repo, ...args], { env });
}

async function defaultBase(repo: string): Promise<string> {
  const symbolic = await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic.code === 0 && symbolic.output.trim()) return symbolic.output.trim();
  for (const candidate of ["origin/main", "origin/master", "HEAD"]) {
    if ((await git(repo, ["rev-parse", "--verify", candidate])).code === 0) return candidate;
  }
  throw new Error("Could not resolve the repository's default branch");
}

function readAgentConfig(config: OneShotJobConfig): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(config.mcHome, "swarm", "swarm-config.json"), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" ? nested as Record<string, unknown> : {};
}

function agentArgs(agent: OneShotAgent, prompt: string, config: Record<string, unknown>): string[] {
  const settings = nestedRecord(config, agent);
  if (agent === "claude") {
    const model = typeof settings.model === "string" ? settings.model : "claude-opus-4-6";
    const args = ["-p", "--model", model, "--dangerously-skip-permissions", "--max-turns", "200"];
    const fallback = typeof settings.fallbackModel === "string" ? settings.fallbackModel.trim() : "";
    if (fallback) args.push("--fallback-model", fallback);
    args.push(prompt);
    return args;
  }

  const model = typeof settings.model === "string" ? settings.model : "codex-mini";
  const effort = typeof settings.effort === "string" ? settings.effort : "high";
  return [
    "exec",
    "--model", model,
    "-c", `model_reasoning_effort=${effort}`,
    "--dangerously-bypass-approvals-and-sandbox",
    prompt,
  ];
}

export function agentEnvironment(envFile: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const mappings: Record<string, string> = {
    GIT_AUTHOR_NAME: envFile.MC_AGENT_GIT_NAME ?? "",
    GIT_AUTHOR_EMAIL: envFile.MC_AGENT_GIT_EMAIL ?? "",
    GIT_COMMITTER_NAME: envFile.MC_AGENT_GIT_NAME ?? "",
    GIT_COMMITTER_EMAIL: envFile.MC_AGENT_GIT_EMAIL ?? "",
    GH_TOKEN: envFile.MC_AGENT_GH_TOKEN ?? "",
  };
  for (const [key, value] of Object.entries(mappings)) {
    if (value) env[key] = value;
  }

  // Chat/control credentials are required by the reporter, never by the coding agent.
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "MISSION_CONTROL_ACCESS_TOKEN",
    "MISSION_CONTROL_ADMIN_TOKEN",
    "MISSION_CONTROL_READ_ACCESS_TOKEN",
    "MISSION_CONTROL_READ_TOKEN",
    "MISSION_CONTROL_WRITE_TOKEN",
    "LINEAR_API_KEY",
  ]) delete env[key];
  return env;
}

export function extractPullRequestNumber(instruction: string): number | null {
  const url = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)\b/i.exec(instruction);
  if (url) return Number(url[1]);
  const prose = /(?:^|\s)(?:pr|pull\s+request)\s*#\s*(\d+)\b/i.exec(instruction)
    ?? /(?:^|\s)(?:pr|pull\s+request)\s+(\d+)\b/i.exec(instruction);
  return prose ? Number(prose[1]) : null;
}

export function worktreeAddArgs(target: OneShotWorkTarget, worktree: string): string[] {
  return target.kind === "pull_request"
    ? ["worktree", "add", "--detach", worktree, target.initialHeadSha]
    : ["worktree", "add", worktree, "-b", target.branch, target.baseRef];
}

export function pullRequestPushArgs(target: PullRequestTarget): string[] {
  const ref = `refs/heads/${target.headRefName}`;
  return ["push", `--force-with-lease=${ref}:${target.initialHeadSha}`, "origin", `HEAD:${ref}`];
}

export function promptFor(config: OneShotJobConfig, target: OneShotWorkTarget): string {
  const targetInstructions = target.kind === "pull_request"
    ? [
        `This job targets existing PR #${target.number}: ${target.headRefName} -> ${target.baseRefName}.`,
        "The worktree is detached at the existing PR head; no sidecar branch exists.",
        "If code changes are needed, commit them locally but Do not push any branch and do not create another PR.",
        "The worker will publish only to the existing PR head after validation, using a lease that prevents overwriting concurrent updates.",
      ]
    : [
        `Dedicated branch: ${target.branch}`,
        "If the request calls for code changes, make the smallest correct change, run relevant tests, commit, push, and create or update a PR unless the request explicitly says otherwise.",
      ];
  return [
    "You are a one-shot sidecar agent launched directly by the operator from Telegram.",
    `Repository: ${config.repoLabel}`,
    ...targetInstructions,
    "There is no Mission Control or Linear ticket for this job. Do not create one and do not report to Mission Control.",
    "Work autonomously to completion; do not stop to ask questions. Inspect current repository guidance before acting.",
    "If the request is read-only (for example a review), do not modify files merely to produce a deliverable.",
    "End with a concise FINAL REPORT containing the outcome, validation, links/branch, and any remaining risk.",
    "",
    "OPERATOR REQUEST:",
    config.instruction,
  ].join("\n");
}

async function resolvePullRequestTarget(repo: string, instruction: string): Promise<PullRequestTarget | null> {
  const number = extractPullRequestNumber(instruction);
  if (!number) return null;

  const viewed = await runCommand("gh", [
    "pr", "view", String(number),
    "--json", "number,headRefName,headRefOid,headRepository,baseRefName",
  ], { cwd: repo });
  if (viewed.code !== 0) throw new Error(viewed.output.trim() || `Could not resolve PR #${number}`);

  const pr = JSON.parse(viewed.output) as Record<string, unknown>;
  const headRepository = pr.headRepository && typeof pr.headRepository === "object"
    ? pr.headRepository as Record<string, unknown>
    : {};
  const currentRepo = await runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: repo });
  if (currentRepo.code !== 0) throw new Error(currentRepo.output.trim() || "Could not resolve the current GitHub repository");
  const currentName = String((JSON.parse(currentRepo.output) as Record<string, unknown>).nameWithOwner ?? "").toLowerCase();
  const headName = String(headRepository.nameWithOwner ?? "").toLowerCase();
  if (!currentName || !headName || currentName !== headName) {
    throw new Error(`PR #${number} comes from a fork; one-shot PR publication currently supports same-repository heads only`);
  }

  const headRefName = String(pr.headRefName ?? "").trim();
  const baseRefName = String(pr.baseRefName ?? "").trim();
  if (!headRefName || !baseRefName) throw new Error(`PR #${number} returned incomplete branch metadata`);
  const fetched = await git(repo, ["fetch", "origin", `pull/${number}/head`]);
  if (fetched.code !== 0) throw new Error(fetched.output.trim() || `Could not fetch PR #${number}`);
  const head = await git(repo, ["rev-parse", "FETCH_HEAD"]);
  const initialHeadSha = head.output.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/i.test(initialHeadSha)) {
    throw new Error(`Could not resolve PR #${number}'s fetched head`);
  }
  return { kind: "pull_request", number, headRefName, baseRefName, initialHeadSha };
}

async function publishPullRequestHead(
  repo: string,
  target: PullRequestTarget,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const local = await git(repo, ["rev-parse", "HEAD"]);
  const localHead = local.output.trim();
  if (local.code !== 0 || !localHead) throw new Error("Could not resolve the completed PR worktree head");
  if (localHead === target.initialHeadSha) return;

  const pushed = await git(repo, pullRequestPushArgs(target), env);
  if (pushed.code === 0) return;

  // If the agent ignored the no-push instruction but updated the exact intended ref,
  // accept that state. Any other lease failure means someone changed the PR while the
  // job ran, and must fail closed rather than overwrite their work.
  const remote = await git(repo, ["ls-remote", "origin", `refs/heads/${target.headRefName}`]);
  const remoteHead = remote.output.trim().split(/\s+/)[0] ?? "";
  if (remote.code === 0 && remoteHead === localHead) return;
  throw new Error(
    `Could not publish PR #${target.number} without overwriting a concurrent update: ${pushed.output.trim()}`,
  );
}

function cleanOutput(output: string): string {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const marker = plain.lastIndexOf("FINAL REPORT");
  const report = marker >= 0 ? plain.slice(marker) : plain;
  return report.length > MAX_REPORT_OUTPUT ? `…${report.slice(-MAX_REPORT_OUTPUT)}` : report;
}

async function notify(token: string, chatId: string, text: string): Promise<void> {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  let lastError: unknown;
  for (const delayMs of [0, 1_000, 5_000, 15_000, 60_000]) {
    if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
    try {
      await sendTelegramMessage(token, chatId, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Telegram completion report failed");
}

export async function runOneShotWorker(configPath: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as OneShotJobConfig;
  if (config.version !== 1 || !["claude", "codex"].includes(config.agent)) throw new Error("Invalid one-shot job config");

  const jobDir = dirname(configPath);
  const statusPath = join(jobDir, "status.json");
  const logPath = join(jobDir, "agent.log");
  const envFile = parseEnvFile(join(config.mcHome, ".env"));
  const telegramToken = (process.env.TELEGRAM_BOT_TOKEN ?? envFile.TELEGRAM_BOT_TOKEN ?? "").trim();
  const sidecarBranch = `mc/one-shot/${config.jobId.replace(/^once-/, "")}`;
  const worktree = join(dirname(config.repoPath), "worktrees", config.jobId);

  writeJsonAtomic(statusPath, { status: "starting", jobId: config.jobId, worktree, updatedAt: new Date().toISOString() });

  try {
    if (!existsSync(join(config.repoPath, ".git"))) throw new Error(`Repository does not exist: ${config.repoPath}`);
    const fetched = await git(config.repoPath, ["fetch", "origin"]);
    if (fetched.code !== 0) throw new Error(fetched.output.trim() || "Could not fetch the repository");
    const pullRequest = await resolvePullRequestTarget(config.repoPath, config.instruction);
    const target: OneShotWorkTarget = pullRequest ?? {
      kind: "branch",
      branch: sidecarBranch,
      baseRef: await defaultBase(config.repoPath),
    };
    const branch = target.kind === "pull_request" ? target.headRefName : target.branch;
    const created = await git(config.repoPath, worktreeAddArgs(target, worktree));
    if (created.code !== 0) throw new Error(created.output.trim() || "Could not create the isolated worktree");

    const workerConfig = readAgentConfig(config);
    const command = config.agent === "claude" ? "claude" : "codex";
    writeJsonAtomic(statusPath, {
      status: "running",
      jobId: config.jobId,
      agent: config.agent,
      repo: config.repoLabel,
      branch,
      worktree,
      pullRequest: target.kind === "pull_request" ? target.number : null,
      updatedAt: new Date().toISOString(),
    });
    const childEnv = agentEnvironment(envFile);
    const result = await runCommand(command, agentArgs(config.agent, promptFor(config, target), workerConfig), {
      cwd: worktree,
      env: childEnv,
      log: logPath,
    });
    if (result.code === 0 && target.kind === "pull_request") {
      await publishPullRequestHead(worktree, target, childEnv);
    }
    const success = result.code === 0;
    const summary = cleanOutput(result.output) || "The agent exited without a textual report.";
    writeJsonAtomic(statusPath, {
      status: success ? "completed" : "failed",
      exitCode: result.code,
      jobId: config.jobId,
      agent: config.agent,
      repo: config.repoLabel,
      branch,
      worktree,
      pullRequest: target.kind === "pull_request" ? target.number : null,
      summary,
      updatedAt: new Date().toISOString(),
    });
    try {
      await notify(
        telegramToken,
        config.telegramChatId,
        `${success ? "✅" : "❌"} One-shot ${success ? "complete" : "failed"}: ${config.jobId}\n` +
        `${config.agent} · ${config.repoLabel}\nBranch: ${branch}\n\n${summary}`,
      );
    } catch (reportError) {
      const detail = reportError instanceof Error ? reportError.message : String(reportError);
      writeJsonAtomic(statusPath, {
        status: success ? "completed_report_failed" : "failed_report_failed",
        exitCode: result.code,
        jobId: config.jobId,
        agent: config.agent,
        repo: config.repoLabel,
        branch,
        worktree,
        pullRequest: target.kind === "pull_request" ? target.number : null,
        summary,
        reportError: detail,
        updatedAt: new Date().toISOString(),
      });
      process.exitCode = 1;
      return;
    }
    if (!success) process.exitCode = 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeJsonAtomic(statusPath, {
      status: "failed",
      jobId: config.jobId,
      agent: config.agent,
      repo: config.repoLabel,
      worktree,
      error: detail,
      updatedAt: new Date().toISOString(),
    });
    await notify(
      telegramToken,
      config.telegramChatId,
      `❌ One-shot failed: ${config.jobId}\n${config.agent} · ${config.repoLabel}\n\n${detail}`,
    ).catch(() => {});
    throw error;
  }
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
const configPath = process.argv[2];
if (isMain && configPath) {
  void runOneShotWorker(configPath).catch((error) => {
    process.stderr.write(`[one-shot] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
