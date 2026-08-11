// Mission Control has two model layers: the agents it spawns, and its own calls
// (planning, step classification, the verification fallback). The second layer
// used to require an API key — Anthropic or Gemini — even on a machine whose
// value is a logged-in CLI subscription. claude-cli and codex-cli route that
// layer through the CLIs instead.
//
// These drive planner.py through python3 with the CLI stubbed, so no quota is
// spent and the tests run offline.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

let mcHome;
let binDir;

/** A fake `claude`/`codex` on PATH that echoes its argv and exits as told. */
function stubCli(name, { exitCode = 0, stdout = "STUB OK" } = {}) {
  const path = join(binDir, name);
  writeFileSync(
    path,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${binDir}/${name}.argv"\n` +
      `printf '%s' ${JSON.stringify(stdout)}\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
}

/** argv the stub was last invoked with. */
function stubArgv(name) {
  return execFileSync("cat", [join(binDir, `${name}.argv`)], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test.before(() => {
  mcHome = mkdtempSync(join(tmpdir(), "mc-providers-"));
  binDir = mkdtempSync(join(tmpdir(), "mc-stub-bin-"));
  stubCli("claude");
  stubCli("codex");
});

test.after(() => {
  for (const dir of [mcHome, binDir]) if (dir) rmSync(dir, { recursive: true, force: true });
});

function call(program) {
  const stdout = execFileSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SWARM)})\n${program}`], {
    env: { ...process.env, MC_HOME: mcHome, PATH: `${binDir}:${process.env.PATH}` },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

test("claude-cli returns the CLI's output and needs no API key", () => {
  const out = call(`
import json, os
os.environ.pop("ANTHROPIC_API_KEY", None)
import planner
print(json.dumps(planner._call_claude_cli("hi", model="claude-opus-5")))
`);
  assert.equal(out, "STUB OK");
});

test("claude-cli asks for text output and no tools", () => {
  call(`
import json, planner
print(json.dumps(planner._call_claude_cli("hi", model="claude-opus-5", system="be terse")))
`);
  const argv = stubArgv("claude");
  assert.deepEqual(argv.slice(0, 2), ["-p", "hi"]);
  assert.ok(argv.includes("--model") && argv.includes("claude-opus-5"));
  assert.ok(argv.includes("--output-format") && argv.includes("text"));
  // A planner call is one question. Leaving tools on would let it touch the repo.
  assert.ok(argv.includes("--allowed-tools"));
  assert.ok(argv.includes("--append-system-prompt") && argv.includes("be terse"));
});

test("codex-cli folds the system prompt into the message", () => {
  call(`
import json, planner
print(json.dumps(planner._call_codex_cli("question", model="gpt-5.6-sol", system="context")))
`);
  const argv = stubArgv("codex");
  assert.equal(argv[0], "exec");
  assert.ok(argv.includes("gpt-5.6-sol"));
  // codex exec has no system flag, and it must not be silently dropped. The
  // combined prompt spans lines, so match the whole argv text rather than one arg.
  const text = argv.join("\n");
  assert.ok(text.indexOf("context") < text.indexOf("question"));
  // Read-only: a planning call has no business writing to the working tree.
  assert.ok(argv.includes("--sandbox") && argv.includes("read-only"));
});

test("a failing CLI returns nothing rather than its error text", () => {
  stubCli("claude", { exitCode: 1, stdout: "auth error" });
  const out = call(`
import json, planner
print(json.dumps(planner._call_claude_cli("hi", model="claude-opus-5")))
`);
  assert.equal(out, null);
  stubCli("claude");
});

test("empty CLI output is nothing, not an empty answer", () => {
  stubCli("claude", { stdout: "   " });
  const out = call(`
import json, planner
print(json.dumps(planner._call_claude_cli("hi", model="claude-opus-5")))
`);
  assert.equal(out, null);
  stubCli("claude");
});

test("_call_llm routes a role to the configured CLI provider", () => {
  const out = call(`
import json, os, pathlib, planner
cfg = pathlib.Path(os.environ["MC_HOME"]) / "swarm" / "swarm-config.json"
cfg.parent.mkdir(parents=True, exist_ok=True)
cfg.write_text(json.dumps({"planner": {
    "planning_model": "claude-opus-5", "planning_provider": "claude-cli",
}}))
print(json.dumps(planner._call_llm("hi", role="planning")))
`);
  assert.equal(out, "STUB OK");
});
