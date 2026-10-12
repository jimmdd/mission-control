import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code, env = {}) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SWARM)})
${code}
`], { encoding: "utf8", env: { ...process.env, ...env } }));
}

// A trimmed copy of the operator's real config.toml shape (2026-09-22): oh-my-codex
// top-level keys, a multi-line notify, OMX/OMO tables, and the MCP servers and
// plugins tickets actually use.
const CONFIG = `# oh-my-codex top-level settings (must be before any [table])
model_reasoning_effort = "high"
developer_instructions = "You have oh-my-codex installed. AGENTS.md is the orchestration brain."
model_context_window = 250000
model = "gpt-6-astra"
notify = [
  "/path/SkyComputerUseClient",
  "turn-ended",
]
approval_policy = "never"

[marketplaces.openai-bundled]
source_type = "local"

[plugins."browser@openai-bundled"]
enabled = true

[features]
child_agents_md = true
hooks = true

[agents]
enabled = false
max_depth = 2

[agents.explorer]
config_file = "./agents/explorer.toml"

[tui]
status_line = ["model"]

[mcp_servers.paper]
url = "http://127.0.0.1:29979/mcp"

[marketplaces.sisyphuslabs]
source = "/Users/x/.codex/plugins/cache/sisyphuslabs"

[plugins."omo@sisyphuslabs"]
enabled = true

[hooks.state."omo@sisyphuslabs:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:abc"

[projects."/Users/x/GitProjects/backend"]
trust_level = "trusted"
`;

test("the MC Codex config drops the orchestration layers and keeps what tickets use", () => {
  const r = python(`
import codex_home, tomllib
out = codex_home.filter_config(${JSON.stringify(CONFIG)})
d = tomllib.loads(out)
print(json.dumps({"d": d, "text": out}))
`);
  const { d, text } = r;
  assert.equal(d.developer_instructions, undefined);
  assert.equal(d.notify, undefined, "including the multi-line array");
  assert.equal(d.agents, undefined);
  assert.equal(d.tui, undefined);
  assert.equal(d.hooks, undefined);
  assert.equal(d.marketplaces.sisyphuslabs, undefined);
  assert.equal(d.plugins["omo@sisyphuslabs"], undefined);
  assert.doesNotMatch(text, /oh-my-codex installed|sisyphuslabs|SkyComputerUseClient/);
  // Kept: model settings, the plugins and MCP servers tickets rely on, project trust.
  assert.equal(d.model, "gpt-6-astra");
  assert.equal(d.model_context_window, 250000);
  assert.equal(d.approval_policy, "never");
  assert.deepEqual(d.plugins, { "browser@openai-bundled": { enabled: true } });
  assert.equal(d.marketplaces["openai-bundled"].source_type, "local");
  assert.deepEqual(d.mcp_servers, { paper: { url: "http://127.0.0.1:29979/mcp" } });
  assert.equal(d.features.child_agents_md, true);
  assert.equal(d.projects["/Users/x/GitProjects/backend"].trust_level, "trusted");
});

test("the isolated home links runtime pieces, writes no AGENTS.md, and never touches ~/.codex", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-codexhome-"));
  const user = join(root, "user-codex");
  mkdirSync(join(user, "plugins"), { recursive: true });
  mkdirSync(join(user, "agents"), { recursive: true });
  writeFileSync(join(user, "auth.json"), "{}");
  writeFileSync(join(user, "AGENTS.md"), "# oh-my-codex brain");
  writeFileSync(join(user, "hooks.json"), "{}");
  writeFileSync(join(user, "config.toml"), CONFIG);
  const r = python(`
import codex_home, os
from pathlib import Path
mc, user = Path(${JSON.stringify(join(root, "mc"))}), Path(${JSON.stringify(user)})
home = codex_home.ensure(mc, user)
first = (home / "config.toml").stat().st_mtime_ns
again = codex_home.ensure(mc, user)
# A real directory someone put where a link would go is left alone.
(user / "browser").mkdir()
(home / "browser").mkdir()
codex_home.ensure(mc, user)
print(json.dumps({
  "home": str(home), "same": str(again) == str(home),
  "entries": sorted(os.listdir(home)),
  "auth_link": os.readlink(home / "auth.json"), "plugins_link": os.readlink(home / "plugins"),
  "rewritten": (home / "config.toml").stat().st_mtime_ns != first,
  "browser_is_dir": (home / "browser").is_dir() and not (home / "browser").is_symlink(),
  "user_entries": sorted(os.listdir(user)),
}))
`);
  assert.ok(r.home.endsWith("/mc/codex-home"));
  assert.equal(r.same, true);
  assert.deepEqual(r.entries, ["auth.json", "browser", "config.toml", "plugins"]);
  assert.equal(r.auth_link, join(user, "auth.json"), "token refreshes are shared, not copied");
  assert.equal(r.plugins_link, join(user, "plugins"));
  assert.equal(r.rewritten, false, "an unchanged config is not rewritten");
  assert.equal(r.browser_is_dir, true);
  assert.deepEqual(r.user_entries, ["AGENTS.md", "agents", "auth.json", "browser", "config.toml", "hooks.json", "plugins"],
    "nothing written into the operator's home");
});

test("run-codex.sh exports the isolated home when opted in, with a fallback", async () => {
  const { readFileSync } = await import("node:fs");
  const sh = readFileSync(new URL("../swarm/run-codex.sh", import.meta.url), "utf8");
  const iso = sh.indexOf('if [ "${MC_CODEX_ISOLATE:-0}" = "1" ]; then');
  const launch = sh.indexOf("codex exec --model");
  assert.ok(iso > 0 && launch > iso, "isolation is set up before codex is launched");
  assert.match(sh, /ISO_HOME=\$\(python3 "\$SCRIPT_DIR\/codex_home\.py" ensure/);
  assert.match(sh, /export CODEX_HOME="\$ISO_HOME"/);
  assert.match(sh, /could not build the isolated Codex home — using ~\/\.codex/);
});

// ─────────── roles ───────────

/** A fake `codex` on PATH: records its argv and stdin, writes a reply to the -o file. */
function fakeCodex(behaviour) {
  const dir = mkdtempSync(join(tmpdir(), "mc-fakecodex-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env python3
import sys, json, time, os
args = sys.argv[1:]
stdin = sys.stdin.read()
open(${JSON.stringify(join(dir, "call.json"))}, "w").write(json.dumps({"args": args, "stdin": stdin,
    "codex_home": os.environ.get("CODEX_HOME", "")}))
out = args[args.index("-o") + 1]
b = ${JSON.stringify(behaviour)}
if b == "ok":
    open(out, "w").write("VERDICT: APPROVE\\nBLOCKERS:\\nNOTES:\\n- fine")
elif b == "huge":
    open(out, "w").write("x" * 9000)
elif b == "fail":
    sys.stderr.write("model not available"); sys.exit(3)
elif b == "hang":
    time.sleep(30)
`);
  chmodSync(bin, 0o755);
  return { dir, PATH: `${dir}:${process.env.PATH}` };
}

function runRole(role, request, { behaviour = "ok", images = [], timeout } = {}) {
  const fake = fakeCodex(behaviour);
  const cfg = timeout ? { roles: { [role]: { timeout } } } : {};
  const r = python(`
import roles, io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = roles.run(${JSON.stringify(role)}, ${JSON.stringify(request)}, "/tmp", ${JSON.stringify(images)},
                   env=dict(__import__("os").environ, CODEX_HOME="/iso/home"),
                   swarm_config=${JSON.stringify(cfg)})
call = None
try:
    call = json.load(open(${JSON.stringify(join(fake.dir, "call.json"))}))
except Exception:
    pass
print(json.dumps({"rc": rc, "out": buf.getvalue(), "call": call}))
`, { PATH: fake.PATH });
  return r;
}

test("a role runs read-only, ephemeral, on its own model, and returns only the final answer", () => {
  const r = runRole("critic", "ticket criteria: X");
  assert.equal(r.rc, 0);
  assert.equal(r.out.trim(), "VERDICT: APPROVE\nBLOCKERS:\nNOTES:\n- fine");
  const a = r.call.args;
  assert.deepEqual(a.slice(0, 5), ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral"]);
  assert.equal(a[a.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.ok(a.includes("model_reasoning_effort=high"));
  assert.equal(a[a.indexOf("--cd") + 1], "/tmp");
  assert.match(r.call.stdin, /^You are CRITIC/);
  assert.match(r.call.stdin, /Approval bias: when in doubt, APPROVE/);
  assert.match(r.call.stdin, /REQUEST:\nticket criteria: X\n$/);
  assert.equal(r.call.codex_home, "/iso/home");
});

test("explore and looker run on the cheap model; looker attaches the images", () => {
  const img = join(mkdtempSync(join(tmpdir(), "mc-img-")), "shot.png");
  writeFileSync(img, "png");
  const looker = runRole("looker", "is the nav centered?", { images: [img, img] });
  assert.equal(looker.rc, 0);
  const a = looker.call.args;
  assert.equal(a[a.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.ok(a.includes("model_reasoning_effort=low"));
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--image"), [img, img]);
  const explore = runRole("explore", "where is X?");
  assert.equal(explore.call.args[explore.call.args.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.ok(!explore.call.args.includes("--image"));
});

test("answers are capped so a helper cannot flood the caller's context", () => {
  const r = runRole("explore", "q", { behaviour: "huge" });
  assert.equal(r.rc, 0);
  assert.equal(r.out.trim().length, 6000 + "\n[truncated at 6000 chars]".length);
  assert.match(r.out, /\[truncated at 6000 chars\]\s*$/);
});

test("every failure is a fast, explicit ROLE ERROR the agent can proceed past", () => {
  const failed = runRole("critic", "q", { behaviour: "fail" });
  assert.equal(failed.rc, 2);
  assert.match(failed.out, /^ROLE ERROR: critic exited 3 without an answer\.\nmodel not available/);

  const hung = runRole("critic", "q", { behaviour: "hang", timeout: 1 });
  assert.equal(hung.rc, 2);
  assert.match(hung.out, /^ROLE ERROR: critic timed out after 1s\. Proceed without it\./);

  const noImage = runRole("looker", "q");
  assert.equal(noImage.rc, 2);
  assert.match(noImage.out, /looker needs at least one --image/);
  assert.equal(noImage.call, null, "codex is not started for a request that cannot work");

  const missing = runRole("looker", "q", { images: ["/nope/shot.png"] });
  assert.match(missing.out, /image not found: \/nope\/shot\.png/);
});

test("swarm-config can retune a role, and unknown roles are refused", () => {
  const r = python(`
import roles
cfg = roles.role_config("explore", {"roles": {"explore": {"model": "gpt-5.6-terra", "effort": "medium", "shell": "evil"}}})
try:
    roles.role_config("planner", {})
    unknown = None
except ValueError as e:
    unknown = str(e)
print(json.dumps({"cfg": cfg, "unknown": unknown}))
`);
  assert.deepEqual(r.cfg, { model: "gpt-5.6-terra", effort: "medium", timeout: 300 });
  assert.match(r.unknown, /unknown role 'planner'; one of explore, looker, critic, oracle/);
});

test("each role prompt fixes a short reply shape", async () => {
  const { readFileSync } = await import("node:fs");
  const read = n => readFileSync(new URL(`../swarm/roles/${n}.md`, import.meta.url), "utf8");
  assert.match(read("explore"), /FILES:\n- path:line[\s\S]*ANSWER:[\s\S]*NEXT:/);
  assert.match(read("explore"), /at most 40 lines/);
  assert.match(read("looker"), /VERDICT: MATCH \| MISMATCH \| CANNOT TELL/);
  assert.match(read("critic"), /VERDICT: APPROVE \| REJECT\nBLOCKERS: \(at most 3/);
  assert.match(read("critic"), /is a NOTE, never a blocker/);
  assert.match(read("oracle"), /ACTION PLAN: \(at most 7 numbered steps\)/);
  for (const n of ["explore", "looker", "critic", "oracle"]) assert.match(read(n), /read-only|cannot edit/i, n);
});
