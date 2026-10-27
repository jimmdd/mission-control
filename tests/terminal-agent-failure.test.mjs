import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
const SWARM=fileURLToPath(new URL('../swarm',import.meta.url));
function run(code) { return JSON.parse(execFileSync('python3',['-c',`
import sys,json,tempfile
from pathlib import Path
sys.path.insert(0,${JSON.stringify(SWARM)})
import bridge
root=Path(tempfile.mkdtemp());bridge.SWARM_DIR=root
entry={"id":"worker","mcTaskId":"t","status":"failed","lastError":"authentication_required","launchAttemptId":"old"}
entries=[entry];events=[];checkpoints=[]
bridge._load_active_tasks=lambda:entries
bridge._tmux_session_alive=lambda session:False
bridge.mc_set_progress=lambda task_id,**kw:events.append(["progress",kw])
def request(method,path,body=None):
    if method=="GET" and path.endswith("/checkpoints"):return checkpoints
    if method=="GET":return {"id":"t","status":"in_progress"}
    events.append([method,path,body])
    if path.endswith("/checkpoints"):checkpoints.append({"status":"pending","prompt":body["prompt"]})
    return {}
bridge.mc_request=request
${code}`],{encoding:'utf8'})); }
test('terminal failure becomes blocked progress plus one actionable checkpoint without stopping runtimes',()=>{
 const r=run(`bridge.reconcile_failed_agents();bridge.reconcile_failed_agents();print(json.dumps(events))`);
 const posts=r.filter(x=>x[0]==='POST');assert.equal(posts.length,1);
 assert.equal(posts[0][2].pause,false);
 assert.match(posts[0][2].prompt,/authentication.*Reauthenticate.*explicitly choose/i);
 assert.equal(r.find(x=>x[0]==='progress')[1].state,'blocked');
 assert.ok(r.every(x=>!x[1]?.includes?.('triage-state')));
});
test('recovered runtimes, quota waits, held/terminal tasks and existing checkpoints are preserved',()=>{
 const r=run(`
results=[]
for mode in ['recovered','quota','held','done','pending','unknown_checkpoints']:
    entries[:]=[dict(entry)];events.clear();checkpoints.clear()
    bridge.mc_request=request
    if mode=='recovered':entries.append({"id":"recovered","mcTaskId":"t","status":"running"})
    if mode=='quota':entries[0]['status']='rate_limited'
    if mode in ['held','done']:
        bridge.mc_request=lambda method,path,body=None:{"status":"on_hold" if mode=='held' else 'done'}
    if mode=='pending':checkpoints.append({"status":"pending"})
    if mode=='unknown_checkpoints':bridge.mc_request=lambda *a,**kw:None
    bridge.reconcile_failed_agents();results.append(list(events))
print(json.dumps(results))`);
 assert.deepEqual(r,[[],[],[],[],[],[]]);
});
test('legacy exhausted auth logs are classified locally without copying log text or secrets',()=>{
 const r=run(`
entry['lastError']='exit_code_1'
(root/'logs').mkdir();(root/'logs/agent-worker.log').write_text('API Error: 401 OAuth token has expired; token=DO_NOT_LEAK')
bridge.reconcile_failed_agents();print(json.dumps(events))`);
 assert.match(r.find(x=>x[0]==='POST')[2].prompt,/authentication/);
 assert.doesNotMatch(JSON.stringify(r),/DO_NOT_LEAK|token=/);
});
test('stale terminal snapshots cannot block a newly recovered attempt',()=>{
 const r=run(`
calls=[0]
def load():
    calls[0]+=1
    return [entry] if calls[0]==1 else [{**entry,'status':'running','launchAttemptId':'new'}]
bridge._load_active_tasks=load
bridge.reconcile_failed_agents();print(json.dumps(events))`);
 assert.deepEqual(r,[]);
});


test('resolved questions do not reopen the same failure; later failures can ask again',()=>{
 const r=run(`
question=bridge._failed_agent_question(entry)
entry['failedAt']=1000
checkpoints.append({'status':'answered','prompt':question,'created_at':'2026-01-01T00:00:00Z'})
bridge.reconcile_failed_agents();same=list(events)
entry['failedAt']=2000000000000
bridge.reconcile_failed_agents()
print(json.dumps({'same':same,'later':events}))`);
 assert.deepEqual(r.same,[]);
 assert.equal(r.later.filter(x=>x[0]==='POST').length,1);
});
test('checkpoint transport failure leaves blocked progress and retries delivery without launching',()=>{
 const r=run(`
def unavailable(method,path,body=None):
    if method=='POST':raise OSError('offline')
    return request(method,path,body)
bridge.mc_request=unavailable
bridge.reconcile_failed_agents()
bridge.mc_request=request
bridge.reconcile_failed_agents();print(json.dumps(events))`);
 assert.equal(r.filter(x=>x[0]==='POST').length,1);
 assert.equal(r.filter(x=>x[0]==='progress').length,2);
});


test('matching pending failure question repairs a lost progress write without another checkpoint',()=>{
 const r=run(`
attempts=[0]
def progress(task_id,**kw):
    attempts[0]+=1
    if attempts[0]>1:events.append(['progress',kw])
bridge.mc_set_progress=progress
bridge.reconcile_failed_agents();bridge.reconcile_failed_agents()
print(json.dumps(events))`);
 assert.equal(r.filter(x=>x[0]==='POST').length,1);
 assert.equal(r.filter(x=>x[0]==='progress').length,1);
 assert.equal(r.find(x=>x[0]==='progress')[1].state,'blocked');
});


test('new exhausted attempts without failedAt are not suppressed by older answers',()=>{
 const r=run(`
entry.update(lastError='max_retries_exhausted',lastAttemptAt=2000000000000,launchAttemptId='new')
question=bridge._failed_agent_question(entry)
checkpoints.append({'status':'answered','prompt':question,'created_at':'2026-01-01T00:00:00Z'})
bridge.reconcile_failed_agents();print(json.dumps(events))`);
 assert.equal(r.filter(x=>x[0]==='POST').length,1);
});
test('terminal failures reconcile across coding providers, while old auth logs do not mislabel new attempts',()=>{
 const r=run(`
results=[]
for provider in ('claude','codex','pi'):
    events.clear();checkpoints.clear();entry.update(agentProfile=provider,lastError='runtime_crashed')
    bridge.reconcile_failed_agents();results.append([e for e in events if e[0]=='POST'])
(root/'logs').mkdir()
(root/'logs/agent-worker.log').write_text('=== Claude Agent starting: old\\nAPI Error: 401 OAuth token has expired\\n=== Codex Agent starting: new\\nprocess crashed')
entry['lastError']='exit_code_1'
print(json.dumps({'providers':results,'latest':bridge._failed_agent_question(entry)}))`);
 assert.ok(r.providers.every(posts=>posts.length===1));
 assert.doesNotMatch(r.latest,/authentication failed/);
});


test('older completed attempts do not hide the current provider failure',()=>{
 const r=run(`
entry.update(lastAttemptAt=2000000000000)
entries.insert(0,{'id':'older','mcTaskId':'t','status':'completed_by_agent','lastAttemptAt':1000})
bridge.reconcile_failed_agents();print(json.dumps(events))`);
 assert.equal(r.filter(x=>x[0]==='POST').length,1);
});
