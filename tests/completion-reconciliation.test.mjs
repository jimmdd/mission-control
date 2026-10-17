import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const swarm = fileURLToPath(new URL('../swarm', import.meta.url));
const source = readFileSync(join(swarm, 'check-agents.sh'), 'utf8');
const helpers = source.slice(source.indexOf('check_pending_checkpoint() {'), source.indexOf('mc_post_activity() {'));
const runningLoop = source.slice(source.indexOf('RUNNING_IDS='));
const limitRetry = source.slice(source.indexOf('retry_rate_limited_agents() {'), source.indexOf('\nretry_rate_limited_agents\n'));
const nonRunning = source.slice(source.indexOf('reconcile_non_running_sessions() {'), source.indexOf('prune_state_artifacts() {'));
const stateUpdate = source.slice(source.indexOf('state_update() {'), source.indexOf('maybe_snapshot_state() {'))
  .replace('state_update() {', 'guarded_state_update() {');
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const pr = (state, number = 1) => ({ state, number, url: `https://github.com/acme/backend/pull/${number}` });

// Execute the actual monitor functions with fake API/gh/tmux functions. Neither
// the live MC API nor a real process launcher is reachable from these fixtures.
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-completion-'));
  try {
    mkdirSync(join(dir, 'swarm'));
    const registry = join(dir, 'swarm', 'active-tasks.json'), scenario = join(dir, 'scenario.json');
    const calls = join(dir, 'calls.jsonl'), api = join(dir, 'api.py');
    const task = { id: 'task', mcTaskId: 'mc', status: 'completed_by_agent', repo: dir,
      worktree: dir, branch: 'feature/preserved', tmuxSession: 'fixture-agent', ...options.registry };
    const config = { task: {status:'in_progress', task_type:'implementation'}, checkpoints: [], activities: [],
      prs: [pr('OPEN')], ...options };
    writeFileSync(registry, JSON.stringify([task, ...options.siblings ?? []]));
    writeFileSync(scenario, JSON.stringify(config));
    writeFileSync(calls, '');
    writeFileSync(join(dir, 'log'), '');
    writeFileSync(api, `
import json,sys
from pathlib import Path
registry,scenario,calls=map(Path,sys.argv[1:4])
kind,args=sys.argv[4],sys.argv[5:]
config=json.loads(scenario.read_text())
with calls.open('a') as f: f.write(json.dumps([kind,*args])+'\\n')
if kind=='state':
    pass  # The real shell state_update and locked state helper apply the patch.
elif kind=='api':
    method,path=args[:2]
    key='checkpoints' if path.endswith('/checkpoints') else 'activities' if path.endswith('/activities') else 'task'
    if method=='GET':
        if config.get(key+'Error'): sys.exit(1)
        if key=='checkpoints' and config.get('concurrentCheckpointPatch'):
            rows=json.loads(registry.read_text());rows[0].update(config.pop('concurrentCheckpointPatch'))
            registry.write_text(json.dumps(rows));scenario.write_text(json.dumps(config))
        if key=='activities' and config.get('lateBookkeepingPatch'):
            rows=json.loads(registry.read_text());rows[0].update(config.pop('lateBookkeepingPatch'))
            registry.write_text(json.dumps(rows));scenario.write_text(json.dumps(config))
        if key=='task' and config.get('taskReadPatch'):
            config['taskReads']=config.get('taskReads',0)+1
            if config['taskReads']>=config.get('taskReadPatchAt',2):config['task'].update(config.pop('taskReadPatch'))
            scenario.write_text(json.dumps(config))
        value=config.get(key)
        print(value if isinstance(value,str) else json.dumps(value))
    else:
        if config.get('writeError')==method: sys.exit(1)
        payload=json.loads(args[args.index('-d')+1])
        if method=='PUT': config.update(progress=payload)
        elif method=='POST': config['activities'].append(payload)
        else: config['task'].update(payload)
        scenario.write_text(json.dumps(config))
        print('{}')
elif kind=='gh':
    if config.get('ghError'): sys.exit(1)
    assert args[:2]==['pr','list'], args
    assert '--state' in args and args[args.index('--state')+1]=='all', args
    if config.get('concurrentEntryPatch'):
        rows=json.loads(registry.read_text())
        rows[0].update(config['concurrentEntryPatch'])
        registry.write_text(json.dumps(rows))
    value=config['prs']
    print(value if isinstance(value,str) else json.dumps(value))
elif kind=='tmux':
    if args[0]!='has-session': sys.exit(2)
    sys.exit(0 if config.get('liveSession') or args[-1] in config.get('liveSessions',[]) else 1)
elif kind=='gate':
    print(json.dumps({'status':config.get('gateStatus','pending')}))
elif kind=='review':
    if config.get('concurrentReviewPatch'):
        rows=json.loads(registry.read_text());rows[0].update(config.pop('concurrentReviewPatch'))
        registry.write_text(json.dumps(rows));scenario.write_text(json.dumps(config))
elif kind=='complete':
    if config.get('concurrentCallbackPatch'):
        rows=json.loads(registry.read_text());rows[0].update(config.pop('concurrentCallbackPatch'))
        registry.write_text(json.dumps(rows));scenario.write_text(json.dumps(config))
    if config.get('completeFailures',0)>0:
        config['completeFailures']-=1;scenario.write_text(json.dumps(config));sys.exit(1)
`);
    const call = `python3 ${quote(api)} ${quote(registry)} ${quote(scenario)} ${quote(calls)}`;
    const gate = join(dir, 'gate.py');
    writeFileSync(gate, `import subprocess\nsubprocess.run(['python3',${JSON.stringify(api)},${JSON.stringify(registry)},${JSON.stringify(scenario)},${JSON.stringify(calls)},'gate'],check=True)\n`);
    const setup = `
REGISTRY=${quote(registry)}
export MC_HOME=${quote(dir)}
STATE_TOOL=${quote(join(swarm, 'swarm-state.py'))}
SWARM_DIR=${quote(dir)}
LOG=${quote(join(dir, 'log'))}
TIMESTAMP=fixture
COMPLETION_POLICY=${quote(join(swarm, 'completion_policy.py'))}
READINESS_GATE=${quote(gate)}
AGENT_LIMIT_RETRY_WINDOW_SECONDS=43200
${stateUpdate}
state_update(){ ${call} state "$@"; guarded_state_update "$@"; }
mc_curl(){ ${call} api "$@"; }
gh(){ ${call} gh "$@"; }
tmux(){ ${call} tmux "$@"; }
mc_add_deliverable(){ ${call} deliverable "$@"; }
mc_complete_task(){ ${call} complete "$@"; }
mc_post_activity(){ ${call} activity "$@"; }
log_health_check(){ ${call} health "$@"; }
build_agent_env_exports(){ ${call} launcher "$@"; }
resolve_launcher_path(){ ${call} launcher "$@"; }
validate_gsd_artifacts(){ ${call} gsd "$@"; GSD_STATUS=passed; }
run_codex_review(){ ${call} review "$@"; CODEX_REVIEW=${quote(options.reviewText ?? "PASS")}; return ${options.reviewExit ?? 0}; }
review_has_blocking_issues(){ return ${options.reviewText?.match(/FAIL|WARN/) ? 0 : 1}; }
extract_agent_summary(){ AGENT_SUMMARY=fixture; }
${helpers}
`;
    const entry = options.mode === 'running' ? runningLoop : options.mode === 'non_running'
      ? `${nonRunning}\nreconcile_non_running_sessions` : options.mode === 'rate_limited'
      ? `${limitRetry}\nretry_rate_limited_agents` : options.mode === 'handoff'
      ? `reconcile_completed_agents_to_mc\n${runningLoop}` : `reconcile_completed_agents_to_mc${options.repeat ? '\nreconcile_completed_agents_to_mc' : ''}`;
    execFileSync('bash', ['-c', `${setup}\n${entry}`], {encoding:'utf8', timeout:15_000});
    return { registry: JSON.parse(readFileSync(registry, 'utf8'))[0], config: JSON.parse(readFileSync(scenario, 'utf8')),
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
      log: readFileSync(join(dir, 'log'), 'utf8') };
  } finally { rmSync(dir, {recursive:true, force:true}); }
}

function assertNoCompletionOrLaunch(result) {
  assert.ok(!result.calls.some(([kind]) => ['complete','deliverable','activity','gate','launcher'].includes(kind)), JSON.stringify(result.calls));
  assert.ok(!result.calls.some(([kind, action]) => kind === 'tmux' && action !== 'has-session'));
}

test('completion policy distinguishes open, closed, merged, and unverifiable delivery', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import json,sys
sys.path.insert(0,sys.argv[1])
from completion_policy import completion_action as action
url='https://github.com/acme/backend/pull/1'
print(json.dumps([action('implementation',False,url,state) for state in ['OPEN','CLOSED','MERGED','UNKNOWN']]+[
action('implementation',False,'',lookup_failed=True),
action('investigation',True,url,pending_checkpoint=True),
action('implementation',False,'')]))
`, swarm], {encoding:'utf8'}));
  assert.deepEqual(result, ['review','closed','merged','wait','wait','checkpoint','resume']);
});

test('an unmerged closed PR pauses delivery, preserves work, and is idempotent', () => {
  const result = fixture({prs:[pr('CLOSED')], repeat:true});
  assert.equal(result.registry.status, 'paused');
  assert.equal(result.registry.lastError, 'pr_closed_without_replacement');
  assert.equal(result.registry.deliveryPending, false);
  assert.equal(result.registry.branch, 'feature/preserved');
  assert.equal(result.config.task.status, 'in_progress', 'automatic blockers never invoke runtime-stopping Hold');
  assert.equal(result.config.progress.state, 'waiting');
  assert.match(result.config.progress.blocked_reason, /replacement PR handoff/);
  assert.equal(result.calls.filter(([kind]) => kind === 'state').length, 2, 'claim and guarded pause are separate atomic transitions');
  assert.equal(result.config.activities.length, 1);
  assert.equal(result.config.activities[0].activity_type, 'updated');
  assert.match(result.config.activities[0].message, /blocked delivery/);
  assertNoCompletionOrLaunch(result);
});

test('an open replacement wins over a historical closed or merged PR', () => {
  const result = fixture({prs:[pr('CLOSED'),pr('MERGED',2),pr('OPEN',3)]});
  assert.equal(result.registry.status, 'running');
  assert.equal(result.registry.deliveryPending, true);
  assert.ok(result.calls.some(([kind,,,url]) => kind === 'deliverable' && url === pr('OPEN',3).url));
  assert.ok(!result.calls.some(([kind]) => kind === 'complete'));
  assert.equal(result.config.task.status, 'in_progress');
});

for (const gateStatus of ['pending','pass']) {
  test(`completed recovery releases execution ownership and uses ordinary readiness: ${gateStatus}`, () => {
    const result = fixture({mode:'handoff', gateStatus, registry:{changeRequestSource:'review-recovery'}});
    assert.equal(result.registry.changeRequestSource, 'delivery');
    assert.equal(result.registry.status, gateStatus === 'pass' ? 'ready' : 'running');
    assert.equal(result.registry.deliveryPending, gateStatus !== 'pass');
    assert.equal(result.calls.filter(([kind]) => kind === 'gate').length, gateStatus === 'pass' ? 2 : 1);
    assert.equal(result.calls.filter(([kind]) => kind === 'complete').length, gateStatus === 'pass' ? 1 : 0);
    assert.equal(result.calls.filter(([kind]) => kind === 'gsd').length, gateStatus === 'pass' ? 1 : 0);
    assert.equal(result.calls.filter(([kind]) => kind === 'review').length, gateStatus === 'pass' ? 1 : 0);
    assert.ok(!result.calls.some(([kind]) => kind === 'launcher'));
    assert.ok(!result.calls.some(([kind, action]) => kind === 'tmux' && action !== 'has-session'));
    assert.equal(result.registry.reviewOnly, undefined);
    assert.equal(result.registry.noPrMode, undefined);
  });
}

test('env-only no-PR completion stays local even when the branch already has a PR', () => {
  const result = fixture({registry:{noPrMode:false, changeRequestSource:'review-recovery', agentEnv:{MC_NO_PR_MODE:'1'}}});
  assert.equal(result.registry.status, 'ready');
  assert.ok(!result.calls.some(([kind]) => ['gh','deliverable','gate','launcher'].includes(kind)));
  const completion = result.calls.find(([kind]) => kind === 'complete');
  assert.ok(completion);
  assert.equal(completion.at(-1), 'true');
  assert.equal(completion.at(-2), '');
});

for (const concurrentEntryPatch of [
  {status:'running', changeRequestSource:'review-recovery', runStartedAt:2, deliveryPending:false},
  {status:'completed_by_agent', changeRequestSource:'review-recovery', runStartedAt:2},
  {status:'paused', heldAt:'new-hold'},
  {reviewOnly:true, noPrMode:true, agentEnv:{MC_REVIEW_ONLY:'1'}},
  {agentEnv:{MC_NO_PR_MODE:'1'}},
]) {
  test(`a newer execution or authority boundary defeats stale recovery completion: ${JSON.stringify(concurrentEntryPatch)}`, () => {
    const result = fixture({mode:'handoff', gateStatus:'pass',
      registry:{changeRequestSource:'review-recovery',runStartedAt:1}, concurrentEntryPatch});
    for (const [key,value] of Object.entries(concurrentEntryPatch)) {
      assert.deepEqual(result.registry[key], value);
    }
    assert.notEqual(result.registry.changeRequestSource, 'delivery');
    assert.notEqual(result.registry.deliveryPending, true);
    assert.ok(!result.calls.some(([kind]) => ['gate','complete','launcher','deliverable','activity'].includes(kind)));
    assert.match(result.log, /completed execution changed before delivery handoff/);
  });
}

for (const prs of [[pr('CLOSED')],[pr('MERGED')],[]]) {
  for (const completionRetryCount of [0,3]) {
    test(`a newer recovery defeats stale ${prs[0]?.state ?? 'missing'} PR completion at retry ${completionRetryCount}`, () => {
      const result = fixture({prs, registry:{changeRequestSource:'review-recovery',runStartedAt:1,completionRetryCount},
        concurrentEntryPatch:{status:'running',changeRequestSource:'review-recovery',runStartedAt:2}});
      assert.equal(result.registry.status, 'running');
      assert.equal(result.registry.runStartedAt, 2);
      assert.equal(result.registry.completionRetryCount, completionRetryCount);
      assert.ok(!result.calls.some(([kind]) => ['complete','deliverable','activity','launcher'].includes(kind)));
      assert.ok(result.calls.filter(([kind]) => kind === 'api').every(([,method]) => method === 'GET'));
      assert.equal(result.config.task.status, 'in_progress');
    });
  }
}

for (const scope of [
  {registry:{noPrMode:true}},
  {registry:{agentEnv:{MC_NO_PR_MODE:'1'}}},
  {task:{status:'in_progress',task_type:'investigation'}},
]) {
  for (const concurrentCheckpointPatch of [
    {status:'running',changeRequestSource:'review-recovery',runStartedAt:2},
    {status:'paused',heldAt:'new-hold'},
    {noPrMode:false,agentEnv:{MC_NO_PR_MODE:'0'}},
  ]) {
    test(`local completion rejects a newer execution or scope: ${JSON.stringify({scope,concurrentCheckpointPatch})}`, () => {
      const registry={changeRequestSource:'review-recovery',runStartedAt:1,...scope.registry};
      // A no-op flag patch is not a competing decision for investigation tasks.
      if (scope.task && concurrentCheckpointPatch.noPrMode === false) registry.noPrMode=true;
      const result=fixture({...scope,registry,concurrentCheckpointPatch});
      for (const [key,value] of Object.entries(concurrentCheckpointPatch)) assert.deepEqual(result.registry[key],value);
      assert.notEqual(result.registry.status,'ready');
      assert.ok(!result.calls.some(([kind]) => ['complete','deliverable','activity','launcher'].includes(kind)));
      assert.ok(result.calls.filter(([kind]) => kind === 'api').every(([,method]) => method === 'GET'));
    });
  }
}

test('failed local completion remains resumable without agent respawn and preserves human follow-up ownership', () => {
  const result=fixture({mode:'handoff',completeFailures:1,registry:{noPrMode:true,changeRequestSource:'dashboard'}});
  assert.equal(result.registry.status,'running');
  assert.equal(result.registry.changeRequestSource,'local-completion');
  assert.equal(result.registry.completionOriginSource,'dashboard');
  assert.equal(result.registry.deliveryPending,true);
  assert.ok(!result.calls.some(([kind]) => ['gate','launcher'].includes(kind)));
  const resumed=fixture({repeat:true,completeFailures:1,registry:{noPrMode:true,changeRequestSource:'dashboard'}});
  assert.equal(resumed.calls.filter(([kind]) => kind === 'complete').length,2);
  assert.equal(resumed.registry.status,'ready');
  assert.equal(resumed.registry.changeRequestSource,'dashboard');
  assert.equal(resumed.registry.deliveryPending,false);
});

test('a newer owner during local completion cannot be overwritten by the final ready transition', () => {
  const concurrentCallbackPatch={status:'paused',heldAt:'new-hold'};
  const result=fixture({registry:{noPrMode:true,changeRequestSource:'review-recovery'},concurrentCallbackPatch});
  assert.equal(result.calls.filter(([kind]) => kind === 'complete').length,1);
  assert.equal(result.registry.status,'paused');
  assert.equal(result.registry.heldAt,'new-hold');
  assert.ok(!result.calls.some(([kind]) => kind === 'activity'));
});

test('a stale completion sync marker cannot hide a closed PR on an active ticket', () => {
  const result = fixture({prs:[pr('CLOSED')],registry:{completionSyncedAt:'2026-10-01T00:00:00Z'}});
  assert.equal(result.registry.status, 'paused');
  assert.equal(result.registry.lastError, 'pr_closed_without_replacement');
  assert.equal(result.registry.completionSyncedAt, null);
  assert.equal(result.config.task.status, 'in_progress', 'automatic blockers never invoke runtime-stopping Hold');
  assertNoCompletionOrLaunch(result);
});

test('a merged PR alone does not establish the task acceptance criteria', () => {
  const result = fixture({prs:[pr('MERGED')]});
  assert.equal(result.registry.status, 'paused');
  assert.equal(result.registry.lastError, 'merged_pr_delivery_unreconciled');
  assertNoCompletionOrLaunch(result);
});

test('API and GitHub lookup failures or malformed responses cannot trigger completion or retries', () => {
  for (const scenario of [
    {taskError:true}, {task:'not-json'}, {task:{}}, {checkpointsError:true}, {checkpoints:{}},
    {checkpoints:[{}]}, {checkpoints:[{status:'unknown'}]}, {checkpoints:[{status:'pending',prompt:{}}]},
    {ghError:true}, {prs:'not-json'}, {prs:{}}, {prs:[{...pr('OPEN'),state:'UNKNOWN'}]},
    {prs:[{state:'OPEN',number:1}]},
  ]) {
    const result = fixture(scenario);
    assert.equal(result.registry.status, 'completed_by_agent', JSON.stringify(scenario));
    assert.ok(!result.calls.some(([kind]) => kind === 'state'), JSON.stringify(scenario));
    assertNoCompletionOrLaunch(result);
  }
});

test('pending questions block implementation, no-PR, and investigation completion before PR lookup', () => {
  for (const extra of [{}, {registry:{noPrMode:true}}, {task:{status:'in_progress',task_type:'investigation'}}]) {
    const result = fixture({checkpoints:[{status:'pending',prompt:'What is the Mori organization slug?'}], ...extra});
    assert.equal(result.registry.status, 'paused');
    assert.equal(result.registry.lastError, 'pending_human_checkpoint');
    assert.match(result.config.progress.blocked_reason, /Mori organization slug/);
    assert.ok(!result.calls.some(([kind]) => kind === 'gh'));
    assertNoCompletionOrLaunch(result);
  }
});

test('existing delivery-pending entries surface closed, missing, and merged PR blockers', () => {
  for (const [prs, error] of [[[pr('CLOSED')],'pr_closed_without_replacement'], [[], 'delivery_pr_missing'], [[pr('MERGED')],'merged_pr_delivery_unreconciled']]) {
    const result = fixture({mode:'running', registry:{status:'running',deliveryPending:true}, prs});
    assert.equal(result.registry.status, 'paused');
    assert.equal(result.registry.lastError, error);
    assert.equal(result.config.task.status, 'in_progress', 'automatic blockers never invoke runtime-stopping Hold');
    assertNoCompletionOrLaunch(result);
  }
});

test('a checkpoint preserves waiting without holding, killing, or replacing a live session', () => {
  for (const status of ['completed_by_agent','running']) {
    const result = fixture({mode:status === 'running' ? 'running' : undefined,
      registry:{status,deliveryPending:status === 'running'}, liveSession:true,
      checkpoints:[{status:'pending',prompt:'Unanswered slug question'}]});
    assert.equal(result.registry.status, 'paused');
    assert.equal(result.config.task.status, 'in_progress');
    assert.ok(!result.calls.some(([kind,method]) => kind === 'api' && method === 'PATCH'));
    assert.ok(!result.calls.some(([kind]) => kind === 'gh'));
    assertNoCompletionOrLaunch(result);
  }
});

test('holding a completed handoff cannot stop a live sibling agent on the same task', () => {
  const result = fixture({prs:[pr('CLOSED')], liveSessions:['sibling-agent'],
    siblings:[{id:'sibling',mcTaskId:'mc',status:'running',tmuxSession:'sibling-agent'}]});
  assert.equal(result.registry.status, 'paused');
  assert.equal(result.config.task.status, 'in_progress');
  assert.ok(!result.calls.some(([kind,method]) => kind === 'api' && method === 'PATCH'));
  assertNoCompletionOrLaunch(result);
});

test('stale non-running sessions with pending or unreadable checkpoints are left intact', () => {
  for (const scenario of [{checkpoints:[{status:'pending',prompt:'Need slug'}]}, {checkpointsError:true}]) {
    const result = fixture({mode:'non_running',liveSession:true,registry:{startedAt:1},...scenario});
    assert.ok(!result.calls.some(([kind,action]) => kind === 'tmux' && action !== 'has-session'));
    assert.ok(!result.calls.some(([kind,method]) => kind === 'api' && method === 'PATCH'));
    assertNoCompletionOrLaunch(result);
  }
});

test('checkpoint verification fails closed before a dead-session respawn', () => {
  for (const scenario of [{checkpointsError:true},{checkpoints:'bad-json'}]) {
    const result = fixture({mode:'running',registry:{status:'running',deliveryPending:false},...scenario});
    assert.equal(result.registry.status, 'running');
    assert.ok(!result.calls.some(([kind]) => ['tmux','state','gh'].includes(kind)));
    assertNoCompletionOrLaunch(result);
  }
});

test('delivery-pending GitHub errors wait without silently converting them to a missing PR', () => {
  const result = fixture({mode:'running',registry:{status:'running',deliveryPending:true},ghError:true});
  assert.equal(result.registry.status, 'running');
  assert.equal(result.registry.deliveryPending, true);
  assert.ok(!result.calls.some(([kind]) => kind === 'state'));
  assertNoCompletionOrLaunch(result);
});

test('rate-limit retry cannot relaunch an agent with an unanswered checkpoint', () => {
  const result = fixture({mode:'rate_limited',registry:{status:'rate_limited',nextRateLimitRetryAt:1},
    checkpoints:[{status:'pending',prompt:'Need organization slug'}]});
  assert.equal(result.registry.status, 'paused');
  assertNoCompletionOrLaunch(result);
});

test('failed blocker bookkeeping stays retryable without promoting completion', () => {
  for (const writeError of ['PUT','POST']) {
    const result = fixture({mode:'handoff',prs:[pr('CLOSED')],writeError});
    assert.equal(result.registry.status, 'running');
    assert.equal(result.registry.deliveryPending, true, 'the monitor retains delivery ownership for a later retry');
    assert.equal(result.calls.filter(([kind]) => kind === 'state').length,1);
    assertNoCompletionOrLaunch(result);
  }
});

test('an unreadable local hold marker list cannot silently advance delivery bookkeeping', () => {
  for (const scenario of [{activitiesError:true},{activities:{}}]) {
    const result = fixture({mode:'handoff',prs:[pr('CLOSED')],...scenario});
    assert.equal(result.registry.status, 'running');
    assert.equal(result.registry.deliveryPending, true);
    assert.equal(result.calls.filter(([kind]) => kind === 'state').length,1);
    assert.ok(!result.calls.some(([kind,method]) => kind === 'api' && ['PATCH','POST'].includes(method)));
    assertNoCompletionOrLaunch(result);
  }
});

for (const lateBookkeepingPatch of [
  {status:'running', runStartedAt:2, changeRequestSource:'dashboard'},
  {status:'paused', heldAt:'new-human-hold'},
]) {
  test(`late delivery bookkeeping cannot hold or overwrite a new owner: ${JSON.stringify(lateBookkeepingPatch)}`, () => {
    const result=fixture({prs:[pr('CLOSED')],registry:{runStartedAt:1},lateBookkeepingPatch});
    for (const [key,value] of Object.entries(lateBookkeepingPatch)) assert.deepEqual(result.registry[key],value);
    assert.ok(!result.calls.some(([kind,method]) => kind==='api' && method==='PATCH'));
    assert.ok(!result.calls.some(([kind,action]) => kind==='tmux' && action!=='has-session'));
  });
}

for (const status of ['done','closed']) {
  test(`blocker bookkeeping does not reopen a terminal task: ${status}`, () => {
    const result=fixture({prs:[pr('CLOSED')],taskReadPatch:{status}});
    assert.equal(result.config.task.status,status);
    assert.ok(!result.calls.some(([kind,method]) => kind==='api' && method!=='GET'));
    assertNoCompletionOrLaunch(result);
  });
}

for (const registry of [{noPrMode:true},{agentEnv:{MC_NO_PR_MODE:'1'}}]) {
  test(`live no-PR work never enters PR delivery automation: ${JSON.stringify(registry)}`, () => {
    const result=fixture({mode:'running',registry:{status:'running',...registry},liveSession:true,prs:[pr('OPEN')]});
    assert.equal(result.registry.status,'running');
    assert.ok(!result.calls.some(([kind]) => ['gh','gate','complete','launcher','deliverable'].includes(kind)));
  });
}

for (const stage of ['concurrentReviewPatch','concurrentCallbackPatch']) {
  test(`a newer human execution survives PR readiness during ${stage}`, () => {
    const newer={status:'running',runStartedAt:2,changeRequestAt:'new-human',changeRequestSource:'dashboard',deliveryPending:false};
    const result=fixture({mode:'handoff',registry:{runStartedAt:1},gateStatus:'pass',[stage]:newer});
    for (const [key,value] of Object.entries(newer)) assert.deepEqual(result.registry[key],value);
    assert.ok(result.calls.some(([kind]) => kind==='review'));
    if (stage==='concurrentReviewPatch') assert.ok(!result.calls.some(([kind]) => kind==='complete'));
    else assert.equal(result.calls.filter(([kind]) => kind==='complete').length,1);
  });
}

for (const review of [
  {reviewExit:1,reviewText:'VERDICT: FAIL'},
  {reviewExit:1,reviewText:'VERDICT: WARN\nREVIEW_REASON: authorization'},
  {reviewExit:3,reviewText:'Review already running'},
]) {
  test(`non-PASS delivery never launches an unguarded repair: ${JSON.stringify(review)}`, () => {
    const result=fixture({mode:'handoff',gateStatus:'pass',...review});
    assert.ok(!result.calls.some(([kind]) => ['complete','launcher'].includes(kind)));
    assert.ok(!result.calls.some(([kind,action]) => kind==='tmux' && action!=='has-session'));
    assert.equal(result.registry.deliveryPending,true);
    assert.equal(result.registry.status,'running');
    if (review.reviewExit===3) assert.notEqual(result.registry.changeRequestSource,'delivery-review');
    else assert.equal(result.registry.changeRequestSource,'delivery-review');
  });
}

test('a FAIL arriving after a new human launch cannot queue or replace its owner', () => {
  const newer={status:'running',runStartedAt:2,changeRequestSource:'dashboard',deliveryPending:false};
  const result=fixture({mode:'handoff',gateStatus:'pass',reviewExit:1,reviewText:'VERDICT: FAIL',concurrentReviewPatch:newer});
  for (const [key,value] of Object.entries(newer)) assert.deepEqual(result.registry[key],value);
  assert.ok(!result.calls.some(([kind]) => ['complete','launcher'].includes(kind)));
});

test('a fresh task no-PR decision blocks active delivery before registry propagation', () => {
  const result=fixture({mode:'running',registry:{status:'running',deliveryPending:true},task:{status:'in_progress',triage_state:{no_pr:true}},gateStatus:'pass'});
  assert.ok(!result.calls.some(([kind]) => ['gh','gate','review','complete','launcher'].includes(kind)));
  assert.equal(result.registry.status,'running');
});
