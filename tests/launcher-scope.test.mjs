import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = fileURLToPath(new URL('../swarm', import.meta.url));

// Run each actual launcher. Only the model executable is replaced: it records
// exactly what the shell sends it. No mcTaskId means no HTTP heartbeat.
function launchedPrompt(launcher, mode) {
  const home = mkdtempSync(join(tmpdir(), 'mc-launcher-scope-'));
  try {
    const swarm = join(home, 'swarm'), bin = join(home, 'bin');
    mkdirSync(join(swarm, 'logs'), { recursive: true });
    mkdirSync(join(swarm, 'prompts'), { recursive: true });
    mkdirSync(bin);
    // Match setup.sh: the renderer is shipped beside the source launchers,
    // rather than linked into MC_HOME/swarm. Every launcher must resolve it.
    for (const name of ['run-claude.sh', 'run-codex.sh', 'run-pi.sh', 'mc-api.sh', 'swarm-state.py']) {
      symlinkSync(join(source, name), join(swarm, name));
    }
    writeFileSync(join(swarm, 'swarm-config.json'), '{}');
    writeFileSync(join(swarm, 'active-tasks.json'), JSON.stringify([{ id: 'scope', status: 'running' }]));
    writeFileSync(join(swarm, 'prompts/scope.md'), 'Original task: update the draft after required checks. Preserve human constraints.');
    const capture = join(home, 'input.txt');
    writeFileSync(join(bin, launcher), `#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
prompt=sys.stdin.read() if ${JSON.stringify(launcher)}=='claude' else sys.argv[-1]
Path(os.environ['FIXTURE_CAPTURE']).write_text(prompt)
print(json.dumps({'type':'result','subtype':'success','result':'fixture complete'}))
`, { mode: 0o755 });
    execFileSync('bash', [join(swarm, `run-${launcher}.sh`), 'scope'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MC_HOME: home,
        AGENT_WATCHDOG_POLL_SECONDS: '1', MC_TASK_ID: '', MC_CODEX_ISOLATE: '0', MAX_AGENT_RETRIES: '1',
        MC_REVIEW_ONLY: mode === 'review' ? '1' : '0', MC_NO_PR_MODE: mode === 'local' ? '1' : '0',
        FIXTURE_CAPTURE: capture, MISSION_CONTROL_URL: 'http://127.0.0.1:9' },
    });
    return readFileSync(capture, 'utf8');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const launcher of ['claude', 'codex', 'pi']) {
  for (const mode of ['normal', 'local', 'review']) {
    test(`actual ${launcher} input preserves ${mode} scope`, () => {
      const input = launchedPrompt(launcher, mode);
      assert.match(input, /Preserve human constraints/);
      if (mode === 'local') {
        assert.match(input, /LOCAL WORK \/ NO-PR MODE/);
        assert.match(input, /Do not push, create\/edit a PR/);
        assert.doesNotMatch(input, /FULLY AUTONOMOUS mode/);
      } else if (mode === 'review') {
        assert.match(input, /LOCAL VERIFICATION ONLY/);
        assert.match(input, /Do not push, create\/edit a PR/);
        assert.doesNotMatch(input, /FULLY AUTONOMOUS mode/);
      } else {
        assert.doesNotMatch(input, /CURRENT EXECUTION MODE: LOCAL/);
      }
    });
  }
}
