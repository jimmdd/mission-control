import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  apiSupportsReadOnlyPreview,
  previewApiRunnerRoot,
  previewSessionNames,
  productionReaderDatabaseUrl,
  readOnlyApiLaunchSpec,
  renderPreviewFrontendEnv,
} from "../src/preview.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-"));
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, "apps", "new-api", "src"), { recursive: true });
  return { root, worktree, mcEnv: join(root, "mc.env") };
}

test("production preview accepts only explicitly named reader URLs", () => {
  const { root, worktree, mcEnv } = fixture();
  try {
    writeFileSync(
      join(worktree, ".env.prod"),
      "DATABASE_URL=postgres://writable\nDATABASE_WRITE_URL=postgres://primary\nSTAGING_PG_URL=postgres://staging\n",
    );
    assert.equal(productionReaderDatabaseUrl(worktree, {}, mcEnv), "");

    writeFileSync(join(worktree, ".env.prod"), "FRONTEND_READER_PG_URL=postgres://worktree-reader\n");
    assert.equal(productionReaderDatabaseUrl(worktree, {}, mcEnv), "",
      "an untrusted task branch cannot choose the production credential");

    writeFileSync(mcEnv, "MC_PREVIEW_PROD_READ_DATABASE_URL=postgres://settings-reader\n");
    assert.equal(productionReaderDatabaseUrl(worktree, {}, mcEnv), "postgres://settings-reader");
    assert.equal(
      productionReaderDatabaseUrl(
        worktree,
        { MC_PREVIEW_PROD_READ_DATABASE_URL: "postgres://runtime-reader" },
        mcEnv,
      ),
      "postgres://runtime-reader",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production preview API source comes only from trusted Mission Control config", () => {
  const { root, mcEnv } = fixture();
  try {
    assert.equal(previewApiRunnerRoot({}, mcEnv), "");
    writeFileSync(mcEnv, "MC_PREVIEW_API_RUNNER_ROOT=/trusted/backend\n");
    assert.equal(previewApiRunnerRoot({}, mcEnv), "/trusted/backend");
    assert.equal(
      previewApiRunnerRoot({ MC_PREVIEW_API_RUNNER_ROOT: "/runtime/backend" }, mcEnv),
      "/runtime/backend",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend and API tmux targets cannot prefix-match each other", () => {
  const names = previewSessionNames("MET-650");
  assert.equal(names.frontend, "mc-preview-ui-MET-650");
  assert.equal(names.api, "mc-preview-api-MET-650");
  assert.equal(names.frontend.startsWith(names.api), false);
  assert.equal(names.api.startsWith(names.frontend), false);
});

test("preview refuses API branches that do not implement the read-only contract", () => {
  const { root, worktree } = fixture();
  try {
    const args = join(worktree, "apps", "new-api", "src", "args.rs");
    writeFileSync(args, "pub struct Args { pub database_url: String }\n");
    assert.equal(apiSupportsReadOnlyPreview(worktree), false);

    writeFileSync(args, '#[arg(long, env = "API_READ_ONLY")]\npub read_only: bool,\n');
    assert.equal(apiSupportsReadOnlyPreview(worktree), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend preview env is pinned to the local API with cheats disabled", () => {
  const env = renderPreviewFrontendEnv(
    "PUBLIC_API_URL=https://api.metadao.fi\nPUBLIC_SHOW_CHEATS=true\n",
    "http://127.0.0.1:6642",
    "ws://127.0.0.1:7642/v1/ws",
  );
  assert.match(env, /^PUBLIC_API_URL=http:\/\/127\.0\.0\.1:6642$/m);
  assert.match(env, /^PUBLIC_WS_URL=ws:\/\/127\.0\.0\.1:7642\/v1\/ws$/m);
  assert.match(env, /^PUBLIC_SHOW_CHEATS=false$/m);
  assert.doesNotMatch(env, /https:\/\/api\.metadao\.fi/);
});

test("API launch spec keeps the reader URL out of the shell and strips side-effect credentials", () => {
  const databaseUrl = "postgres://reader:secret@example.invalid/prod";
  const spec = readOnlyApiLaunchSpec({
    databaseUrl,
    apiPort: 6642,
    wsPort: 7642,
    frontendPort: 5642,
    logFile: "/tmp/preview-api.log",
    authSecret: "local-only-auth-secret",
  });

  assert.equal(spec.environment.DATABASE_URL, databaseUrl);
  assert.equal(spec.environment.API_READ_ONLY, "true");
  assert.equal(spec.environment.API_MAX_DB_CONNECTIONS, "5");
  assert.equal(spec.environment.SQLX_OFFLINE, "true");
  assert.equal(spec.environment.AUTH_SECRET, "local-only-auth-secret");
  assert.equal(spec.environment.MC_PREVIEW_API_LOG, "/tmp/preview-api.log");
  assert.doesNotMatch(spec.command, /reader:secret/);
  assert.doesNotMatch(spec.command, /\/tmp\/preview-api\.log/);
  assert.match(spec.command, /unset DATABASE_WRITE_URL .*CLOUDFLARE_API_TOKEN.* TWILIO/);
  assert.match(spec.command, /NEWSLETTER_UNSUBSCRIBE_SECRET/);
  assert.match(spec.command, /--read-only --host 127\.0\.0\.1 --port 6642 --ws-port 7642/);
});
