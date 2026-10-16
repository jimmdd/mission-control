import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys,json,tempfile,pathlib,hashlib,types,copy
sys.path.insert(0,${JSON.stringify(SWARM)})
import bridge,review_authorization,review_run
tid='met947'
context={'taskId':tid,'project':'GitProjects','repo':'backend','branch':'feature/MET-947-backend',
 'baseRef':'origin/master','recipients':['greptile','verified-codex'],
 'dataScope':'intended-committed-branch-code-diff','exclusions':['env-files','secrets','unrelated-private-data']}
grant={**context,'version':1,'status':'active','autonomousReruns':True,'approvalCheckpointId':'cp'}
decisions=[{'id':'cp','task_id':tid,'status':'approved','response':'Explicit private diff to Greptile, verified Codex; automatic reruns.'}]
task={'id':tid,'title':'MET-947','status':'in_progress','triage_state':{
 'execution_target':{'repos':[{'project':'GitProjects','repo':'backend','branch':context['branch'],'base_branch':'origin/master'}]},
 'review_authorization':grant}}
${code}
`], { encoding: "utf8", timeout: 20000 }));
}

test("MET-947 consent survives fix commits but cannot move to another recipient or data scope", () => {
  const result = python(`
out=[review_authorization.authorized(task,decisions)]
for field,value in [('taskId','other'),('repo','other'),('project','other'),('branch','other'),
 ('baseRef','origin/other'),('recipients',['another-service']),('dataScope','whole-worktree'),
 ('exclusions',[]),('status','revoked'),('autonomousReruns',False),('approvalCheckpointId','other')]:
 changed=copy.deepcopy(task);changed['triage_state']['review_authorization'][field]=value
 out.append(review_authorization.authorized(changed,decisions))
out += [review_authorization.authorized(task,[]),
 review_authorization.authorized(task,[{**decisions[0],'status':'pending'}]),
 review_authorization.authorized(task,[{**decisions[0],'status':'rejected'}]),
 review_authorization.authorized(task,[{**decisions[0],'task_id':'other'}]),
 review_authorization.authorized(task,decisions,{'branch':'other'})]
print(json.dumps(out))
`);
  assert.equal(result[0], true);
  assert.ok(result.slice(1).every(x => x === false), JSON.stringify(result));
});

test("new worker prompts carry scoped autonomous review instead of a three-round human checkpoint", () => {
  const result = python(`
prompt=bridge.generate_prompt(task,'ctx','GitProjects','backend',decisions=decisions)
wrong=bridge.generate_prompt(task,'ctx','GitProjects','other',decisions=decisions)
missing=bridge.generate_prompt(task,'ctx','GitProjects','backend',decisions=[])
print(json.dumps({'prompt':prompt,'wrong':wrong,'missing':missing}))
`);
  assert.match(result.prompt, /Continue investigate -> implement -> test -> review -> fix -> re-review automatically/);
  assert.match(result.prompt, /iteration count\s+alone must not create a human checkpoint/);
  assert.match(result.prompt, /zero Greptile findings, an explicit Codex PASS/);
  assert.match(result.prompt, /GSD verification/);
  assert.match(result.prompt, /grants no new publication permission/);
  assert.match(result.prompt, /Exclude env files, secrets and unrelated private data/);
  assert.doesNotMatch(result.prompt, /Maximum 3 review iterations/);
  for (const blocked of [result.wrong, result.missing]) {
    assert.doesNotMatch(blocked, /Recorded review authorization: checkpoint cp/);
    assert.match(blocked, /request that concrete permission/);
  }
});

test("bridge recovers finding -> fix -> re-review with consent; missing authority and holds still block", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);bridge.SWARM_DIR=root;wt=str(root/'worktree')
 entry={'id':'MET-947-backend','mcTaskId':tid,'status':'completed_by_agent','worktree':wt,'branch':context['branch'],'tmuxSession':'worker'}
 state={'head':'before-fix','base':'base','clean':True}
 path=root/'pr-review-state/runs'/hashlib.sha256(str(pathlib.Path(wt).resolve()).encode()).hexdigest()[:24]/'latest.json'
 path.parent.mkdir(parents=True)
 calls=[]
 bridge.fetch_tasks_by_status=lambda status:[task] if status=='in_progress' else []
 bridge._find_agent_registry_entry=lambda _:entry
 bridge._tmux_session_alive=lambda _:False
 bridge._has_pending_checkpoint=lambda _:False
 bridge._escalation_floor=lambda _:0
 bridge.resolved_decisions=lambda _:decisions
 bridge.mc_request=lambda *a:task
 bridge.mc_set_progress=lambda *a,**k:None
 bridge.subprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=0)
 bridge._relaunch_for_change_request=lambda t,text,source:calls.append({'source':source,'text':text}) or True
 review_run.snapshot=lambda *a:state
 def run(action,runid,human=False):
  path.write_text(json.dumps({'head':state['head'],'base':'base','baseRef':'origin/master',
   'endedAt':'2026-10-16T06:00:00Z','runId':runid,'nextAction':action,'humanRequired':human,'log':'retained.log'}))
  bridge.process_local_review_recovery()
 run('fix_code','finding')
 state['head']='fixed';run('resume_review','fixed')
 allowed=len(calls)
 run('fix_code','explicit-human-boundary',True);human_block=len(calls)==allowed
 run('request_specific_decision','missing-destination');decision_block=len(calls)==allowed
 task['triage_state'].pop('review_authorization');run('fix_code','without-consent');no_consent=len(calls)==allowed
 task['triage_state']['review_authorization']=grant
 revoked=copy.deepcopy(task);revoked['triage_state']['review_authorization']['status']='revoked'
 bridge.mc_request=lambda *a:revoked;run('fix_code','revoked-before-launch');revoked_block=len(calls)==allowed
 bridge.mc_request=lambda *a:task
 bridge._has_pending_checkpoint=lambda _:True;run('fix_code','pending');pending=len(calls)==allowed
 bridge._has_pending_checkpoint=lambda _:False;task['status']='on_hold'
 bridge.fetch_tasks_by_status=lambda status:[];run('fix_code','hold');held=len(calls)==allowed
 print(json.dumps({'calls':calls,'human_block':human_block,'decision_block':decision_block,'no_consent':no_consent,'revoked_block':revoked_block,'pending':pending,'held':held}))
`);
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[0].text, /requires fix_code/);
  assert.match(result.calls[1].text, /requires resume_review/);
  assert.ok(result.calls.every(x => x.source === "review-recovery"));
  for (const guard of ["human_block", "decision_block", "no_consent", "revoked_block", "pending", "held"]) assert.equal(result[guard], true, guard);
});

test("authorization and product decisions cannot be hidden by FAIL or an apparent PASS", () => {
  const result = python(`
print(json.dumps([review_run.classify(code,'VERDICT: '+verdict+'\\nREVIEW_REASON: '+reason)
 for code,verdict,reason in [(1,'FAIL','authorization'),(0,'PASS','authorization'),(1,'FAIL','product_decision')]]))
`);
  assert.ok(result.every(x => x.humanRequired && x.nextAction === "request_specific_decision"));
});
