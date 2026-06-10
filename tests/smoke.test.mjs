import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("CLI help documents knowledge diagnostics and GSD workflow commands", () => {
  const cli = read("src/cli.ts");
  assert.match(cli, /knowledge doctor/);
  assert.match(cli, /knowledge recall --query TEXT/);
  assert.match(cli, /knowledge reembed/);
  assert.match(cli, /tasks gsd/);
  assert.match(cli, /Dispatch through GSD workflow now/);
});

test("API routes expose knowledge diagnostics endpoints", () => {
  const routes = read("src/routes.ts");
  assert.match(routes, /segments\[1\] === "doctor"/);
  assert.match(routes, /segments\[1\] === "recall"/);
  assert.match(routes, /segments\[1\] === "reembed"/);
  assert.match(routes, /knowledgeScript, "recall"/);
});

test("knowledge management CLI registers diagnostic commands", () => {
  const script = read("swarm/knowledge-manage.py");
  assert.match(script, /def cmd_doctor/);
  assert.match(script, /def cmd_reembed/);
  assert.match(script, /def cmd_recall/);
  assert.match(script, /p_doctor = sub\.add_parser\("doctor"\)/);
  assert.match(script, /p_reembed = sub\.add_parser\("reembed"\)/);
  assert.match(script, /p_recall = sub\.add_parser\("recall"\)/);
});

test("dashboard exposes recall diagnostics and shared state", () => {
  const html = read("public/index.html");
  assert.match(html, /kb-recall-query/);
  assert.match(html, /runKnowledgeRecall/);
  assert.match(html, /SHARED/);
});

test("GSD Pi backend is explicit stub until adapter is implemented", () => {
  const backend = read("swarm/gsd_backend.py");
  assert.match(backend, /SUPPORTED_BACKENDS = \{"core", "pi"\}/);
  assert.match(backend, /reserved for the gsd-pi adapter/);
});

test("agent loop verifies planner acceptance criteria and handles review feedback", () => {
  const bridge = read("swarm/bridge.py");
  assert.match(bridge, /def _step_verification_criteria/);
  assert.match(bridge, /step\.get\("acceptance_criteria", step\.get\("done_when", \[\]\)\)/);
  assert.match(bridge, /if step_def and agent_output and criteria:/);
  assert.match(bridge, /process_review_tasks\(\)/);
  assert.match(bridge, /def _max_step_retries/);
  assert.doesNotMatch(bridge, /MAX_STEP_RETRIES = 2/);
});

test("server defaults are local and reject unauthenticated public binds", () => {
  const server = read("server.ts");
  assert.match(server, /const HOST = process\.env\.MC_HOST \?\? "127\.0\.0\.1"/);
  assert.match(server, /MISSION_CONTROL_ACCESS_TOKEN/);
  assert.match(server, /MISSION_CONTROL_READ_ACCESS_TOKEN/);
  assert.match(server, /MISSION_CONTROL_ALLOW_INSECURE_BIND/);
  assert.match(server, /without an access token/);
});

test("routes cap request size and terminate unknown routes", () => {
  const routes = read("src/routes.ts");
  assert.match(routes, /MAX_JSON_BODY_BYTES/);
  assert.match(routes, /Request body too large/);
  assert.match(routes, /timingSafeEqual/);
  assert.match(routes, /MISSION_CONTROL_AUTH_MODE/);
  assert.match(routes, /MISSION_CONTROL_WRITE_TOKEN/);
  assert.match(routes, /MISSION_CONTROL_ADMIN_TOKEN/);
  assert.match(routes, /res\.statusCode = 404/);
  assert.match(routes, /res\.end\("Not found"\)/);
});

test("bridge uses durable task leases for inbox dispatch", () => {
  const db = read("src/db.ts");
  const routes = read("src/routes.ts");
  const bridge = read("swarm/bridge.py");

  assert.match(db, /processing_owner TEXT/);
  assert.match(db, /processing_expires_at TEXT/);
  assert.match(db, /claimNextInboxTask/);
  assert.match(db, /releaseTaskLease/);
  assert.match(routes, /segments\[1\] === "claim"/);
  assert.match(routes, /segments\[2\] === "lease"/);
  assert.match(bridge, /\/api\/tasks\/claim/);
  assert.match(bridge, /release_task_lease\(task\["id"\]\)/);
});

test("critical destructive actions write audit events", () => {
  const routes = read("src/routes.ts");
  assert.match(routes, /type: "task_deleted"/);
  assert.match(routes, /type: "agent_deleted"/);
  assert.match(routes, /type: "workspace_deleted"/);
  assert.match(routes, /type: "knowledge_deleted"/);
});

test("service health checks runtime dependencies and knowledge readiness", () => {
  const health = read("health/service-health.py");
  assert.match(health, /def check_command/);
  assert.match(health, /def check_knowledge_doctor/);
  assert.match(health, /GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.match(health, /ANTHROPIC_API_KEY/);
  assert.match(health, /"tmux"/);
  assert.match(health, /"GitHub CLI"/);
});
