import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionControlDB } from '../src/db.ts';
import { operationalHealth } from '../src/health.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const swarm = join(root, 'swarm');
function python(source) {
  return JSON.parse(execFileSync('python3', ['-c', `
import sys, json, importlib.util, tempfile, types
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(swarm)})
cf=types.ModuleType('context_fabrica_config')
cf.context_fabrica_dsn=lambda:''
cf.make_context_fabrica_adapter=lambda *a:None
sys.modules['context_fabrica_config']=cf
sys.modules['embeddings']=types.ModuleType('embeddings')
spec=importlib.util.spec_from_file_location('linear_sync', ${JSON.stringify(join(root,'integrations/linear/linear-sync.py'))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${source}
`], { encoding: 'utf8' }));
}

test('a poisoned ticket does not block later imports and successful receipts survive retry', () => {
  const result = python(`
state={'synced_issues':{}, 'last_sync':'old'}
m.setup_logging=m.load_env=m._apply_linear_env_overrides=lambda:None
m.verify_workspace=lambda:True
m.load_state=lambda:state
receipts=[]
m.save_state=lambda s:receipts.append(json.loads(json.dumps(s)))
m._check_research_results=lambda s:None
m.fetch_labeled_issues=lambda:[
 {'id':'bad','identifier':'MET-1','state':{'type':'canceled'}},
 {'id':'good','identifier':'MET-2','description':'works','state':{'type':'backlog'}}]
m.get_existing_mc_tasks=lambda:{'bad':{'id':'task-bad','status':'planning'}}
m.duplicate_of=lambda i:None
m.mc_request=lambda *a:(_ for _ in ()).throw(RuntimeError('schema mismatch'))
m.create_mc_task=lambda i:{'id':'task-good'}
first=m.sync()
first_state=json.loads(json.dumps(state))
m.mc_request=lambda *a:{}
second=m.sync()
print(json.dumps({'first':first,'second':second,'failed':first_state,'recovered':state,'receipts':len(receipts)}))
`);
  assert.equal(result.first, false);
  assert.equal(result.second, true);
  assert.equal(result.failed.last_sync, 'old');
  assert.equal(result.failed.failed_issues.bad.attempts, 1);
  assert.equal(result.failed.synced_issues.good.mc_task_id, 'task-good');
  assert.deepEqual(result.recovered.failed_issues, {});
  assert.notEqual(result.recovered.last_sync, 'old');
  assert.ok(result.receipts >= 8);
});

test('task and comment reconciliation consume every page and fail on incomplete reads', () => {
  const result = python(`
paths=[]
def page(method,path):
 paths.append(path)
 offset=int(path.split('offset=')[1])
 return [{'id':str(i),'external_id':'e'+str(i)} for i in range(offset,min(offset+100,208))]
m.mc_request=page
tasks=m.get_existing_mc_tasks()
cursors=[]
def comments(q,v):
 cursors.append(v['after'])
 return {'issue':{'comments':{'nodes':[{'id':'c'+str(len(cursors))}], 'pageInfo':{'hasNextPage':len(cursors)<3,'endCursor':str(len(cursors))}}}}
m.linear_query=comments
all_comments=m.fetch_issue_comments('issue')
m.mc_request=lambda *a:(_ for _ in ()).throw(RuntimeError('offline'))
failed=False
try:m.get_existing_mc_tasks()
except RuntimeError:failed=True
print(json.dumps({'count':len(tasks),'paths':paths,'comments':len(all_comments),'cursors':cursors,'failed':failed}))
`);
  assert.equal(result.count, 208);
  assert.deepEqual(result.paths.map(p => p.split('offset=')[1]), ['0','100','200']);
  assert.equal(result.comments, 3);
  assert.deepEqual(result.cursors, [null,'1','2']);
  assert.equal(result.failed, true);
});

test('health distinguishes a live server from stale sync, bridge, queue, and missing launch acknowledgements', () => {
  const home=mkdtempSync(join(tmpdir(),'mc-health-'));
  const db=new MissionControlDB(':memory:'); db.initSchema(); db.seedDefaults();
  const now=Date.now(); const old=new Date(now-3600_000).toISOString();
  const put=(path, data)=>{ mkdirSync(join(home,path,'..'),{recursive:true}); writeFileSync(join(home,path),JSON.stringify(data)); };
  try {
    put('sync/linear-state.json',{last_sync:old,last_error:'schema failure',failed_issues:{bad:{}}});
    put('bridge/health.json',{finished_at:old});
    put('swarm/active-tasks.json',[{status:'running',launchState:'starting',startedAt:now-3600_000}]);
    let result=operationalHealth(db,home,{now,uptime:3600,linearEnabled:true,bridgeEnabled:true});
    assert.equal(result.status,'degraded');
    for(const reason of ['linear_sync_failed','linear_sync_stale','bridge_stale','launch_acknowledgement_overdue','agent_heartbeat_stale']) assert.ok(result.reasons.includes(reason));
    put('sync/linear-state.json',{last_sync:new Date(now).toISOString(),failed_issues:{}});
    put('bridge/health.json',{finished_at:new Date(now).toISOString()});
    put('swarm/active-tasks.json',[]);
    result=operationalHealth(db,home,{now,uptime:3600,linearEnabled:true,bridgeEnabled:true});
    assert.equal(result.status,'ok');
  } finally { db.close(); rmSync(home,{recursive:true,force:true}); }
});

test('real launcher acknowledges before returning and adopts retries despite large prompts and failed optional history', () => {
  const tmux=spawnSync('which',['tmux'],{encoding:'utf8'}).stdout.trim();
  assert.ok(tmux,'tmux is needed for the launch boundary test');
  const home=mkdtempSync(join(tmpdir(),'mc-launch-'));
  const socket=`mc-audit-${process.pid}`;
  const repo=join(home,'repo'); const remote=join(home,'origin.git');
  const state=join(home,'swarm'); const bin=join(home,'.local','bin');
  for(const p of [repo,state,bin,join(state,'prompts'),join(state,'logs')]) mkdirSync(p,{recursive:true});
  const env={...process.env,HOME:home,MC_HOME:home,PATH:`${bin}:${process.env.PATH}`,MC_MEMORY_CEILING:'0.999',MISSION_CONTROL_URL:'http://127.0.0.1:1',MC_TASK_ID:'test-mc-id'};
  delete env.MC_LAUNCH_LOCK; delete env.MC_LAUNCH_LOCK_FD;
  const git=(...args)=>execFileSync('git',args,{cwd:repo,env,stdio:'pipe'});
  const run=()=>spawnSync('bash',[join(swarm,'spawn-agent.sh'),'audit-launch',repo,'feat/audit','codex'],{env,encoding:'utf8',timeout:30000});
  try {
    writeFileSync(join(bin,'tmux'),`#!/bin/sh\nexec '${tmux}' -L '${socket}' "$@"\n`,{mode:0o755});
    git('init','--bare',remote); git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Test');
    writeFileSync(join(repo,'README'),'fixture');git('add','.');git('commit','-m','fixture');git('remote','add','origin',remote);git('push','-u','origin','main');
    writeFileSync(join(state,'swarm-config.json'),JSON.stringify({agents:{profiles:{codex:{launcher:'codex',model:'stub',maxAgents:8}}}}));
    writeFileSync(join(state,'active-tasks.json'),'[]');
    writeFileSync(join(state,'prompts/audit-launch.md'),'x'.repeat(2_000_000));
    symlinkSync(join(swarm,'swarm-state.py'),join(state,'swarm-state.py'));
    writeFileSync(join(state,'run-codex.sh'),'#!/bin/bash\necho STUB_AGENT_RUNNING\nsleep 30\n',{mode:0o755});
    mkdirSync(join(state,'spawn-history.jsonl'));
    env.BASE_BRANCH='origin/main';
    const first=run(); assert.equal(first.status,0,first.stderr+'\n'+first.stdout);
    const entry=JSON.parse(readFileSync(join(state,'active-tasks.json')))[0];
    assert.equal(entry.launchState,'acknowledged');assert.ok(entry.launchAcknowledgedAt);
    const second=run(); assert.equal(second.status,0,second.stderr+'\n'+second.stdout);
    assert.match(second.stdout,/Adopted existing agent/);
    assert.equal(JSON.parse(readFileSync(join(state,'active-tasks.json')))[0].launchAttemptId,entry.launchAttemptId);
    execFileSync(tmux,['-L',socket,'set-option','-t',`=${entry.tmuxSession}:`,'remain-on-exit','on']);
    execFileSync(tmux,['-L',socket,'respawn-pane','-k','-t',`=${entry.tmuxSession}:`,'exit 0']);
    execFileSync(tmux,['-L',socket,'run-shell','sleep 0.1']);
    assert.equal(execFileSync(tmux,['-L',socket,'list-panes','-t',`=${entry.tmuxSession}:`,'-F','#{pane_dead}'],{encoding:'utf8'}).trim(),'1');
    writeFileSync(join(state,'active-tasks.json'),JSON.stringify([{...entry,status:'failed',lastError:'agent_session_lost'}]));
    const recovered=run();assert.equal(recovered.status,0,recovered.stderr+'\n'+recovered.stdout);
    const newEntry=JSON.parse(readFileSync(join(state,'active-tasks.json')))[0];
    assert.notEqual(newEntry.launchAttemptId,entry.launchAttemptId);
    assert.ok(newEntry.launchAcknowledgedAt);

  } finally { spawnSync(tmux,['-L',socket,'kill-server']); rmSync(home,{recursive:true,force:true}); }
});
