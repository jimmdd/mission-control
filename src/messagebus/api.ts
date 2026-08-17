// Local API client used by the command layer.
//
// Commands go over HTTP to this same process rather than straight to the DB, so a
// command from chat takes the identical path a click in the dashboard takes — including
// the side effects that live in the route handlers (agent relaunch on feedback, task
// resume on checkpoint approval, delegation roll-up on done).
import type { ApiClient } from "./commands.js";

function firstToken(...names: string[]): string {
  for (const name of names) {
    const token = (process.env[name] ?? "").trim();
    if (token) return token;
  }
  return "";
}

/**
 * Mirrors routes.ts requiredAccessToken: in scoped auth mode reads and writes want
 * different tokens, and the comparison is exact, so sending the write token to a GET
 * would 401. Simple mode has one token for everything.
 */
function tokenFor(method: string): string {
  const fallback = firstToken("MISSION_CONTROL_ACCESS_TOKEN", "MISSION_CONTROL_READ_ACCESS_TOKEN");
  const scoped = (process.env.MISSION_CONTROL_AUTH_MODE ?? "simple").trim().toLowerCase() === "scoped";
  if (!scoped) return fallback;
  if (method === "GET") return firstToken("MISSION_CONTROL_READ_TOKEN") || fallback;
  return firstToken("MISSION_CONTROL_WRITE_TOKEN") || fallback;
}

export function createLocalApiClient(baseUrl: string): ApiClient {
  const call = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> => {
    const token = tokenFor(method);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).error === "string"
          ? String((parsed as Record<string, unknown>).error)
          : `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return parsed;
  };

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
  };
}
