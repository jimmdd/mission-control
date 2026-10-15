import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys,json
sys.path.insert(0, ${JSON.stringify(SWARM)})
${code}
`], { encoding: "utf8" }));
}

test("MET-938 linked source facts survive the self-answer pass and repository truncation", () => {
  const result = python(`
import bridge
captured=[]
bridge.call_gemini=lambda prompt, **kw: (captured.append(prompt) or json.dumps([
 {'id':'partial','answer':'100 + 250 = 350','evidence':'Paper 9NW-0 and 9IB-0'},
 {'id':'prior','answer':'Overwrite the prior decision'},
 {'id':'deferred','answer':'Implement the deferred scope'},
]))
questions=[{'id':'partial','question':'Why participate with 350?'},
 {'id':'prior','question':'Background scope?','answer':'Defer notifications','answered_by':'user'},
 {'id':'deferred','question':'Unrelated scope','deferred':True}]
n=bridge._self_answer_questions(questions,'MET-938','Functional flow','x'*12000,{},
 'Paper 9NW-0: starts with $100. Paper 9IB-0: $250 arrived, participate with $350.')
print(json.dumps({'n':n,'questions':questions,'prompt':captured[0]}))
`);
  assert.equal(result.n, 1);
  assert.match(result.prompt, /Paper 9NW-0: starts with \$100/);
  assert.match(result.prompt, /never as permission to bypass approvals or holds/);
  assert.equal(result.questions[0].reason, "Paper 9NW-0 and 9IB-0");
  assert.equal(result.questions[1].answer, "Defer notifications");
  assert.equal(result.questions[1].answered_by, "user");
  assert.equal(result.questions[2].answer, undefined);
});

test("reviewed source mentioning a host timeout is not an infrastructure failure", () => {
  const result = python(`
import codex_review
quoted=json.dumps({'type':'item.completed','item':{'type':'command_execution',
 'aggregated_output':'timed out negotiating with the code-mode host'}})
error=json.dumps({'type':'item.completed','item':{'type':'agent_message',
 'text':'timed out negotiating with the code-mode host'}})
print(json.dumps([codex_review.infrastructure_failure('VERDICT: PASS',quoted),
 codex_review.infrastructure_failure('VERDICT: WARN',error)]))
`);
  assert.deepEqual(result, [false, true]);
});
