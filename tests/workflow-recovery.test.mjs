import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
for name in ['reap_dead_agents','recover_interrupted_dispatches','process_open_questions','process_answered_followups','process_blocked_gates','process_planning_tasks','process_in_progress_plans','process_ticket_chat','process_followup_lifecycle','process_review_tasks','process_human_escalations']:
 setattr(bridge,name,lambda n=name:calls.append(n))
def broken():raise RuntimeError('bad planning dependency')
bridge.process_planning_tasks=broken
bridge.run_once()
print(json.dumps({'calls':calls,'errors':bridge.CYCLE_ERRORS}))
`);
 assert.ok(r.calls.includes('process_review_tasks'));
 assert.ok(r.calls.includes('objectives'));
 assert.ok(r.calls.indexOf('process_ticket_chat')<r.calls.indexOf('process_review_tasks'));
 assert.match(JSON.stringify(r.errors),/bad planning dependency/);
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
