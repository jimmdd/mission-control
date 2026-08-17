// How a ticket is named in chat, in both directions.
//
// Internally a task is a UUID; nobody thinks that way. People say "MET-635" — often
// typed loosely, as "met 635" or "met635" — so out here a ticket is its Linear key
// whenever it has one, and the short UUID only when it does not.

type TaskLike = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The Linear key is not a column: `external_id` holds Linear's own UUID. The key lives
 * in the title prefix the importer writes ("[MET-639] …") and in the issue URL.
 */
export function linearKey(task: TaskLike): string | null {
  const fromTitle = /\[([A-Za-z]{2,}-\d+)\]/.exec(str(task.title));
  if (fromTitle) return fromTitle[1].toUpperCase();
  const fromUrl = /\/([A-Za-z]{2,}-\d+)(?:\/|$)/.exec(str(task.external_url));
  if (fromUrl) return fromUrl[1].toUpperCase();
  return null;
}

/** What every chat message calls this ticket. */
export function taskLabel(task: TaskLike): string {
  return linearKey(task) ?? str(task.id).slice(0, 8);
}

/** The title without the "[MET-639] " prefix, which the label already carries. */
export function taskTitle(task: TaskLike): string {
  return str(task.title).replace(/^\s*\[[A-Za-z]{2,}-\d+\]\s*/, "").trim();
}

/**
 * Accept the loose forms of a key: "met 635", "met-635", "MET635", "met_635" all mean
 * MET-635. Anything else is passed through untouched for id/title matching.
 */
export function normalizeRef(ref: string): string {
  const match = /^([A-Za-z]{2,})[\s_-]*(\d+)$/.exec(ref.trim());
  return match ? `${match[1].toUpperCase()}-${match[2]}` : ref.trim();
}

/**
 * Split "<ref> <rest…>" when the ref itself may contain a space. "/answer met 635 use
 * main" has to mean ref MET-635 and text "use main", not ref "met" — otherwise the most
 * natural way to type it silently addresses the wrong ticket, or 69 of them.
 */
export function takeRef(input: string): { ref: string; rest: string } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ref: "", rest: "" };
  if (tokens.length >= 2 && /^[A-Za-z]{2,}$/.test(tokens[0]) && /^\d+$/.test(tokens[1])) {
    return { ref: normalizeRef(`${tokens[0]}-${tokens[1]}`), rest: tokens.slice(2).join(" ") };
  }
  return { ref: normalizeRef(tokens[0]), rest: tokens.slice(1).join(" ") };
}
