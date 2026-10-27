import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {MissionControlDB} from '../src/db.ts';
import {createHandler} from '../src/routes.ts';
import {McEventBus} from '../src/events.ts';
const root=fileURLToPath(new URL('..',import.meta.url));
test('an open draft awaiting CI cannot overwrite blocked progress with done',async()=>{
 const db=new MissionControlDB(':memory:');db.initSchema();db.seedDefaults();
 try{
 const task=db.createTask({title:'draft delivery',status:'in_progress'});
 db.createDeliverable({task_id:task.id,deliverable_type:'pr',title:'Draft PR',path:'https://github.com/acme/repo/pull/1'});
 db.upsertProgress(task.id,{state:'blocked',phase:'verify',blocked_reason:'Current-head wallet CI failed'});
 const handler=createHandler(db,{info(){},error(){}},new McEventBus(),{checkPrReadiness:async()=>({status:'ci_failed',reason:'wallet CI failed'})});
 async function request(url,body){const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method:'POST',headers:{host:'localhost'}});const res={statusCode:200,body:'',setHeader(){},writeHead(c){this.statusCode=c},end(b){this.body=b||''}};await handler(req,res);return res;}
 const claim=await request(`/api/tasks/${task.id}/progress`,{state:'done',blocked_reason:''});
 assert.equal(claim.statusCode,409);assert.equal(db.getProgress(task.id).state,'blocked');
 const completion=await request('/api/webhooks/agent-completion',{task_id:task.id,status:'review'});
 assert.equal(completion.statusCode,409);assert.equal(db.getTask(task.id).status,'testing');
 assert.equal(db.getProgress(task.id).blocked_reason,'Current-head wallet CI failed');
 assert.equal((await request(`/api/tasks/${task.id}/progress`,{state:'done'})).statusCode,409);
 assert.equal(db.listDeliverables(task.id).length,1);
 db.updateTask(task.id,{status:'on_hold'});
 const req=Readable.from([Buffer.from(JSON.stringify({status:'testing',expected_status:'in_progress'}))]);Object.assign(req,{url:`/api/tasks/${task.id}`,method:'PATCH',headers:{host:'localhost'}});
 const res={statusCode:200,setHeader(){},writeHead(c){this.statusCode=c},end(){}};await handler(req,res);
 assert.equal(res.statusCode,409);assert.equal(db.getTask(task.id).status,'on_hold');
 const stale=Readable.from([Buffer.from(JSON.stringify({status:'testing',expected_updated_at:'stale'}))]);Object.assign(stale,{url:`/api/tasks/${task.id}`,method:'PATCH',headers:{host:'localhost'}});
 const out={statusCode:200,setHeader(){},writeHead(c){this.statusCode=c},end(){}};await handler(stale,out);assert.equal(out.statusCode,409);
 db.updateTask(task.id,{status:'review'});
 const delayed=Readable.from((async function*(){db.updateTask(task.id,{status:'testing'});yield Buffer.from(JSON.stringify({state:'done'}));})());
 Object.assign(delayed,{url:`/api/tasks/${task.id}/progress`,method:'PUT',headers:{host:'localhost'}});
 const delayedOut={statusCode:200,setHeader(){},writeHead(c){this.statusCode=c},end(){}};await handler(delayed,delayedOut);assert.equal(delayedOut.statusCode,409);

 }finally{db.close();}
});
test('unknown or operator-owned holds are preserved; only a current Linear-mirrored hold can restore',()=>{
 const script=`import importlib.util,sys,types,json
m=types.ModuleType('context_fabrica_config');m.context_fabrica_dsn=lambda:'';m.make_context_fabrica_adapter=lambda *a:None
sys.modules['context_fabrica_config']=m;sys.modules['embeddings']=types.ModuleType('embeddings')
s=importlib.util.spec_from_file_location('sync',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
acts=[]
m.mc_request=lambda method,path:[] if path.endswith('/checkpoints') else acts
unknown=m._mc_initiated_hold('t',unknown_is_hold=True)
acts.append({'activity_type':'status_changed','message':'Linear ticket moved to Backlog — setting on hold','created_at':'2026-01-01T00:00:00Z'})
mirror=m._mc_initiated_hold('t',unknown_is_hold=True,hold_updated_at='2025-12-31T23:59:59Z')
operator=m._mc_initiated_hold('t',unknown_is_hold=True,hold_updated_at='2026-01-02T00:00:00Z')
writes=[]
acts.clear()
def request(method,path,body=None):
    if method=='GET':return []
    writes.append([method,path,body]);return {}
m.mc_request=request
state={'synced_issues':{'i':{'description_hash':'old'}}}
changed=m._check_description_changed({'id':'i','identifier':'MET-1','url':'https://linear.invalid/i','description':'changed'}, {'id':'t','status':'on_hold'},state)
assert not changed and not any(w[0] in ('PATCH','PUT') for w in writes), writes
print(json.dumps([unknown,mirror,operator]))`;
 const r=JSON.parse(execFileSync('python3',['-c',script,join(root,'integrations/linear/linear-sync.py')],{encoding:'utf8'}));assert.deepEqual(r,[true,false,true]);
});
test('exited PR handoff moves board into testing before waiting for delivery gates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mc-handoff-'));
 try{
 const registry=join(dir,'registry');const calls=join(dir,'calls');writeFileSync(calls,'');writeFileSync(registry,JSON.stringify([{id:'worker',mcTaskId:'task',status:'completed_by_agent',tmuxSession:'dead',repo:dir,branch:'fix'}]));
 const source=readFileSync(join(root,'swarm/check-agents.sh'),'utf8');const helper=source.slice(source.indexOf('reconcile_completed_agents_to_mc() {'),source.indexOf('mc_post_activity() {'));
 const q=s=>`'${s.replaceAll("'","'\\''")}'`;
 const script=`REGISTRY=${q(registry)}\nLOG=${q(join(dir,'log'))}\nTIMESTAMP=test\nCOMPLETION_POLICY=${q(join(root,'swarm/completion_policy.py'))}\nmc_curl(){ if [ "$1" = GET ]; then echo '{"status":"in_progress","task_type":"implementation"}'; else echo "$*" >> ${q(calls)}; echo '{}'; fi; }\ncheck_pending_checkpoint(){ return 1; }\ntmux(){ return 1; }\nlookup_task_pr(){ TASK_PR_URL=https://github.com/acme/repo/pull/1; TASK_PR_NUM=1; TASK_PR_STATE=OPEN; }\nmc_add_deliverable(){ :; }\nstate_update(){ python3 -c 'import json,sys; p=sys.argv[1]; a=json.load(open(p)); a[0].update(json.loads(sys.argv[2])); json.dump(a,open(p,"w"))' ${q(registry)} "$2"; }\n${helper}\nreconcile_completed_agents_to_mc`;
 execFileSync('bash',['-c',script],{timeout:5000});
 assert.match(readFileSync(calls,'utf8'),/PATCH.*status.*testing/);
 assert.equal(JSON.parse(readFileSync(registry,'utf8'))[0].deliveryPending,true);
 writeFileSync(calls,'');writeFileSync(registry,JSON.stringify([{id:'worker',mcTaskId:'task',status:'completed_by_agent',tmuxSession:'dead',repo:dir,branch:'fix'}, {id:'newer',mcTaskId:'task',status:'running',launchAttemptId:'new'}]));
 execFileSync('bash',['-c',script],{timeout:5000});assert.equal(readFileSync(calls,'utf8'),'');assert.equal(JSON.parse(readFileSync(registry,'utf8'))[0].status,'completed_by_agent');

 }finally{rmSync(dir,{recursive:true,force:true});}
});
