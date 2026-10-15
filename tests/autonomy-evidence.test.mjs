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

test("cancelling the helper reaps its detached reviewer before the deadline", () => {
  const result = python(`
import os,pathlib,signal,subprocess,tempfile,time
helper=pathlib.Path(${JSON.stringify(SWARM)})/'codex_review.py'
outcomes=[]
for cancellation in [signal.SIGTERM,signal.SIGHUP]:
 with tempfile.TemporaryDirectory(prefix='mc-review-cancel-') as temp:
  root=pathlib.Path(temp); ready=root/'ready'; survived=root/'survived'
  stub=root/'codex'
  stub.write_text('#!/usr/bin/env python3\\nimport os,pathlib,time\\n'
   +'pathlib.Path('+repr(str(ready))+').write_text(str(os.getpid()))\\n'
   +'time.sleep(1.2)\\npathlib.Path('+repr(str(survived))+').write_text("orphan")\\n'
   +'time.sleep(30)\\n')
  stub.chmod(0o755)
  process=subprocess.Popen([sys.executable,str(helper),str(root/'answer'),'--timeout','2'],
   stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,
   env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH']},start_new_session=True)
  child=None
  try:
   process.stdin.write(b'review');process.stdin.close()
   until=time.monotonic()+2
   while not ready.exists() and time.monotonic()<until: time.sleep(.01)
   assert ready.exists(),'fixture did not start'
   child=int(ready.read_text());os.kill(process.pid,cancellation)
   code=process.wait(timeout=2);time.sleep(1.3)
   outcomes.append({'code':code,'survived':survived.exists(),'result':(root/'answer').exists()})
  finally:
   if process.poll() is None: process.kill();process.wait()
   if child:
    try:os.killpg(child,signal.SIGKILL)
    except ProcessLookupError:pass
print(json.dumps(outcomes))
`);
  assert.deepEqual(result, [
    { code: 143, survived: false, result: false },
    { code: 129, survived: false, result: false },
  ]);
});
