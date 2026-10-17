import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const swarm = fileURLToPath(new URL('../swarm', import.meta.url));
const monitor = readFileSync(new URL('../swarm/check-agents.sh', import.meta.url), 'utf8');
const monitorEnv = monitor.slice(monitor.indexOf('build_agent_env_exports() {'), monitor.indexOf('check_pending_checkpoint() {'));
const monitorCheckpoints = monitor.slice(monitor.indexOf('check_pending_checkpoint() {'), monitor.indexOf('pause_delivery() {'));
const monitorLoop = monitor.slice(monitor.indexOf('RUNNING_IDS='));
const monitorController = String.raw`
import json,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]);kind=sys.argv[2];args=sys.argv[3:]
with (root/'monitor-calls.jsonl').open('a') as f:f.write(json.dumps([kind,*args])+'\n')
if kind=='api':
    assert args[0]=='GET',args
    print((root/('monitor-checkpoints.json' if args[1].endswith('/checkpoints') else 'monitor-task.json')).read_text())
elif kind=='state':
    registry=root/'active-tasks.json';rows=json.loads(registry.read_text())
    for row in rows:
        if row['id']==args[0]:row.update(json.loads(args[1]))
    registry.write_text(json.dumps(rows))
elif kind=='tmux':
    if args[0]=='has-session':sys.exit(1)
    assert args[0]=='new-session',args
    subprocess.run(['/bin/bash','-c',args[-1]],check=True)
elif kind not in ['health','activity']:
    raise AssertionError([kind,*args])
`;

// Execute the real bridge and worker-input renderer. API calls and tmux are
// replaced; the only launched process is a fixture that records its own input.
function scenario(options = {}, program = '') {
  const code = `
import json, os, pathlib, shlex, subprocess, sys, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='mc-recovery-scope-') as temp:
    root=Path(temp)
    os.environ['MC_HOME']=str(root)
    os.environ['MISSION_CONTROL_URL']='http://127.0.0.1:9'
    for key in ['MC_REVIEW_ONLY','MC_NO_PR','MC_NO_PR_MODE','PROMPT_OVERRIDE']:
        os.environ.pop(key,None)
    sys.path.insert(0,${JSON.stringify(swarm)})
    import bridge
    config=json.loads(${JSON.stringify(JSON.stringify(options))})
    bridge.SWARM_DIR=root
    work=root/'existing-work';work.mkdir()
    prompts=root/'prompts';prompts.mkdir()
    original='Original task: update existing DRAFT1505 only after current-head tests, Greptile zero and Codex PASS. No real providers, production changes, ready, merge or deployment.'
    (prompts/'MET-947.md').write_text(original)
    human='Human follow-up: preserve all saved preferences; update the SAME draft after required checks. No release authority.'
    (prompts/'MET-947-change-request.md').write_text(human)
    entry={'id':'MET-947','mcTaskId':'task947','status':'completed_by_agent',
           'repo':'/fixture/backend','worktree':str(work),'branch':'feature/MET-947',
           'baseBranch':'origin/master','tmuxSession':'fixture-agent','launcher':'claude',
           'noPrMode':False,'agentEnv':{'KEEP_TASK_ENV':'preserved'}}
    entry.update(config.get('entry',{}))
    (root/'active-tasks.json').write_text(json.dumps([entry]))
    task={'id':'task947','title':'Guest subscriptions','status':config.get('status','in_progress'),
          'description':original,'triage_state':{'execution_target':{'repos':[
           {'project':'GitProjects','repo':'backend','branch':'feature/MET-947','base_branch':'origin/master'}]}}}
    checkpoints=config.get('checkpoints',[])
    calls=[]
    def request(method,path,*args):
        calls.append(['api',method,path])
        if method!='GET':raise AssertionError('unexpected real write')
        if path.endswith('/checkpoints'):return checkpoints
        if path=='/api/tasks/task947':return {**task,**config.get('freshTaskPatch',{})}
        raise AssertionError(path)
    bridge.mc_request=request
    bridge.mc_log_activity=lambda *a,**k:calls.append(['activity',a])
    bridge.mc_update_task=lambda *a,**k:calls.append(['taskUpdate',a])
    bridge.mc_set_progress=lambda *a,**k:calls.append(['progress',a,k])
    bridge._tmux_session_alive=lambda _:config.get('live',False)
    for name in ['_design_prompt_section','_video_prompt_section','_supercut_prompt_section','_attachment_prompt_section']:
        setattr(bridge,name,lambda _: '')
    worker=root/'fixture-worker.py'
    worker.write_text('#!/usr/bin/env python3\\nimport json,os,sys\\nfrom pathlib import Path\\nsys.path.insert(0,'+repr(${JSON.stringify(swarm)})+')\\nimport execution_prompt\\nprompt=Path(os.environ["PROMPT_OVERRIDE"]).read_text()\\nreadonly=os.environ.get("MC_REVIEW_ONLY")=="1"\\nno_pr=os.environ.get("MC_NO_PR_MODE")=="1"\\ntry: rendered=execution_prompt.render(prompt,"DEFAULT ORIGINAL WORKFLOW",readonly,no_pr)\\nexcept TypeError: rendered=execution_prompt.render(prompt,"DEFAULT ORIGINAL WORKFLOW",readonly)\\nwith open('+repr(str(root/'workers.jsonl'))+',"a") as f:f.write(json.dumps({"readonly":readonly,"noPr":no_pr,"rendered":rendered,"rawPrompt":prompt,"promptPath":os.environ["PROMPT_OVERRIDE"],"keptEnv":os.environ.get("KEEP_TASK_ENV")})+"\\\\n")\\n')
    worker.chmod(0o755)
    bridge._launcher_for_entry=lambda _:str(worker)
    real_run=subprocess.run
    def run(args,**kwargs):
        calls.append(['command',args])
        if args[:2]==['tmux','kill-session']:return subprocess.CompletedProcess(args,0,'','')
        if args[:2]==['tmux','new-session']:
            if config.get('tmuxFailure'):return subprocess.CompletedProcess(args,1,'','fixture launch failure')
            if config.get('concurrentEnv'):
                rows=json.loads((root/'active-tasks.json').read_text());rows[0]['agentEnv'].update(config['concurrentEnv']);(root/'active-tasks.json').write_text(json.dumps(rows))
            return real_run(['/bin/bash','-c',args[-1]],capture_output=True,text=True,timeout=5)
        raise AssertionError(args)
    bridge.subprocess.run=run
    def run_monitor():
        controller=root/'monitor-control.py';controller.write_text(${JSON.stringify(monitorController)})
        (root/'monitor-task.json').write_text(json.dumps(task));(root/'monitor-checkpoints.json').write_text(json.dumps(checkpoints))
        for name in ['run-claude.sh','run-codex.sh','run-pi.sh']:
            path=root/name
            if not path.exists():path.symlink_to(worker)
        setup='REGISTRY='+shlex.quote(str(root/'active-tasks.json'))+'\\nSWARM_DIR='+shlex.quote(str(root))+'\\nLOG='+shlex.quote(str(root/'monitor.log'))+'\\nTIMESTAMP=fixture\\n'
        setup+='fixture_call(){ python3 '+shlex.quote(str(controller))+' '+shlex.quote(str(root))+' "$@"; }\\n'
        setup+='mc_curl(){ fixture_call api "$@"; }\\nstate_update(){ fixture_call state "$@"; }\\ntmux(){ fixture_call tmux "$@"; }\\nmc_post_activity(){ fixture_call activity "$@"; }\\nlog_health_check(){ fixture_call health "$@"; }\\n'
        result=real_run(['/bin/bash','-c',setup+${JSON.stringify(monitorEnv+monitorCheckpoints+monitorLoop)}],capture_output=True,text=True,timeout=10)
        assert result.returncode==0,(result.stdout,result.stderr)
        assert (root/'monitor-calls.jsonl').exists(),(result.stdout,result.stderr,(root/'monitor.log').read_text())
    ${program.replaceAll('\n', '\n    ')}
    saved=json.loads((root/'active-tasks.json').read_text())[0]
    workers=[json.loads(line) for line in (root/'workers.jsonl').read_text().splitlines()] if (root/'workers.jsonl').exists() else []
    print(json.dumps({'saved':saved,'workers':workers,'calls':calls,
                     'humanPrompt':(prompts/'MET-947-change-request.md').read_text(),
                     'originalPrompt':(prompts/'MET-947.md').read_text(),
                     'monitorCalls':[json.loads(line) for line in (root/'monitor-calls.jsonl').read_text().splitlines()] if (root/'monitor-calls.jsonl').exists() else []}))
`;
  return JSON.parse(execFileSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 4 * 1024 * 1024,
  }));
}

const retry = "ok=bridge._relaunch_for_change_request(task,'Complete missing browser proof; keep every required review gate.',source='review-recovery');assert ok";

test('MET-947 recovery and subsequent human continuation preserve its authorized draft scope', () => {
  const result = scenario({}, `${retry}
first=json.loads((root/'active-tasks.json').read_text());first[0]['status']='completed_by_agent';(root/'active-tasks.json').write_text(json.dumps(first))
assert bridge._relaunch_for_change_request(task,'Continue the already-authorized draft update after all checks.',source='user-request')`);
  assert.equal(result.workers.length, 2);
  for (const worker of result.workers) {
    assert.equal(worker.readonly, false, 'routine review recovery must not create permanent NO-PR authority');
    assert.match(worker.rendered, /DEFAULT ORIGINAL WORKFLOW/);
    assert.match(worker.rendered, /current-head|current instruction|already-authorized/);
    assert.equal(worker.keptEnv, 'preserved');
  }
  assert.equal(result.saved.reviewOnly, undefined);
  assert.equal(result.saved.agentEnv.MC_REVIEW_ONLY, undefined);
  assert.equal(result.saved.noPrMode, false);
  assert.equal(result.saved.branch, 'feature/MET-947');
  assert.match(result.workers[0].rendered, /preserve all saved preferences/);
  assert.match(result.workers[0].rendered, /no new|grants no/i);
  assert.match(result.workers[0].rendered, /permission|authorization/);
});

test('recovery uses a separate prompt and preserves the latest human instructions on repeated attempts', () => {
  const result = scenario({}, `${retry}
saved=json.loads((root/'active-tasks.json').read_text());saved[0]['status']='completed_by_agent';(root/'active-tasks.json').write_text(json.dumps(saved))
${retry}`);
  assert.match(result.workers[0].promptPath, /-review-recovery\.md$/);
  assert.equal(result.humanPrompt, 'Human follow-up: preserve all saved preferences; update the SAME draft after required checks. No release authority.');
  assert.match(result.workers[1].rendered, /preserve all saved preferences/);
  assert.equal(result.workers[1].readonly, false);
  assert.equal((result.workers[1].rendered.match(/Automatic.*review recovery/g) ?? []).length, 1, 'do not accumulate recovery instructions recursively');
});

for (const entry of [
  { reviewOnly: true },
  { agentEnv: { KEEP_TASK_ENV: 'preserved', MC_REVIEW_ONLY: '1' } },
]) {
  test(`explicit review-only scope survives recovery: ${JSON.stringify(entry)}`, () => {
  const result = scenario({ entry }, `${retry}
saved=json.loads((root/'active-tasks.json').read_text());saved[0]['status']='completed_by_agent';(root/'active-tasks.json').write_text(json.dumps(saved))
assert bridge._relaunch_for_change_request(task,'Continue verification only.',source='user-request')`);
    assert.equal(result.workers.length, 2);
    for (const worker of result.workers) {
      assert.equal(worker.readonly, true);
      assert.match(worker.rendered, /LOCAL VERIFICATION ONLY \/ NO-PR MODE/);
      assert.doesNotMatch(worker.rendered, /DEFAULT ORIGINAL WORKFLOW/);
    }
    assert.equal(result.saved.reviewOnly, entry.reviewOnly);
    assert.equal(result.saved.agentEnv.MC_REVIEW_ONLY, entry.agentEnv?.MC_REVIEW_ONLY);
  });
}

test('explicit no-PR engineering retains its local-only publication boundary without becoming review-only', () => {
  const result = scenario({ entry: { noPrMode: true } }, retry);
  assert.equal(result.saved.noPrMode, true);
  assert.equal(result.saved.reviewOnly, undefined);
  assert.equal(result.saved.agentEnv.MC_REVIEW_ONLY, undefined);
  assert.equal(result.workers[0].noPr, true);
  assert.equal(result.workers[0].readonly, false);
  assert.match(result.workers[0].rawPrompt, /LOCAL WORK \/ NO-PR MODE/);
  assert.match(result.workers[0].rendered, /NO-PR MODE/);
  assert.doesNotMatch(result.workers[0].rendered, /DEFAULT ORIGINAL WORKFLOW/);
});

test('dead-session monitor defers normal-scope recovery to the bounded bridge owner', () => {
  const result = scenario({}, `${retry}\nrun_monitor()`);
  assert.equal(result.workers.length, 1, 'the monitor must not spend a separate unbounded retry');
  assert.equal(result.saved.retryCount, undefined);
  assert.equal(result.saved.changeRequestSource, 'review-recovery');
  assert.ok(!result.monitorCalls.some(([kind]) => kind === 'tmux' || kind === 'state'));
});

test('a human continuation supersedes recovery in durable dead-session worker input', () => {
  const result = scenario({}, `${retry}
assert bridge._relaunch_for_change_request(task,'LATEST HUMAN CONSTRAINT: preserve the final dismissal decision; update DRAFT1505 only after required gates.',source='user-request')
run_monitor()`);
  assert.equal(result.workers.length, 3);
  assert.match(result.saved.agentEnv.PROMPT_OVERRIDE, /-change-request\.md$/);
  const resumed = result.workers[2];
  assert.match(resumed.rendered, /LATEST HUMAN CONSTRAINT/);
  assert.doesNotMatch(resumed.rendered, /Automatic review recovery/);
  assert.equal(resumed.readonly, false);
  assert.equal(resumed.keptEnv, 'preserved');
  assert.equal(result.saved.retryCount, 1);
});

for (const launcher of ['claude', 'codex', 'pi']) {
  test(`explicit no-PR survives human continuation and actual monitor respawn: ${launcher}`, () => {
    const result = scenario({ entry: { noPrMode: true, launcher } }, `${retry}
assert bridge._relaunch_for_change_request(task,'LATEST HUMAN CONSTRAINT: continue local engineering only.',source='user-request')
run_monitor()`);
    assert.equal(result.workers.length, 3);
    assert.equal(result.saved.agentEnv.MC_NO_PR_MODE, '1');
    assert.equal(result.workers[2].noPr, true);
    assert.equal(result.workers[2].readonly, false);
    assert.match(result.workers[2].rawPrompt, /LATEST HUMAN CONSTRAINT/);
    assert.match(result.workers[2].rawPrompt, /LOCAL WORK \/ NO-PR MODE/);
    assert.doesNotMatch(result.workers[2].rendered, /DEFAULT ORIGINAL WORKFLOW/);
    assert.match(result.monitorCalls.find(([kind, action]) => kind === 'tmux' && action === 'new-session').at(-1), new RegExp(`run-${launcher}\\.sh`));
  });
}

test('monitor maps pre-existing durable noPrMode without requiring a bridge relaunch', () => {
  const result = scenario({ entry: { status: 'running', noPrMode: true, agentEnv: {
    PROMPT_OVERRIDE: 'unused', KEEP_TASK_ENV: 'preserved', MC_NO_PR_MODE: '0',
  } } }, `rows=json.loads((root/'active-tasks.json').read_text());rows[0]['agentEnv']['PROMPT_OVERRIDE']=str(prompts/'MET-947.md');(root/'active-tasks.json').write_text(json.dumps(rows))\nrun_monitor()`);
  assert.equal(result.workers.length, 1);
  assert.equal(result.workers[0].noPr, true, 'durable noPrMode wins over a stale environment value');
  assert.doesNotMatch(result.workers[0].rendered, /DEFAULT ORIGINAL WORKFLOW/);
});

test('a failed recovery launch does not persist its prompt or claim running status', () => {
  const result = scenario({ tmuxFailure: true }, "assert not bridge._relaunch_for_change_request(task,'Complete local QA',source='review-recovery')");
  assert.equal(result.workers.length, 0);
  assert.equal(result.saved.status, 'completed_by_agent');
  assert.equal(result.saved.agentEnv.PROMPT_OVERRIDE, undefined);
  assert.equal(result.saved.changeRequestSource, undefined);
  assert.ok(!result.calls.some(([kind]) => kind === 'progress' || kind === 'taskUpdate'));
});

test('successful prompt persistence merges fresh task environment without reverting newer fields', () => {
  const result = scenario({ concurrentEnv: { NEW_TASK_BOUNDARY: 'preserved' } }, retry);
  assert.equal(result.saved.agentEnv.NEW_TASK_BOUNDARY, 'preserved');
  assert.equal(result.saved.agentEnv.KEEP_TASK_ENV, 'preserved');
  assert.match(result.saved.agentEnv.PROMPT_OVERRIDE, /-review-recovery\.md$/);
});

test('a new human launch clears only obsolete local-completion ownership', () => {
  const result=scenario({entry:{status:'running',changeRequestSource:'local-completion',completionOriginSource:'dashboard',deliveryPending:true}},
    "assert bridge._relaunch_for_change_request(task,'LATEST HUMAN CONSTRAINT: continue this authorized task.',source='user-request')");
  assert.equal(result.saved.changeRequestSource,'user-request');
  assert.equal(result.saved.completionOriginSource,undefined);
  assert.equal(result.saved.deliveryPending,false);
  assert.match(result.workers[0].rendered,/LATEST HUMAN CONSTRAINT/);
});

test('a current task no-PR decision persists for runtime and subsequent completion', () => {
  const result = scenario({}, `task['triage_state']['no_pr']=True\n${retry}`);
  assert.equal(result.saved.noPrMode, false, 'the original top-level flag is preserved');
  assert.equal(result.saved.agentEnv.MC_NO_PR_MODE, '1');
  assert.equal(result.workers[0].noPr, true);
  assert.match(result.workers[0].rawPrompt, /LOCAL WORK \/ NO-PR MODE/);
});

for (const config of [
  { status: 'on_hold' },
  { checkpoints: [{ id: 'approval', status: 'pending' }] },
  { checkpoints: { unavailable: true } },
  { live: true },
]) {
  test(`recovery cannot bypass a hold, unknown/pending approval or live owner: ${JSON.stringify(config)}`, () => {
    const result = scenario(config, "assert not bridge._relaunch_for_change_request(task,'Retry local QA',source='review-recovery')");
    assert.equal(result.workers.length, 0);
    assert.equal(result.saved.status, 'completed_by_agent');
    assert.equal(result.saved.agentEnv.MC_REVIEW_ONLY, undefined);
    assert.equal(result.calls.some(([kind]) => kind === 'command'), false);
  });
}

test('a lost recovery worker can resume with original normal scope; an unrelated running task cannot', () => {
  const result = scenario({ entry: { status: 'running', changeRequestSource: 'review-recovery' } }, retry);
  assert.equal(result.workers[0].readonly, false);
  const unrelated = scenario({ entry: { status: 'running', changeRequestSource: 'user-request' } }, "assert not bridge._relaunch_for_change_request(task,'Retry local QA',source='review-recovery')");
  assert.equal(unrelated.workers.length, 0);
});

function recoveryOutcome(options = {}) {
  const code = `
import os,sys,json,tempfile,hashlib,subprocess
from pathlib import Path
from contextlib import nullcontext
with tempfile.TemporaryDirectory(prefix='mc-recovery-outcome-') as temp:
    root=Path(temp);os.environ['MC_HOME']=str(root);os.environ['MISSION_CONTROL_URL']='http://127.0.0.1:9'
    sys.path.insert(0,${JSON.stringify(swarm)})
    import bridge,review_run
    bridge.SWARM_DIR=root
    config=json.loads(${JSON.stringify(JSON.stringify(options))})
    entry={'id':'MET-947','mcTaskId':'task947','status':'completed_by_agent','worktree':str(root/'work'),
           'branch':'feature/MET-947','repo':'/fixture/backend','agentEnv':{'KEEP_TASK_ENV':'preserved'},'noPrMode':False}
    entry.update(config.get('entry',{}))
    (root/'active-tasks.json').write_text(json.dumps([entry]))
    record={'version':1,'status':'active','autonomousReruns':True,'taskId':'task947','project':'GitProjects',
            'repo':'backend','branch':'feature/MET-947','baseRef':'origin/master',
            'recipients':['greptile','verified-codex'],'dataScope':'intended-committed-branch-code-diff',
            'exclusions':['env-files','secrets','unrelated-private-data'],'approvalCheckpointId':'review947'}
    record.update(config.get('recordPatch',{}))
    task={'id':'task947','status':config.get('taskStatus','in_progress'),
          'triage_state':{'execution_target':{'repos':[{'project':'GitProjects','repo':'backend',
           'branch':'feature/MET-947','base_branch':'origin/master'}]}}}
    if config.get('authorized'):task['triage_state']['review_authorization']=record
    checkpoints=[{'id':'review947','task_id':'task947','status':config.get('checkpointStatus','approved'),
                  'response':'Task947 intended branch diff to Greptile and verified Codex; no publication or release authority.'}]
    outcome={'runId':'run947','endedAt':'2026-10-17T01:00:00Z','baseRef':'origin/master',
             'head':'head947','base':'base947','humanRequired':False,'nextAction':'complete_local_qa','log':'retained.log'}
    outcome.update(config.get('outcome',{}))
    key=hashlib.sha256(str(Path(entry['worktree']).resolve()).encode()).hexdigest()[:24]
    state=root/'pr-review-state/runs'/key/'latest.json';state.parent.mkdir(parents=True);state.write_text(json.dumps(outcome))
    launches=[];progress=[];api=[];patches=[]
    bridge.fetch_tasks_by_status=lambda status:[task] if status==task['status'] else []
    bridge._tmux_session_alive=lambda _:config.get('live',False)
    bridge._escalation_floor=lambda _:config.get('floor')
    bridge.cycle_boundary=lambda _:nullcontext()
    review_run.snapshot=lambda *_:{'head':'head947','base':'base947','clean':True}
    def request(method,path,*args):
        api.append([method,path])
        if method!='GET':raise AssertionError('no checkpoint or real-environment writes permitted')
        if path.endswith('/checkpoints'):return checkpoints
        if path=='/api/tasks/task947':return task
        raise AssertionError(path)
    bridge.mc_request=request
    bridge.mc_set_progress=lambda *a,**kw:progress.append(kw)
    bridge.mc_log_activity=lambda *a,**kw:None
    bridge._relaunch_for_change_request=lambda task,prompt,source,**kwargs: launches.append({'source':source,'prompt':prompt}) or True
    def run(args,**kwargs):
        assert 'swarm-state.py' in str(args[1]),args
        patch=json.loads(args[args.index('--patch-json')+1]);patches.append(patch)
        rows=json.loads((root/'active-tasks.json').read_text());rows[0].update(patch);(root/'active-tasks.json').write_text(json.dumps(rows))
        return subprocess.CompletedProcess(args,0,'','')
    bridge.subprocess.run=run
    bridge.process_local_review_recovery()
    print(json.dumps({'launches':launches,'progress':progress,'api':api,'patches':patches,
                     'saved':json.loads((root/'active-tasks.json').read_text())[0]}))
`;
  return JSON.parse(execFileSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }));
}

test('routine missing local proof resumes without manufacturing a permission checkpoint', () => {
  const result = recoveryOutcome();
  assert.equal(result.launches.length, 1);
  assert.equal(result.launches[0].source, 'review-recovery');
  assert.match(result.launches[0].prompt, /not publication approval/);
  assert.ok(result.api.every(([method]) => method === 'GET'));
  assert.equal(result.saved.reviewOnly, undefined);
  assert.equal(result.saved.agentEnv.MC_REVIEW_ONLY, undefined);
});

test('normal-scope recovery owns its lost-worker retry without relying on a NO-PR flag', () => {
  const result = recoveryOutcome({
    entry: { status: 'running', changeRequestSource: 'review-recovery',
      reviewRecovery: { head: 'head947', base: 'base947', attempts: 1, lastRunId: 'run947' } },
    floor: Date.parse('2026-10-17T01:01:00Z') / 1000,
  });
  assert.equal(result.launches.length, 1);
  assert.equal(result.saved.reviewRecovery.attempts, 2);
  assert.equal(result.saved.reviewOnly, undefined);
});

test('completed delivery ownership cannot replay the old bounded recovery outcome', () => {
  const result = recoveryOutcome({ entry: {
    status: 'running', changeRequestSource: 'delivery', deliveryPending: true,
    reviewRecovery: { head: 'head947', base: 'base947', attempts: 1, lastRunId: 'run947' },
  } });
  assert.equal(result.launches.length, 0);
  assert.equal(result.saved.reviewRecovery.attempts, 1);
});

for (const options of [
  { outcome: { humanRequired: true } },
  { outcome: { nextAction: 'ask_human' } },
  { checkpointStatus: 'pending' },
  { taskStatus: 'on_hold' },
  { live: true },
]) {
  test(`a genuine gate or live owner blocks automatic recovery: ${JSON.stringify(options)}`, () => {
    const result = recoveryOutcome(options);
    assert.equal(result.launches.length, 0);
    assert.ok(result.api.every(([method]) => method === 'GET'));
  });
}

test('code-finding retries retain exact scoped review consent and cannot broaden recipients', () => {
  const missing = recoveryOutcome({ outcome: { nextAction: 'fix_code' } });
  const permitted = recoveryOutcome({ authorized: true, outcome: { nextAction: 'fix_code' } });
  const changed = recoveryOutcome({ authorized: true, outcome: { nextAction: 'fix_code' },
    recordPatch: { recipients: ['different-service'] } });
  const revoked = recoveryOutcome({ authorized: true, outcome: { nextAction: 'fix_code' },
    recordPatch: { status: 'revoked' } });
  assert.equal(missing.launches.length, 0);
  assert.equal(permitted.launches.length, 1);
  assert.equal(changed.launches.length, 0);
  assert.equal(revoked.launches.length, 0);
});

test('bounded technical retry exhaustion retains the failure without asking approval to skip it', () => {
  const result = recoveryOutcome({ entry: {
    reviewRecovery: { head: 'head947', base: 'base947', attempts: 2, lastRunId: 'older-run' },
  } });
  assert.equal(result.launches.length, 0);
  assert.match(result.progress[0].blocked_reason, /No approval to skip checks is requested/);
  assert.ok(result.api.every(([method]) => method === 'GET'));
});

test('the guarded fresh task carries a newly added no-PR restriction into the worker', () => {
  const freshTaskPatch={triage_state:{no_pr:true}};
  const result=scenario({freshTaskPatch},retry);
  assert.equal(result.workers.length,1);
  assert.equal(result.workers[0].noPr,true);
  assert.match(result.workers[0].rendered,/LOCAL WORK \/ NO-PR MODE/);
});

test('a review grant revoked in the guarded task read defeats stale fix-code authority', () => {
  const result=scenario({freshTaskPatch:{triage_state:{}}},`
import review_authorization
record=review_authorization.scope(task,entry)[1]
record.update(version=1,status='active',autonomousReruns=True,approvalCheckpointId='grant')
task['triage_state']['review_authorization']=record
checkpoints.append({'id':'grant','task_id':'task947','status':'approved','response':'Approved exact scope'})
assert review_authorization.authorized(task,checkpoints,entry)
assert not bridge._relaunch_for_change_request(task,'Fix the retained code finding',source='review-recovery',require_review_authorization=True)`);
  assert.equal(result.workers.length,0);
  assert.equal(result.saved.status,'completed_by_agent');
});

for (const entry of [{noPrMode:true},{agentEnv:{MC_NO_PR_MODE:'1'}}]) {
  test(`the bridge leaves no-PR delivery and titles untouched: ${JSON.stringify(entry)}`, () => {
    const result=scenario({entry:{status:'ready',...entry}},`
bridge._ensure_pr_title=lambda *a: (_ for _ in ()).throw(AssertionError('NO-PR title write'))
bridge._capture_pr_for_task(task)
assert not bridge._auto_review_monitor(task)
assert not bridge._relaunch_for_change_request(task,'Push a PR fix',source='auto-monitor')`);
    assert.equal(result.workers.length,0);
    assert.ok(!result.calls.some(([kind]) => kind==='command'));
  });
}

test('fresh task restrictions also stop bridge title writes and automatic PR repairs', () => {
  const result=scenario({},`
task['triage_state']['no_pr']=True
bridge._ensure_pr_title=lambda *a: (_ for _ in ()).throw(AssertionError('title write'))
bridge._capture_pr_for_task(task)
assert not bridge._auto_review_monitor(task)`);
  assert.equal(result.workers.length,0);
  assert.ok(!result.calls.some(([kind]) => kind==='command'));
});

for (const kind of ['ci_failed','review_blocked']) {
  test(`delivery feedback resumes through the bounded bridge owner: ${kind}`, () => {
    const result=recoveryOutcome({entry:{status:'running',changeRequestSource:'delivery-feedback',deliveryPending:true,
      deliveryFeedback:{head:'head947',base:'base947',baseRef:'origin/master',kind}}});
    assert.equal(result.launches.length,1);
    assert.equal(result.launches[0].source,'auto-monitor');
    assert.match(result.launches[0].prompt,/original task authority/);
    assert.equal(result.saved.deliveryFeedback.attempts,1);
    assert.ok(result.api.every(([method]) => method==='GET'));
  });
}

test('delivery review recovery honors typed authorization stops and bounded technical gaps', () => {
  const entry={status:'running',changeRequestSource:'delivery-review',deliveryPending:true};
  const human=recoveryOutcome({entry,outcome:{humanRequired:true,nextAction:'request_specific_decision'}});
  const local=recoveryOutcome({entry,outcome:{nextAction:'complete_local_qa'}});
  assert.equal(human.launches.length,0);
  assert.equal(local.launches.length,1);
  assert.equal(local.launches[0].source,'review-recovery');
});
