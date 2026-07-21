// Local dev-server previews for a task's branch. Lets a reviewer click "Preview"
// on a card to run the branch's app (vite dev) from its worktree and open it in a
// browser to verify the change. State is kept in a JSON file so it survives server
// restarts; each preview runs in its own tmux session (like agents).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer, connect } from "node:net";

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
  // Set when the branch touches the backend and we ran it locally (against staging DB).
  apiApp?: string; // e.g. "apps/new-api"
  apiPort?: number;
  apiSession?: string;
  apiUrl?: string;
}

// Kill a preview left running longer than this — a forgotten dev server holds CPU,
// memory, and file watchers. Overridable via env for testing.
const PREVIEW_TTL_MS = Number(process.env.MC_PREVIEW_TTL_MS) || 2 * 60 * 60 * 1000; // 2h
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
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

// Most-changed BACKEND app on this branch — a Rust service (Cargo.toml, no package.json
// dev script). "" if the branch doesn't touch a backend. Used to decide whether to run
// the API locally so the task's API changes are testable.
function _detectBackendApp(worktree: string, baseBranch: string): string {
  const counts = _changedAppCounts(worktree, baseBranch);
  const backend = Object.entries(counts)
    .filter(([name]) => existsSync(join(worktree, "apps", name, "Cargo.toml")))
    .sort((a, b) => b[1] - a[1]);
  return backend.length > 0 ? `apps/${backend[0][0]}` : "";
}

// Staging Postgres DSN for running the backend locally. Reads the same sources the
// repo's `just pull-db` uses, plus an MC-specific override. Never logged. "" if unset.
function _stagingDb(worktree: string): string {
  const fromEnv =
    process.env.MC_PREVIEW_DATABASE_URL ||
    process.env.STAGING_PG_URL ||
    process.env.FRONTEND_READER_PG_URL;
  if (fromEnv) return fromEnv;
  const prod = join(worktree, ".env.prod");
  if (existsSync(prod)) {
    try {
      const m = readFileSync(prod, "utf-8").match(
        /^(?:MC_PREVIEW_DATABASE_URL|STAGING_PG_URL|FRONTEND_READER_PG_URL|DATABASE_URL)=(.+)$/m
      );
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* unreadable */
    }
  }
  return "";
}

// Poll until the dev server is actually accepting connections, so the browser tab
// isn't opened on a not-yet-listening port. vite dev typically boots in 1-5s.
function waitForPort(port: number, timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = connect({ port, host: "127.0.0.1" });
      sock.setTimeout(2000);
      const retry = (): void => {
        sock.destroy();
        if (Date.now() >= deadline) resolve(false);
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

// Prune previews whose tmux session has died OR that have outlived the TTL (a
// forgotten dev server), killing the session in the latter case. Returns the live set.
export function getPreviews(): Record<string, PreviewState> {
  const p = loadPreviews();
  let changed = false;
  const now = Date.now();
  for (const [k, v] of Object.entries(p)) {
    const alive = sessionAlive(v.session);
    const stale = now - (v.startedAt ?? 0) > PREVIEW_TTL_MS;
    if (!alive || stale) {
      // Kill both the frontend and (if any) the backend session; no-op if already gone.
      _killSession(v.session);
      _killSession(v.apiSession);
      delete p[k];
      changed = true;
    }
  }
  if (changed) savePreviews(p);
  return p;
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
  if (existing && sessionAlive(existing.session)) return existing; // already running

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
  const session = `mc-preview-${info.ticket}`;
  // Detect the package manager. Recognize both bun lockfile names — bun.lockb (binary,
  // older) and bun.lock (text, newer) — at the worktree root or the app. Missing this
  // fell back to npm, which doesn't link vite into the workspace the way bun does.
  const hasBunLock = (dir: string): boolean =>
    existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
  const pm = hasBunLock(info.worktree) || hasBunLock(appDir) ? "bun" : "npm";
  const spawnPath = `${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const logDir = join(mcHome(), "swarm", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  // If the branch touches the backend, run it LOCALLY (with the branch's API changes)
  // against the staging DB, and point the frontend at it — so API changes are testable.
  // Needs a staging DSN (MC_PREVIEW_DATABASE_URL / STAGING_PG_URL / FRONTEND_READER_PG_URL
  // / .env.prod). Without one, we fall back to the hosted API (frontend-only preview).
  let backendUrl = "";
  let apiInfo: { app: string; port: number; session: string; url: string; ready: boolean } | null = null;
  const backendApp = _detectBackendApp(info.worktree, info.baseBranch);
  const stagingDsn = backendApp ? _stagingDb(info.worktree) : "";
  if (backendApp && stagingDsn) {
    const apiPort = await allocatePort(info.ticket, 6000);
    const apiSession = `mc-preview-${info.ticket}-api`;
    const apiDir = join(info.worktree, backendApp);
    const apiLog = join(logDir, `preview-${info.ticket}-api.log`);
    try {
      execFileSync("tmux", ["kill-session", "-t", apiSession], { stdio: "ignore" });
    } catch {
      /* none */
    }
    // DATABASE_URL is passed via tmux -e (argv, not a shell string), so the DSN — which
    // contains special chars and is a secret — is never shell-interpolated or logged.
    const apiInner = `export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec cargo run --quiet -- --port ${apiPort} > ${apiLog} 2>&1`;
    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", apiSession, "-c", apiDir, "-e", `DATABASE_URL=${stagingDsn}`, `bash -lc '${apiInner}'`],
      { timeout: 15000 }
    );
    const apiReady = await waitForPort(apiPort, 600000); // first Rust build can take minutes
    backendUrl = `http://localhost:${apiPort}`;
    apiInfo = { app: backendApp, port: apiPort, session: apiSession, url: backendUrl, ready: apiReady };
  }

  // A worktree may be missing the app's .env (only .env.example is committed) or its
  // deps (vite not installed), which crashes the dev server instantly. Prepare both
  // before launching so the preview actually boots. Point the frontend at the local
  // backend if we started one, else a hosted API (MC_PREVIEW_API_URL, default prod) —
  // the committed default PUBLIC_API_URL is a local backend that isn't running.
  const envFile = join(appDir, ".env");
  const envExample = join(appDir, ".env.example");
  const previewApi = backendUrl || process.env.MC_PREVIEW_API_URL || "https://api.metadao.fi";
  try {
    let env = "";
    if (existsSync(envFile)) env = readFileSync(envFile, "utf-8");
    else if (existsSync(envExample)) env = readFileSync(envExample, "utf-8");
    if (env) {
      if (/^PUBLIC_API_URL=/m.test(env)) {
        env = env.replace(/^PUBLIC_API_URL=.*$/m, `PUBLIC_API_URL=${previewApi}`);
      } else {
        env += `\nPUBLIC_API_URL=${previewApi}\n`;
      }
      writeFileSync(envFile, env);
    }
  } catch {
    /* best effort — preview still boots, just may not load remote data */
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
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  } catch {
    /* no prior session */
  }
  const logFile = join(logDir, `preview-${info.ticket}.log`);
  const inner = `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${pm} run dev -- --port ${port} --host > ${logFile} 2>&1`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", appDir, `bash -lc '${inner}'`], {
    timeout: 15000,
  });

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
    throw new Error(`Preview failed to start (${app}).${tail ? "\n\n" + tail : ""}`);
  }

  const state: PreviewState = {
    taskId,
    ticket: info.ticket,
    port,
    session,
    app,
    url: `http://localhost:${port}`,
    worktree: info.worktree,
    startedAt: Date.now(),
    ready,
  };
  if (apiInfo) {
    state.apiApp = apiInfo.app;
    state.apiPort = apiInfo.port;
    state.apiSession = apiInfo.session;
    state.apiUrl = apiInfo.url;
  }
  const all = loadPreviews();
  all[taskId] = state;
  savePreviews(all);
  return state;
}

function _killSession(session?: string): void {
  if (!session) return;
  try {
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
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
