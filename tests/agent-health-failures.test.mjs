import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MissionControlDB} from '../src/db.ts';
import {operationalHealth} from '../src/health.ts';
function scenario(run){
 const home=mkdtempSync(join(tmpdir(),'mc-worker-health-'));const db=new MissionControlDB(':memory:');
 try{db.initSchema();db.seedDefaults();mkdirSync(join(home,'swarm'));const task=db.createTask({title:'worker test',status:'in_progress'});
 const health=entries=>{writeFileSync(join(home,'swarm/active-tasks.json'),JSON.stringify(entries));return operationalHealth(db,home,{now:2000000000000,linearEnabled:false,bridgeEnabled:false});};
 run(db,task,health);
 }finally{db.close();rmSync(home,{recursive:true,force:true});}
}
test('failed workers are degraded across providers; a healthy retry supersedes stale failure',()=>scenario((db,t,health)=>{
 for(const agentProfile of ['claude','codex','pi']){
 const failed={mcTaskId:t.id,agentProfile,status:'failed',lastError:'authentication_required',failedAt:1999999999000};
 const result=health([failed]);assert.equal(result.status,'degraded');assert.equal(result.workerHealth.failed,1);assert.ok(result.reasons.includes('agent_execution_blocked'));
 const recovered={mcTaskId:t.id,agentProfile:'codex',status:'running',launchAttemptId:'new',startedAt:2000000000000,lastHeartbeatAt:2000000000000};
 assert.equal(health([failed,recovered]).status,'ok');
 }
}));
test('queued, quota, intentional human wait and completed history remain distinct',()=>scenario((db,t,health)=>{
 for(const status of ['ready','rate_limited','paused']) assert.equal(health([{mcTaskId:t.id,status,startedAt:2000000000000}]).status,'ok');
 assert.equal(health([{mcTaskId:t.id,status:'rate_limited'}]).workerHealth.retryScheduled,1);
 const checkpoint=db.createCheckpoint({task_id:t.id,kind:'question',prompt:'Reconnect this coding profile'});
 const blocked=health([{mcTaskId:t.id,status:'failed',lastError:'authentication_required'}]);
 assert.equal(blocked.workerHealth.waitingForHuman,1);assert.equal(blocked.status,'degraded');
 db.resolveCheckpoint(checkpoint.id,'answered','Reconnected');db.updateTask(t.id,{status:'done'});
 assert.equal(health([{mcTaskId:t.id,status:'failed'}]).status,'ok');
}));
test('a dead nonprogressing running worker is unhealthy without pretending the service is down',()=>scenario((db,t,health)=>{
 const result=health([{mcTaskId:t.id,status:'running',lastHeartbeatAt:1999999000000}]);
 assert.equal(result.status,'degraded');assert.equal(result.workerHealth.status,'degraded');assert.ok(result.reasons.includes('agent_heartbeat_stale'));
}));


test('a delayed old failure cannot override a newer attempt even when its failedAt arrives later',()=>scenario((db,t,health)=>{
 const old={mcTaskId:t.id,status:'failed',launchAttemptId:'old',lastAttemptAt:1999999000000,failedAt:2000000000100};
 const retry={mcTaskId:t.id,status:'running',launchAttemptId:'new',lastAttemptAt:2000000000000,lastHeartbeatAt:2000000000000};
 assert.equal(health([retry,old]).status,'ok');
}));


test('completed stale-running history cannot degrade worker or operational health',()=>scenario((db,t,health)=>{
 db.updateTask(t.id,{status:'done'});
 const result=health([{mcTaskId:t.id,status:'running',lastHeartbeatAt:1000}]);
 assert.equal(result.status,'ok');assert.equal(result.workerHealth.status,'ok');
}));
