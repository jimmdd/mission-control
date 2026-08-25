// Local dev-server previews for a task's branch. Lets a reviewer click "Preview"
// on a card to run the branch's app (vite dev) from its worktree and open it in a
// browser to verify the change. State is kept in a JSON file so it survives server
// restarts; each preview runs in its own tmux session (like agents).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { randomBytes } from "node:crypto";
import { parseEnvFile } from "./messagebus/config.js";

export interface PreviewState {
  taskId: string;
  ticket: string;
  port: number;
  session: string;
  app: string; // e.g. "apps/new-ui"
  url: string;
  worktree: string;
  startedAt: number;
  ready?: boolean; // true once the dev server accepts connections
  // Set when Mission Control starts the trusted API runner in production-reader mode.
  apiApp?: string; // e.g. "apps/new-api"
  apiPort?: number;
  apiSession?: string;
  apiUrl?: string;
  apiWorktree?: string;
  apiWsPort?: number;
  apiReadOnly?: boolean;
  apiDataSource?: "production";
}

// Kill a preview left running longer than this — a forgotten dev server holds CPU,
// memory, and file watchers, and an API preview additionally holds a connection
// pool against production. Overridable via env (MC_PREVIEW_TTL_MS).
//
// Ten minutes is deliberately short: a preview exists to answer "does this branch
// work", which is a look, not a session. The cost of getting it wrong is
// asymmetric — a preview reaped early is one click to restart, a preview left
// running is invisible until something else on the machine starts failing.
// Bump MC_PREVIEW_TTL_MS for a longer review.
const PREVIEW_TTL_MS = Number(process.env.MC_PREVIEW_TTL_MS) || 10 * 60 * 1000; // 10m
// Cap concurrent previews so a pile of dev servers can't swamp the machine; starting
// one beyond the cap stops the oldest.
const MAX_CONCURRENT_PREVIEWS = Number(process.env.MC_PREVIEW_MAX) || 4;

const mcHome = (): string => process.env.MC_HOME ?? join(homedir(), ".mission-control");
const previewsPath = (): string => join(mcHome(), "swarm", "previews.json");
const registryPath = (): string => join(mcHome(), "swarm", "active-tasks.json");
const worktreesDir = (): string => join(homedir(), "GitProjects", "worktrees");

function loadPreviews(): Record<string, PreviewState> {
  try {
    if (!existsSync(previewsPath())) return {};
    return JSON.parse(readFileSync(previewsPath(), "utf-8")) as Record<string, PreviewState>;
  } catch {
    return {};
  }
}

function savePreviews(p: Record<string, PreviewState>): void {
  const dir = join(mcHome(), "swarm");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(previewsPath(), JSON.stringify(p, null, 2));
}

function sessionAlive(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function previewSessionNames(ticket: string): { frontend: string; api: string } {
  const safeTicket = ticket.replace(/[^A-Za-z0-9_-]/g, "-");
  return {
    frontend: `mc-preview-ui-${safeTicket}`,
    api: `mc-preview-api-${safeTicket}`,
  };
}

function ticketOf(s: string): string {
  const m = s.match(/[A-Z]+-\d+/);
  return m ? m[0] : "";
}

interface RegInfo {
  worktree: string;
  baseBranch: string;
  ticket: string;
}

function registryInfo(taskId: string, title: string): RegInfo | null {
  const ticketFromTitle = ticketOf(title);
  let worktree = "";
  let baseBranch = "";
  let ticket = ticketFromTitle;
  try {
    if (existsSync(registryPath())) {
      const entries = JSON.parse(readFileSync(registryPath(), "utf-8")) as Array<Record<string, unknown>>;
      const e = entries.find(
        (x) => x.mcTaskId === taskId || (typeof x.id === "string" && x.id.startsWith(taskId.slice(0, 8)))
      );
      if (e) {
        worktree = (e.worktree as string) || "";
        baseBranch = (e.baseBranch as string) || "";
        if (typeof e.id === "string" && ticketOf(e.id)) ticket = ticketOf(e.id);
      }
    }
  } catch {
    /* fall through to worktree scan */
  }
  // If the registry has no live entry (agent cleaned up / server restarted), fall
  // back to the conventional worktree location for this ticket.
  if ((!worktree || !existsSync(worktree)) && ticket && existsSync(worktreesDir())) {
    const match = readdirSync(worktreesDir()).find((d) => d.startsWith(`${ticket}-`));
    if (match) worktree = join(worktreesDir(), match);
  }
  if (!worktree || !existsSync(worktree)) return null;
  return { worktree, baseBranch, ticket: ticket || taskId.slice(0, 8) };
}

// An app is previewable only if it has a package.json with a "dev" script (vite,
// SvelteKit, etc.). apps/new-api is Rust — no package.json — so it must never win
// detection even when a task changes it more than the UI.
function isRunnableApp(worktree: string, app: string): boolean {
  const pkgPath = join(worktree, app, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.dev === "string";
  } catch {
    return false;
  }
}

// apps/<x> changed on this branch, with a per-app changed-file count. Diffs against the
// closest base (smallest non-empty diff wins — nearest the branch's fork point).
function _changedAppCounts(worktree: string, baseBranch: string): Record<string, number> {
  const candidates = [baseBranch, "origin/coda/new-ui", "origin/master", "origin/main"].filter(Boolean);
  let bestFiles: string[] = [];
  for (const base of candidates) {
    try {
      const out = execFileSync("git", ["-C", worktree, "diff", "--name-only", `${base}...HEAD`], {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const files = out.split("\n").filter(Boolean);
      if (files.length > 0 && (bestFiles.length === 0 || files.length < bestFiles.length)) {
        bestFiles = files;
      }
    } catch {
      /* base not present locally — skip */
    }
  }
  const counts: Record<string, number> = {};
  for (const f of bestFiles) {
    const m = f.match(/^apps\/([^/]+)\//);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

// Most-changed RUNNABLE frontend app (package.json with a dev script). "" if none.
function detectApp(worktree: string, baseBranch: string): string {
  const counts = _changedAppCounts(worktree, baseBranch);
  const runnable = Object.entries(counts)
    .filter(([name]) => isRunnableApp(worktree, `apps/${name}`))
    .sort((a, b) => b[1] - a[1]);
  if (runnable.length > 0) return `apps/${runnable[0][0]}`;
  if (isRunnableApp(worktree, "apps/new-ui")) return "apps/new-ui";
  return "";
}

const PROD_READER_KEYS = ["MC_PREVIEW_PROD_READ_DATABASE_URL", "FRONTEND_READER_PG_URL"] as const;

export function previewApiRunnerRoot(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  mcEnvPath = join(mcHome(), ".env"),
): string {
  const mcEnv = parseEnvFile(mcEnvPath);
  const configured = (runtimeEnv.MC_PREVIEW_API_RUNNER_ROOT ?? mcEnv.MC_PREVIEW_API_RUNNER_ROOT ?? "").trim();
  return configured ? resolve(configured) : "";
}

// A preview may read production only through an explicitly named reader URL.
// Generic DATABASE_URL, staging URLs, and write URLs are intentionally ignored:
// silently accepting one of those turns a typo into production write authority.
export function productionReaderDatabaseUrl(
  _worktree: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  mcEnvPath = join(mcHome(), ".env"),
): string {
  const mcEnv = parseEnvFile(mcEnvPath);
  for (const key of PROD_READER_KEYS) {
    // Never read this from the task worktree: branch code is exactly what the
    // preview is evaluating and therefore is not a trusted credential source.
    const value = (runtimeEnv[key] ?? mcEnv[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function apiSupportsReadOnlyPreview(worktree: string): boolean {
  try {
    const args = readFileSync(join(worktree, "apps", "new-api", "src", "args.rs"), "utf-8");
    return args.includes('env = "API_READ_ONLY"') && args.includes("pub read_only: bool");
  } catch {
    return false;
  }
}

export function renderPreviewFrontendEnv(source: string, apiUrl: string, wsUrl: string): string {
  const set = (env: string, key: string, value: string): string => {
    const line = `${key}=${value}`;
    return new RegExp(`^${key}=.*$`, "m").test(env)
      ? env.replace(new RegExp(`^${key}=.*$`, "m"), line)
      : `${env.replace(/\s*$/, "")}\n${line}\n`;
  };
  let env = set(source, "PUBLIC_API_URL", apiUrl);
  env = set(env, "PUBLIC_WS_URL", wsUrl);
  return set(env, "PUBLIC_SHOW_CHEATS", "false");
}

interface ReadOnlyApiLaunchSpec {
  command: string;
  environment: Record<string, string>;
}

export function readOnlyApiLaunchSpec(input: {
  databaseUrl: string;
  apiPort: number;
  wsPort: number;
  frontendPort: number;
  logFile: string;
  authSecret?: string;
}): ReadOnlyApiLaunchSpec {
  const frontendOrigin = `http://127.0.0.1:${input.frontendPort}`;
  const sideEffectSecrets = [
    "DATABASE_WRITE_URL",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "TWILIO",
    "NEWSLETTER_UNSUBSCRIBE_SECRET",
    "NEWSLETTER_FROM",
    "NEWSLETTER_REPLY_TO",
    "NEWSLETTER_LEGAL_ADDRESS",
    "SLACK_ERROR",
    "SLACK_WARN",
    "SUPER_ADMINS",
    "INTAKE_PROXY_SECRET",
    "API_PUBLIC_URL",
  ];
  return {
    // Explicit unsets prevent secrets inherited by the tmux server from widening
    // this process. The database URL itself is passed only through tmux's env argv.
    command: `unset ${sideEffectSecrets.join(" ")}; export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec cargo run --quiet -- --read-only --host 127.0.0.1 --port ${input.apiPort} --ws-port ${input.wsPort} > "$MC_PREVIEW_API_LOG" 2>&1`,
    environment: {
      DATABASE_URL: input.databaseUrl,
      API_READ_ONLY: "true",
      API_MAX_DB_CONNECTIONS: "5",
      // Compile against checked-in .sqlx metadata. Besides supporting pooled
      // production readers, this guarantees rustc never queries production.
      SQLX_OFFLINE: "true",
      AUTH_SECRET: input.authSecret ?? randomBytes(32).toString("hex"),
      AUTH_ORIGIN: frontendOrigin,
      API_ALLOWED_ORIGINS: `${frontendOrigin},http://localhost:${input.frontendPort}`,
      DEPLOY_ENVIRONMENT: "DEV",
      MC_PREVIEW_API_LOG: input.logFile,
    },
  };
}

// Poll until the dev server is actually accepting connections, so the browser tab
// isn't opened on a not-yet-listening port. vite dev typically boots in 1-5s.
function waitForPort(port: number, timeoutMs = 25000, session?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = connect({ port, host: "127.0.0.1" });
      sock.setTimeout(2000);
      const retry = (): void => {
        sock.destroy();
        if ((session && !sessionAlive(session)) || Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 300);
      };
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", retry);
      sock.once("timeout", retry);
    };
    attempt();
  });
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

// Stable, memorable port per ticket (base 5000 → MET-531 = 5531 for the frontend;
// base 6000 = 6531 for its backend), bumped until free.
async function allocatePort(ticket: string, base = 5000): Promise<number> {
  const m = ticket.match(/(\d+)/);
  const preferred = base + (m ? parseInt(m[1], 10) % 1000 : 100);
  for (let p = preferred; p < preferred + 60; p++) {
    if (await tryBind(p)) return p;
  }
  return preferred;
}

/** What one sweep tore down, so a caller can say so out loud. */
export interface ReapedPreview {
  taskId: string;
  ticket: string;
  /** `expired` outlived the TTL; `dead` had already lost its tmux session. */
  reason: "expired" | "dead";
  ageMs: number;
}

// Prune previews whose tmux session has died OR that have outlived the TTL (a
// forgotten dev server), killing the session in the latter case. Returns the live
// set plus what it removed.
export function prunePreviews(): { live: Record<string, PreviewState>; reaped: ReapedPreview[] } {
  const p = loadPreviews();
  const reaped: ReapedPreview[] = [];
  const now = Date.now();
  for (const [k, v] of Object.entries(p)) {
    const alive = sessionAlive(v.session) && (!v.apiSession || sessionAlive(v.apiSession));
    const ageMs = now - (v.startedAt ?? 0);
    const stale = ageMs > PREVIEW_TTL_MS;
    if (!alive || stale) {
      // Kill both the frontend and (if any) the backend session; no-op if already gone.
      _killSession(v.session);
      _killSession(v.apiSession);
      delete p[k];
      // A dead session is bookkeeping; an expired one is a preview someone was
      // using a moment ago, and worth distinguishing in the log.
      reaped.push({ taskId: v.taskId ?? k, ticket: v.ticket ?? "", reason: alive ? "expired" : "dead", ageMs });
    }
  }
  if (reaped.length > 0) savePreviews(p);
  return { live: p, reaped };
}

// Prune, then return the live set. The read path for callers that only want the
// current previews and do not care what was cleaned up on the way.
export function getPreviews(): Record<string, PreviewState> {
  return prunePreviews().live;
}

export interface PreviewReaperOptions {
  intervalMs?: number;
  /** Called once per reaped preview. Kept injectable so this file stays logger-free. */
  onReap?: (reaped: ReapedPreview) => void;
}

/**
 * Sweep expired previews on a timer.
 *
 * The TTL itself predates this and is enforced inside {@link prunePreviews} —
 * but nothing called it on a schedule. Every caller was a request handler, so
 * expiry only happened while someone had the dashboard open and polling: close
 * the tab, and a preview ran until the machine was rebooted. The whole point of
 * a TTL is to cover the case where nobody is watching, which was exactly the
 * case it did not cover.
 *
 * Sweeping is cheap (a `tmux has-session` per preview, capped at
 * MAX_CONCURRENT_PREVIEWS) so the interval can be short relative to the TTL —
 * that bounds how far past its deadline a preview can survive.
 */
export function startPreviewReaper(opts: PreviewReaperOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;

  const tick = (): void => {
    try {
      const { reaped } = prunePreviews();
      for (const entry of reaped) opts.onReap?.(entry);
    } catch {
      // A sweep must never take the server down: the registry file could be
      // mid-write, or tmux could be unavailable. The next tick retries.
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export function stopAllPreviews(): number {
  const all = loadPreviews();
  let n = 0;
  for (const v of Object.values(all)) {
    _killSession(v.session);
    _killSession(v.apiSession);
    n += 1;
  }
  savePreviews({});
  return n;
}

export async function startPreview(taskId: string, title: string): Promise<PreviewState> {
  const live = getPreviews(); // prunes dead/stale first
  const existing = live[taskId];
  const configuredApiRoot = previewApiRunnerRoot();
  if (
    existing?.apiReadOnly &&
    existing.apiWorktree === configuredApiRoot &&
    sessionAlive(existing.session) &&
    sessionAlive(existing.apiSession ?? "")
  ) {
    return existing; // already running under the safe production-reader contract
  }
  if (existing) stopPreview(taskId); // replace legacy/frontend-only previews

  // Enforce the concurrency cap — stop the oldest preview to make room.
  const others = Object.values(live).filter((v) => v.taskId !== taskId);
  if (others.length >= MAX_CONCURRENT_PREVIEWS) {
    others.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const victim of others.slice(0, others.length - MAX_CONCURRENT_PREVIEWS + 1)) {
      stopPreview(victim.taskId);
    }
  }

  const info = registryInfo(taskId, title);
  if (!info) {
    throw new Error("No worktree found for this task — run the agent first, or the branch isn't checked out locally.");
  }
  const app = detectApp(info.worktree, info.baseBranch);
  if (!app) {
    throw new Error(
      "No previewable frontend app in this branch — it changes backend/non-JS code (e.g. apps/new-api is Rust) with no runnable dev server."
    );
  }
  const appDir = join(info.worktree, app);
  const port = await allocatePort(info.ticket);
  const sessionNames = previewSessionNames(info.ticket);
  const session = sessionNames.frontend;
  // Detect the package manager. Recognize both bun lockfile names — bun.lockb (binary,
  // older) and bun.lock (text, newer) — at the worktree root or the app. Missing this
  // fell back to npm, which doesn't link vite into the workspace the way bun does.
  const hasBunLock = (dir: string): boolean =>
    existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
  const pm = hasBunLock(info.worktree) || hasBunLock(appDir) ? "bun" : "npm";
  const spawnPath = `${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const logDir = join(mcHome(), "swarm", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  // Every new-ui preview runs a dedicated trusted Rust API checkout locally
  // against production data. Ticket branch code never receives the credential.
  // There is no hosted-API fallback: direct production API access exposes write
  // routes, while this runner requires the API's fail-closed read-only mode.
  let backendUrl = "";
  let apiInfo: { app: string; port: number; wsPort: number; session: string; url: string; worktree: string } | null = null;
  const backendApp = app === "apps/new-ui" ? "apps/new-api" : "";
  if (backendApp) {
    const apiRoot = configuredApiRoot;
    if (!apiRoot) {
      throw new Error(
        "Production preview is locked: configure MC_PREVIEW_API_RUNNER_ROOT to a dedicated trusted backend checkout. Ticket worktrees are never given production credentials."
      );
    }
    if (resolve(apiRoot) === resolve(info.worktree)) {
      throw new Error("MC_PREVIEW_API_RUNNER_ROOT must be a dedicated trusted checkout, not this ticket's worktree.");
    }
    if (!existsSync(join(apiRoot, backendApp, "Cargo.toml"))) {
      throw new Error("The trusted production preview runner does not contain apps/new-api.");
    }
    if (!apiSupportsReadOnlyPreview(apiRoot)) {
      throw new Error(
        "The trusted apps/new-api runner does not support --read-only. Update MC_PREVIEW_API_RUNNER_ROOT to the hardened backend revision."
      );
    }
    const readerDsn = productionReaderDatabaseUrl(info.worktree);
    if (!readerDsn) {
      throw new Error(
        "Production preview is locked: add MC_PREVIEW_PROD_READ_DATABASE_URL (or FRONTEND_READER_PG_URL) in Mission Control Settings. Writable DATABASE_URL values are never accepted."
      );
    }
    const apiPort = await allocatePort(info.ticket, 6000);
    const apiWsPort = await allocatePort(info.ticket, 7000);
    const apiSession = sessionNames.api;
    const apiDir = join(apiRoot, backendApp);
    const apiLog = join(logDir, `preview-${info.ticket}-api.log`);
    try {
      execFileSync("tmux", ["kill-session", "-t", `=${apiSession}`], { stdio: "ignore" });
    } catch {
      /* none */
    }
    const spec = readOnlyApiLaunchSpec({
      databaseUrl: readerDsn,
      apiPort,
      wsPort: apiWsPort,
      frontendPort: port,
      logFile: apiLog,
    });
    const tmuxEnvironment = Object.entries(spec.environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", apiSession, "-c", apiDir, ...tmuxEnvironment, `bash -lc '${spec.command}'`],
      { timeout: 15000 }
    );
    const apiReady = await waitForPort(apiPort, 600000, apiSession); // first Rust build can take minutes
    if (!apiReady) {
      let tail = "";
      try {
        tail = readFileSync(apiLog, "utf-8").trim().split("\n").slice(-16).join("\n");
      } catch {
        /* no log */
      }
      _killSession(apiSession);
      throw new Error(`Read-only production API failed to start.${tail ? "\n\n" + tail : ""}`);
    }
    backendUrl = `http://127.0.0.1:${apiPort}`;
    apiInfo = {
      app: backendApp,
      port: apiPort,
      wsPort: apiWsPort,
      session: apiSession,
      url: backendUrl,
      worktree: apiRoot,
    };
  }

  // A worktree may be missing the app's .env (only .env.example is committed) or its
  // deps (vite not installed), which crashes the dev server instantly. Prepare both
  // before launching so the preview actually boots. new-ui points only at the
  // locally-enforced read-only API; it never receives a writable hosted API URL.
  const envFile = join(appDir, ".env");
  const envExample = join(appDir, ".env.example");
  const previewApi = backendUrl || process.env.MC_PREVIEW_API_URL || "https://api.metadao.fi";
  try {
    let env = "";
    if (existsSync(envFile)) env = readFileSync(envFile, "utf-8");
    else if (existsSync(envExample)) env = readFileSync(envExample, "utf-8");
    if (apiInfo) env = renderPreviewFrontendEnv(env, previewApi, `ws://127.0.0.1:${apiInfo.wsPort}/v1/ws`);
    else env = renderPreviewFrontendEnv(env, previewApi, "");
    writeFileSync(envFile, env);
  } catch (error) {
    _killSession(apiInfo?.session);
    throw new Error(`Could not lock preview frontend to the read-only API: ${error instanceof Error ? error.message : String(error)}`);
  }
  const viteResolvable =
    existsSync(join(appDir, "node_modules", ".bin", "vite")) ||
    existsSync(join(info.worktree, "node_modules", ".bin", "vite"));
  if (!viteResolvable) {
    try {
      execFileSync(pm, ["install"], {
        cwd: info.worktree,
        timeout: 300000,
        stdio: "ignore",
        env: { ...process.env, PATH: spawnPath },
      });
    } catch {
      /* dev server will surface the error below if this didn't resolve it */
    }
  }

  // Kill any stale session with this name, then start vite dev — logging to a file
  // so a boot failure is diagnosable (the tmux session vanishes when the server exits).
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
  } catch {
    /* no prior session */
  }
  const logFile = join(logDir, `preview-${info.ticket}.log`);
  const inner = `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${pm} run dev -- --port ${port} --host 127.0.0.1 > "$MC_PREVIEW_UI_LOG" 2>&1`;
  try {
    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", session, "-c", appDir, "-e", `MC_PREVIEW_UI_LOG=${logFile}`, `bash -lc '${inner}'`],
      {
      timeout: 15000,
      }
    );
  } catch (error) {
    _killSession(apiInfo?.session);
    throw error;
  }

  // Block until the dev server is listening, so the caller can open the tab on a
  // ready port instead of hitting connection-refused during vite's boot.
  const ready = await waitForPort(port);
  if (!ready && !sessionAlive(session)) {
    // Crashed during boot — surface the real reason from the log.
    let tail = "";
    try {
      tail = readFileSync(logFile, "utf-8").trim().split("\n").slice(-12).join("\n");
    } catch {
      /* no log */
    }
    _killSession(apiInfo?.session);
    throw new Error(`Preview failed to start (${app}).${tail ? "\n\n" + tail : ""}`);
  }

  const state: PreviewState = {
    taskId,
    ticket: info.ticket,
    port,
    session,
    app,
    url: `http://127.0.0.1:${port}`,
    worktree: info.worktree,
    startedAt: Date.now(),
    ready,
  };
  if (apiInfo) {
    state.apiApp = apiInfo.app;
    state.apiPort = apiInfo.port;
    state.apiSession = apiInfo.session;
    state.apiUrl = apiInfo.url;
    state.apiWorktree = apiInfo.worktree;
    state.apiWsPort = apiInfo.wsPort;
    state.apiReadOnly = true;
    state.apiDataSource = "production";
  }
  const all = loadPreviews();
  all[taskId] = state;
  savePreviews(all);
  return state;
}

function _killSession(session?: string): void {
  if (!session) return;
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

export function stopPreview(taskId: string): boolean {
  const all = loadPreviews();
  const state = all[taskId];
  if (!state) return false;
  _killSession(state.session);
  _killSession(state.apiSession); // also stop the local backend if we started one
  delete all[taskId];
  savePreviews(all);
  return true;
}
