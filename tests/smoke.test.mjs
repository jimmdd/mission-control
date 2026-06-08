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
