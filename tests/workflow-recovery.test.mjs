import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const swarm=fileURLToPath(new URL('../swarm',import.meta.url));
const python=source=>JSON.parse(execFileSync('python3',['-c',`
import sys,json,time
sys.path.insert(0,${JSON.stringify(swarm)})
import bridge
${source}
`],{encoding:'utf8'}));

test('a failed bridge stage leaves later ticket work running and records the failure',()=>{
 const r=python(`
import types
calls=[]
sys.modules['autopilot']=types.SimpleNamespace(process_objectives=lambda:calls.append('objectives'))
bridge.fetch_next_task=lambda:None
for name in ['reap_dead_agents','process_local_review_recovery','recover_interrupted_dispatches','process_open_questions','process_answered_followups','process_blocked_gates','process_planning_tasks','process_in_progress_plans','process_ticket_chat','process_followup_lifecycle','process_review_tasks','process_human_escalations']:
 setattr(bridge,name,lambda n=name:calls.append(n))
def broken():raise RuntimeError('bad planning dependency')
bridge.process_planning_tasks=broken
bridge.run_once()
print(json.dumps({'calls':calls,'errors':bridge.CYCLE_ERRORS}))
`);
 assert.ok(r.calls.includes('process_review_tasks'));
 assert.ok(r.calls.includes('objectives'));
 assert.ok(r.calls.indexOf('process_ticket_chat')<r.calls.indexOf('process_review_tasks'));
 assert.ok(r.calls.indexOf('process_local_review_recovery')<r.calls.indexOf('process_human_escalations'));
 assert.match(JSON.stringify(r.errors),/bad planning dependency/);
});

test('MET-939 technical review gaps resume once while holds, active workers and decisions stay stopped',()=>{
 const r=python(`
import tempfile,pathlib,hashlib
import review_run
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);bridge.SWARM_DIR=root
 ids=['qa','lanes','infra','lost-review','held','running','pending','auth','stale','repeated','exhausted','held-race']
 tasks=[{'id':n,'status':'review'} for n in ids if n!='held']
 entries={n:{'id':n,'worktree':str(root/n),'status':'running' if n=='running' else 'completed_by_agent','tmuxSession':n} for n in ids}
 entries['lost-review'].update(status='running',reviewOnly=True)
 actions={'qa':'complete_local_qa','lanes':'complete_independent_review','infra':'bounded_readonly_diagnosis','lost-review':'resume_review','auth':'request_specific_decision'}
 for n in ids:
  key=hashlib.sha256(str((root/n).resolve()).encode()).hexdigest()[:24];p=root/'pr-review-state/runs'/key/'latest.json';p.parent.mkdir(parents=True)
  p.write_text(json.dumps({'runId':n,'head':'old' if n=='stale' else 'head','base':'base','baseRef':'origin/master','endedAt':'2026-10-15T20:35:24Z','nextAction':actions.get(n,'complete_local_qa'),'log':'local.log'}))
 entries['repeated']['reviewRecovery']={'lastRunId':'repeated'}
 entries['exhausted']['reviewRecovery']={'head':'head','base':'base','attempts':2}
 bridge.fetch_tasks_by_status=lambda status:tasks if status=='review' else []
 bridge._find_agent_registry_entry=lambda tid:entries[tid]
 bridge._tmux_session_alive=lambda _:False
 bridge._has_pending_checkpoint=lambda tid:tid=='pending'
 bridge._escalation_floor=lambda _:0
 review_run.snapshot=lambda *a:{'head':'head','base':'base','clean':True}
 bridge.subprocess.run=lambda *a,**k:SimpleNamespace(returncode=0)
 bridge.mc_request=lambda method,path:{'id':path.split('/')[-1],'status':'on_hold' if path.endswith('held-race') else 'review'}
 resumed=[];blocked=[]
 bridge._relaunch_for_change_request=lambda task,text,source:resumed.append([task['id'],source,text]) or True
 bridge.mc_set_progress=lambda tid,**k:blocked.append([tid,k])
 bridge.mc_log_activity=lambda *a,**k:None
 bridge.process_local_review_recovery()
 print(json.dumps({'resumed':resumed,'blocked':blocked}))
`);
 assert.deepEqual(r.resumed.map(x=>x[0]),['qa','lanes','infra','lost-review']);
 assert.ok(r.resumed.every(x=>x[1]==='review-recovery' && x[2].includes('not publication approval')));
 assert.deepEqual(r.blocked.map(x=>x[0]),['exhausted']);
 assert.match(r.blocked[0][1].blocked_reason,/technical failure/);
});

test('automatic review recovery preserves prior decisions, never kills a live worker, and reports review progress',()=>{
 const r=python(`
import tempfile,pathlib
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);bridge.SWARM_DIR=root;(root/'prompts').mkdir();work=root/'work';work.mkdir()
 entry={'id':'MET-939','mcTaskId':'task','status':'completed_by_agent','worktree':str(work),'tmuxSession':'task-session','agent':'claude'}
 (root/'active-tasks.json').write_text(json.dumps([entry]));(root/'prompts/MET-939-change-request.md').write_text('User decision: do not publish. Preserve reviewed card assets.')
 bridge._has_pending_checkpoint=lambda _:False;bridge._tmux_session_alive=lambda _:False
 bridge.mc_request=lambda *a:{'id':'task','status':'review'}
 calls=[];progress=[]
 bridge.subprocess.run=lambda args,**k:calls.append(args) or SimpleNamespace(returncode=0,stdout='',stderr='')
 bridge.mc_update_task=lambda *a:None;bridge.mc_log_activity=lambda *a,**k:None;bridge.mc_set_progress=lambda *a,**k:progress.append(k)
 ok=bridge._relaunch_for_change_request({'id':'task'},'Complete current-head QA',source='review-recovery')
 prompt=(root/'prompts/MET-939-change-request.md').read_text()
 bridge._tmux_session_alive=lambda _:True
 blocked=bridge._relaunch_for_change_request({'id':'task'},'again',source='review-recovery')
 print(json.dumps({'ok':ok,'blocked':blocked,'prompt':prompt,'calls':calls,'progress':progress}))
`);
 assert.equal(r.ok,true);assert.equal(r.blocked,false);
 assert.match(r.prompt,/User decision: do not publish/);assert.match(r.prompt,/NO-PR MODE/);
 assert.ok(!r.calls.some(x=>x.includes('kill-session')));
 assert.equal(r.progress[0].phase,'review');assert.match(r.progress[0].step_label,/recoverable local review gaps/);
});

test('a Hold arriving during review recovery launch wins the shared registry transition',()=>{
 const r=python(`
import tempfile,pathlib,threading,fcntl
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);bridge.SWARM_DIR=root;(root/'prompts').mkdir();work=root/'work';work.mkdir()
 entry={'id':'MET-939','mcTaskId':'task','status':'completed_by_agent','worktree':str(work),'tmuxSession':'task-session','agent':'claude'}
 registry=root/'active-tasks.json';registry.write_text(json.dumps([entry]));(root/'prompts/MET-939-change-request.md').write_text('Review only; do not publish.')
 bridge._has_pending_checkpoint=lambda _:False;bridge._tmux_session_alive=lambda _:False
 bridge.mc_request=lambda *a:{'id':'task','status':'review'}
 attempted=threading.Event();threads=[];promoted=[]
 def hold():
  with (root/'active-tasks.lock').open('a+') as lock:
   attempted.set();fcntl.flock(lock.fileno(),fcntl.LOCK_EX)
   rows=json.loads(registry.read_text());rows[0]['status']='paused';registry.write_text(json.dumps(rows))
 def launch(args,**kw):
  if 'new-session' in args:
   t=threading.Thread(target=hold);threads.append(t);t.start();assert attempted.wait(1)
  return SimpleNamespace(returncode=0,stdout='',stderr='')
 bridge.subprocess.run=launch;bridge.mc_update_task=lambda *a:promoted.append(a)
 bridge.mc_set_progress=lambda *a,**k:None;bridge.mc_log_activity=lambda *a,**k:None
 ok=bridge._relaunch_for_change_request({'id':'task'},'Complete local QA',source='review-recovery')
 for t in threads:t.join(3);assert not t.is_alive()
 print(json.dumps({'ok':ok,'registry':json.loads(registry.read_text())[0]['status'],'promotions':promoted}))
`);
 assert.equal(r.ok,true);assert.equal(r.registry,'paused');assert.deepEqual(r.promotions,[]);
});

test('a failed technical recovery launch can retry boundedly instead of consuming its outcome',()=>{
 const r=python(`
import tempfile,pathlib,hashlib
import review_run
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);bridge.SWARM_DIR=root;work=root/'work';work.mkdir()
 task={'id':'task','status':'review'};entry={'id':'MET-939','worktree':str(work),'status':'completed_by_agent','tmuxSession':'session'}
 key=hashlib.sha256(str(work.resolve()).encode()).hexdigest()[:24];p=root/'pr-review-state/runs'/key/'latest.json';p.parent.mkdir(parents=True)
 p.write_text(json.dumps({'runId':'review1','head':'head','base':'base','baseRef':'origin/master','endedAt':'2026-10-15T20:35:24Z','nextAction':'complete_local_qa','log':'review.log'}))
 bridge.fetch_tasks_by_status=lambda status:[task] if status=='review' else []
 bridge._find_agent_registry_entry=lambda _:entry;bridge._tmux_session_alive=lambda _:False;bridge._has_pending_checkpoint=lambda _:False;bridge._escalation_floor=lambda _:0
 review_run.snapshot=lambda *a:{'head':'head','base':'base','clean':True}
 def save(args,**kw):
  if '--patch-json' in args:entry.update(json.loads(args[args.index('--patch-json')+1]))
  return SimpleNamespace(returncode=0)
 bridge.subprocess.run=save;bridge.mc_request=lambda *a:task
 launches=[]
 def launch(*a,**k):launches.append('attempt');return len(launches)>1
 bridge._relaunch_for_change_request=launch;bridge.mc_log_activity=lambda *a,**k:None;bridge.mc_set_progress=lambda *a,**k:None
 bridge.process_local_review_recovery();after_failure=dict(entry['reviewRecovery'])
 bridge.process_local_review_recovery();bridge.process_local_review_recovery()
 print(json.dumps({'launches':len(launches),'after_failure':after_failure,'after_success':entry['reviewRecovery']}))
`);
 assert.equal(r.launches,2);assert.equal(r.after_failure.lastRunId,undefined);
 assert.equal(r.after_success.lastRunId,'review1');assert.equal(r.after_success.attempts,2);
});

test('an ordered bridge cycle preserves local recovery against existing PR conflicts and failed CI',()=>{
 const r=python(`
import tempfile,pathlib,hashlib,types,review_run
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);bridge.SWARM_DIR=root;work=root/'work';work.mkdir()
 task={'id':'task','title':'[MET-939] Local recovery','external_id':'MET-939','status':'review'}
 entry={'id':'MET-939','mcTaskId':'task','worktree':str(work),'status':'completed_by_agent','tmuxSession':'session','agentEnv':{'MC_MAX_FAILOVER_DEPTH':'0'}}
 registry=root/'active-tasks.json';registry.write_text(json.dumps([entry]))
 key=hashlib.sha256(str(work.resolve()).encode()).hexdigest()[:24];out=root/'pr-review-state/runs'/key/'latest.json';out.parent.mkdir(parents=True)
 out.write_text(json.dumps({'runId':'review1','head':'head','base':'base','baseRef':'origin/master','endedAt':'2026-10-15T20:35:24Z','nextAction':'complete_local_qa','log':'review.log'}))
 bridge._REVIEW_MONITOR_FILE=root/'monitor.json'
 bridge.fetch_tasks_by_status=lambda status:[task] if status=='review' else []
 bridge.fetch_next_task=lambda:None;bridge._has_pending_checkpoint=lambda _:False;bridge._escalation_floor=lambda _:0
 live=[];commands=[];feedback=[];metadata=[]
 bridge._tmux_session_alive=lambda _:bool(live)
 review_run.snapshot=lambda *a:{'head':'head','base':'base','clean':True}
 def run(args,**kw):
  if '--patch-json' in args:
   rows=json.loads(registry.read_text());rows[0].update(json.loads(args[args.index('--patch-json')+1]));registry.write_text(json.dumps(rows))
  elif args[:2]==['tmux','new-session']:commands.append(args);live.append(True)
  elif args[:2]==['tmux','kill-session']:commands.append(args)
  elif 'pr' in args:commands.append(args)
  return SimpleNamespace(returncode=0,stdout=json.dumps({'title':'Missing ticket prefix'}),stderr='')
 bridge.subprocess.run=run
 bridge.mc_request=lambda method,path:([{'deliverable_type':'pr','path':'https://github.com/acme/app/pull/1'}] if path.endswith('/deliverables') else task)
 bridge.mc_set_progress=lambda *a,**k:None;bridge.mc_log_activity=lambda *a,**k:None
 bridge._check_pr_status_for_task=lambda _:False
 bridge._collect_dashboard_feedback=lambda _:feedback.append('consumed') or 'push fix'
 bridge._gh_pr_meta=lambda _:metadata.append('consumed') or {'state':'OPEN','headRefOid':'head','mergeable':'CONFLICTING','statusCheckRollup':[{'conclusion':'FAILURE'}]}
 sys.modules['autopilot']=types.SimpleNamespace(process_objectives=lambda:None)
 for name in ['reap_dead_agents','recover_interrupted_dispatches','process_open_questions','process_answered_followups','process_blocked_gates','process_planning_tasks','process_in_progress_plans','process_ticket_chat','process_followup_lifecycle','process_human_escalations']:setattr(bridge,name,lambda:None)
 bridge.run_once()
 bridge._capture_pr_for_task(task)
 rows=json.loads(registry.read_text());rows[0]['status']='completed_by_agent';registry.write_text(json.dumps(rows));live.clear()
 monitored=bridge._auto_review_monitor(task)
 overwritten=bridge._relaunch_for_change_request(task,'CI failed; push a fix',source='auto-monitor')
 print(json.dumps({'entry':rows[0],'commands':commands,'feedback':feedback,'metadata':metadata,'monitorExists':bridge._REVIEW_MONITOR_FILE.exists(),'monitored':monitored,'overwritten':overwritten}))
`);
 assert.equal(r.commands.length,1);assert.equal(r.commands[0][1],'new-session');
 assert.deepEqual(r.feedback,[]);assert.deepEqual(r.metadata,[]);assert.equal(r.monitorExists,false);
 assert.equal(r.monitored,false);assert.equal(r.overwritten,false);
 assert.equal(r.entry.reviewOnly,true);assert.equal(r.entry.agentEnv.MC_REVIEW_ONLY,'1');
 assert.equal(r.entry.agentEnv.MC_MAX_FAILOVER_DEPTH,'0');
 assert.match(r.entry.agentEnv.PROMPT_OVERRIDE,/MET-939-change-request\.md$/);
});

test('a lost owned recovery continues once before a new gate, while ordinary handback and the cap remain deduplicated',()=>{
 const r=python(`
import tempfile,pathlib,hashlib,review_run
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
results=[]
for loss in ['running','reaped']:
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);bridge.SWARM_DIR=root;work=root/'work';work.mkdir()
  task={'id':'task','status':'review'};entry={'id':'MET-939','mcTaskId':'task','worktree':str(work),'status':'completed_by_agent','tmuxSession':'session'}
  registry=root/'active-tasks.json';registry.write_text(json.dumps([entry]))
  key=hashlib.sha256(str(work.resolve()).encode()).hexdigest()[:24];p=root/'pr-review-state/runs'/key/'latest.json';p.parent.mkdir(parents=True)
  ended=datetime.now(timezone.utc)-timedelta(minutes=1)
  p.write_text(json.dumps({'runId':'review1','head':'head','base':'base','baseRef':'origin/master','endedAt':ended.isoformat(),'nextAction':'complete_local_qa','log':'review.log'}))
  bridge.fetch_tasks_by_status=lambda status:[task] if status=='review' else []
  bridge._has_pending_checkpoint=lambda _:False;bridge.mc_request=lambda *a:task
  live=[];launches=[];blocked=[]
  bridge._tmux_session_alive=lambda _:bool(live)
  review_run.snapshot=lambda *a:{'head':'head','base':'base','clean':True}
  def run(args,**kw):
   if '--patch-json' in args:
    rows=json.loads(registry.read_text());rows[0].update(json.loads(args[args.index('--patch-json')+1]));registry.write_text(json.dumps(rows))
   elif args[:2]==['tmux','new-session']:launches.append(args);live.append(True)
   return SimpleNamespace(returncode=0,stdout='',stderr='')
  bridge.subprocess.run=run;bridge.mc_log_activity=lambda *a,**k:None;bridge.mc_set_progress=lambda *a,**k:blocked.append(k)
  bridge.process_local_review_recovery();after_first=len(launches);floor_newer=bridge._escalation_floor('task')>ended.timestamp()
  live.clear();rows=json.loads(registry.read_text());rows[0]['status']='completed_by_agent';registry.write_text(json.dumps(rows))
  bridge.process_local_review_recovery();after_handback=len(launches)
  rows[0].update(status='failed' if loss=='reaped' else 'running',lastError='agent_session_lost' if loss=='reaped' else None);registry.write_text(json.dumps(rows))
  bridge.process_local_review_recovery();after_lost=len(launches)
  live.clear();bridge.process_local_review_recovery()
  results.append({'first':after_first,'handback':after_handback,'lost':after_lost,'final':len(launches),'floor_newer':floor_newer,'attempts':json.loads(registry.read_text())[0]['reviewRecovery']['attempts'],'capped':any('exhausted' in x.get('blocked_reason','') for x in blocked)})
print(json.dumps(results))
`);
 assert.deepEqual(r,[0,1].map(()=>({first:1,handback:1,lost:2,final:2,floor_newer:true,attempts:2,capped:true})));
});

test('the shell monitor defers local-only respawn to the locked owner, including a concurrent Hold',()=>{
 const root=mkdtempSync(join(tmpdir(),'mc-local-review-monitor-'));
 try {
  const registry=join(root,'registry.json'),calls=join(root,'calls');
  const source=readFileSync(join(swarm,'check-agents.sh'),'utf8');
  const builder=source.slice(source.indexOf('build_agent_env_exports() {'),source.indexOf('resolve_launcher_path() {'));
  const reconcile=source.slice(source.indexOf('reconcile_completed_agents_to_mc() {'),source.indexOf('mc_post_activity() {'));
  const loop=source.slice(source.indexOf('RUNNING_IDS='));
  for(const scenario of ['completed','live','dead','hold-race']) {
   writeFileSync(calls,'');
   writeFileSync(registry,JSON.stringify([{id:'local',mcTaskId:'task',status:scenario==='completed'?'completed_by_agent':'running',reviewOnly:true,
    agent:'claude',launcher:'claude',tmuxSession:'local-session',worktree:root,repo:root,branch:'feature/local',startedAt:1,
    agentEnv:{MC_REVIEW_ONLY:'1',PROMPT_OVERRIDE:join(root,'review-only.md')}}]));
   const program=`
REGISTRY=${JSON.stringify(registry)}
LOG=${JSON.stringify(join(root,'log'))}
SWARM_DIR=${JSON.stringify(root)}
TIMESTAMP=fixture
SCENARIO=${scenario}
state_update(){ echo "state:$*" >> ${JSON.stringify(calls)}; }
mc_curl(){ echo '{"status":"review","task_type":"implementation"}'; }
mc_post_activity(){ :; }
mc_complete_task(){ echo unexpected-completion >> ${JSON.stringify(calls)}; }
log_health_check(){
 if [ "$SCENARIO" = hold-race ]; then
  jq 'map(.status="paused")' "$REGISTRY" > "$REGISTRY.next"
  mv "$REGISTRY.next" "$REGISTRY"
 fi
}
resolve_launcher_path(){ echo /fixture/run-claude.sh; }
gh(){ echo unexpected-github >> ${JSON.stringify(calls)}; }
tmux(){
 if [ "$1" = has-session ]; then [ "$SCENARIO" = live ];
 else echo "tmux:$*" >> ${JSON.stringify(calls)}; fi
}
${builder}
${reconcile}
reconcile_completed_agents_to_mc
${loop}`;
   execFileSync('bash',['-c',program],{encoding:'utf8'});
   const output=readFileSync(calls,'utf8');
   assert.doesNotMatch(output,/unexpected-|kill-session/,scenario);
   assert.doesNotMatch(output,/tmux:|dead-session-respawn/,scenario);
   if(scenario==='hold-race') assert.equal(JSON.parse(readFileSync(registry,'utf8'))[0].status,'paused');
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('epoch-millisecond heartbeats retain the startup grace and a dead attempt keeps resume metadata',()=>{
 const r=python(`
from types import SimpleNamespace
entries=[{'id':'new','status':'running','startedAt':int(time.time()*1000)},
 {'id':'old','status':'running','startedAt':int((time.time()-3600)*1000),'repo':'/repo','worktree':'/work','branch':'feat/x'}]
bridge._load_active_tasks=lambda:entries
bridge._tmux_session_alive=lambda _:False
calls=[]
bridge.subprocess.run=lambda args,**k:calls.append(args) or SimpleNamespace(returncode=0)
print(json.dumps({'count':bridge.reap_dead_agents(),'calls':calls}))
`);
 assert.equal(r.count,1);
 const args=r.calls[0];assert.ok(args.includes('update'));assert.ok(!args.includes('remove'));
 assert.equal(args[args.indexOf('--task-id')+1],'old');
 assert.equal(JSON.parse(args[args.indexOf('--patch-json')+1]).status,'failed');
});

test('stale dispatches resume planning without discarding decisions; live leases and checkpoints wait',()=>{
 const r=python(`
from datetime import datetime,timezone,timedelta
old=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
future=(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()
tasks=[{'id':n,'status':'assigned','updated_at':old,'triage_state':{'questions':[{'answer':'already decided'}]}} for n in ['orphan','leased','held']]
tasks[1]['processing_expires_at']=future
bridge.fetch_tasks_by_status=lambda status:tasks if status=='assigned' else []
bridge._find_agent_registry_entry=lambda _:None
changes=[]
def request(method,path,body=None):
 if path.endswith('/checkpoints'):return [{'status':'pending'}] if 'held' in path else []
 return next(t for t in tasks if path.endswith('/'+t['id']))
bridge.mc_request=request
bridge.mc_update_task=lambda tid,patch:changes.append([tid,patch])
bridge.mc_log_activity=lambda *a,**k:None
bridge.recover_interrupted_dispatches()
print(json.dumps(changes))
`);
 assert.deepEqual(r,[['orphan',{status:'planning'}]]);
});

test('status queues paginate beyond 100 and report unavailable pages instead of pretending to be empty',()=>{
 const r=python(`
from urllib.parse import urlparse,parse_qs
paths=[]
def get(method,path):
 paths.append(path);offset=int(parse_qs(urlparse(path).query).get('offset',['0'])[0])
 return [{'id':str(i)} for i in range(offset,min(offset+100,205))]
bridge.mc_request=get
items=bridge.fetch_tasks_by_status('planning')
bridge.mc_request=lambda *a:(_ for _ in ()).throw(RuntimeError('unavailable'))
failed=False
try:bridge.fetch_tasks_by_status('review')
except RuntimeError:failed=True
print(json.dumps({'count':len(items),'pages':len(paths),'failed':failed}))
`);
 assert.deepEqual(r,{count:205,pages:3,failed:true});
});

test('transient launch failures retry quietly and a resolved checkpoint starts a fresh retry budget',()=>{
 const r=python(`
acts=[]; posts=[]
bridge.fetch_task_activities=lambda _:acts
bridge.mc_update_task=lambda *a:None
bridge.mc_log_activity=lambda *a:None
bridge.mc_request=lambda method,path,body=None:posts.append(body) if method=='POST' else []
bridge._handle_spawn_failure('task','implementation')
first=len(posts)
acts=[{'message':'Agent spawn failed','created_at':'2026-09-01T00:00:00Z'}]*2
bridge._handle_spawn_failure('task','implementation')
third=len(posts)
acts.append({'activity_type':'checkpoint_resolved','created_at':'2026-09-02T00:00:00Z'})
bridge._handle_spawn_failure('task','implementation')
print(json.dumps([first,third,len(posts)]))
`);
 assert.deepEqual(r,[0,1,1]);
});

test('lost single-agent executions retry while active plans retain their step-level recovery',()=>{
 const r=python(`
from datetime import datetime,timezone,timedelta
old=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
tasks=[{'id':n,'status':'in_progress','updated_at':old} for n in ['lost','planned','other']]
bridge.fetch_tasks_by_status=lambda status:tasks if status=='in_progress' else []
bridge._find_agent_registry_entry=lambda tid:{'status':'failed','lastError':'agent_session_lost' if tid!='other' else 'other'}
bridge.load_progress=lambda tid:{'status':'in_progress'} if tid=='planned' else None
bridge._tmux_session_alive=lambda _:False
bridge.mc_request=lambda method,path,body=None:[] if path.endswith('/checkpoints') else next(t for t in tasks if path.endswith('/'+t['id']))
retries=[]
bridge._handle_spawn_failure=lambda tid,what:retries.append(tid)
bridge.mc_update_task=lambda *a:None
bridge.mc_log_activity=lambda *a:None
bridge.recover_interrupted_dispatches()
print(json.dumps(retries))
`);
 assert.deepEqual(r,['lost']);
});
