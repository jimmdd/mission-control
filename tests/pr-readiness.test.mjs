import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const swarm = fileURLToPath(new URL('../swarm', import.meta.url));
const greptile = {head:'abc',base:'def',status:'COMPLETED',verdict:'PASS',runId:'run',review:{comments:[]}};
function evaluate(meta, receipt = { head: 'abc', base: 'def', verdict: 'PASS', greptile }, threads = []) {
  return JSON.parse(execFileSync('python3', ['-c', `import sys,json; sys.path.insert(0,sys.argv[1]); from pr_readiness import evaluate; print(json.dumps(evaluate(*json.loads(sys.argv[2]))))`, swarm, JSON.stringify([meta, receipt, threads])], {encoding:'utf8'}));
}
const green = {state:'OPEN', headRefOid:'abc', baseRefOid:'def', statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]};
test('readiness requires successful CI and independent review for the same head and base', () => {
  assert.equal(evaluate(green).status,'pass');
  assert.equal(evaluate(green,null).status,'review_required');
  assert.equal(evaluate(green,{head:'old',base:'def',verdict:'PASS'}).status,'review_required');
  assert.equal(evaluate(green,{head:'abc',base:'old',verdict:'PASS'}).status,'review_required');
  assert.equal(evaluate(green,{head:'abc',base:'def',verdict:'FAIL'}).status,'review_required');
  assert.equal(evaluate(green,{head:'abc',base:'def',verdict:'PASS'}).status,'review_required');
  for (const evidence of [null, {...greptile, head:'old'}, {...greptile,base:'old'},
    {...greptile,status:'IN_FLIGHT'}, {...greptile,review:{comments:[{severity:'P2'}]}},
    {...greptile,review:{}}, {...greptile,runId:null}]) {
    assert.equal(evaluate(green,{head:'abc',base:'def',verdict:'PASS',greptile:evidence}).status,'review_required');
  }
});
test('missing, pending, cancelled, skipped-only, and failed checks cannot pass', () => {
  for(const checks of [[],null,[{status:'IN_PROGRESS'}],[{status:'COMPLETED',conclusion:'CANCELLED'}],[{status:'COMPLETED',conclusion:'FAILURE'}],[{status:'COMPLETED',conclusion:'SKIPPED'}],[{state:'ERROR'}],[{}]]) {
    assert.notEqual(evaluate({...green,statusCheckRollup:checks}).status,'pass');
  }
  assert.equal(evaluate({...green,statusCheckRollup:[{state:'SUCCESS'},{status:'COMPLETED',conclusion:'SKIPPED'}]}).status,'pass');
});
test('review requests and unresolved threads block even with green CI', () => {
  assert.equal(evaluate({...green,reviewDecision:'CHANGES_REQUESTED'}).status,'review_blocked');
  assert.equal(evaluate(green,undefined,[{isResolved:false,isOutdated:true}]).status,'review_blocked');
  assert.equal(evaluate(green,undefined,[{isResolved:true}]).status,'pass');
  assert.notEqual(evaluate({...green,state:'CLOSED'}).status,'pass');
});

test('GitHub command errors and head changes fail closed in the live lookup path', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import sys,json,subprocess
sys.path.insert(0,sys.argv[1])
import pr_readiness as gate
url='https://github.com/acme/app/pull/1'
gate.run=lambda args: (_ for _ in ()).throw(subprocess.CalledProcessError(1,args))
error=gate.check(url)
meta={'state':'OPEN','headRefOid':'a','baseRefOid':'b','statusCheckRollup':[{'state':'SUCCESS'}]}
response={'data':{'repository':{'pullRequest':{'headRefOid':'new','baseRefOid':'b','reviewThreads':{'nodes':[],'pageInfo':{'hasNextPage':False}}}}}}
gate.run=lambda args: json.dumps(meta if args[1]=='pr' else response)
race=gate.check(url)
print(json.dumps({'error':error,'race':race}))
`, swarm], {encoding:'utf8'}));
  assert.equal(result.error.status,'unknown');
  assert.equal(result.race.status,'pending');
});

test('monitor keeps exited agents pending and cannot fall through a failed gate', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(),'mc-monitor-gates-'));
  try {
    const registry=join(dir,'registry.json'), output=join(dir,'calls');
    writeFileSync(registry,JSON.stringify([{id:'task',status:'running',deliveryPending:true,tmuxSession:'dead',branch:'feature/test',repo:dir,worktree:dir,mcTaskId:'mc',reviewCycles:3}]));
    const source=readFileSync(join(swarm,'check-agents.sh'),'utf8');
    const loop=source.slice(source.indexOf('RUNNING_IDS='));
    for(const scenario of ['pending','ci_failed','unknown','review_blocked','review_unavailable','review_failed','completion_rejected','pass']) {
      writeFileSync(output,'');
      const script=`
REGISTRY=${JSON.stringify(registry)}
LOG=${JSON.stringify(join(dir,'log'))}
SWARM_DIR=${JSON.stringify(dir)}
READINESS_GATE=unused
TIMESTAMP=fixture
MAX_REVIEW_CYCLES=3
MAX_CI_FIX_CYCLES=2
CFG_CI_FIX_ENABLED=false
SCENARIO=${scenario}
state_update(){ echo "$*" >> ${JSON.stringify(output)}; }
mc_curl(){ echo '{"status":"testing","task_type":"implementation"}'; }
mc_post_activity(){ :; }
mc_add_deliverable(){ :; }
mc_complete_task(){ [ "$SCENARIO" != completion_rejected ]; }
log_health_check(){ :; }
extract_agent_summary(){ :; }
validate_gsd_artifacts(){ GSD_STATUS=passed; return 0; }
run_codex_review(){ CODEX_REVIEW="$SCENARIO"; [ "$SCENARIO" != review_unavailable ]; }
review_has_blocking_issues(){ [ "$SCENARIO" = review_failed ]; }
tmux(){ echo unexpected-tmux >> ${JSON.stringify(output)}; return 1; }
gh(){ if [ "$2" = list ]; then echo 1; else echo https://github.com/acme/app/pull/1; fi; }
python3(){
 case "$SCENARIO" in
 pending|ci_failed|unknown|review_blocked) printf '{"status":"%s"}' "$SCENARIO";;
 *) echo '{"status":"pass"}';;
 esac
}
${loop}`;
      execFileSync('bash',['-c',script],{encoding:'utf8'});
      const calls=readFileSync(output,'utf8');
      assert.doesNotMatch(calls,/unexpected-tmux/,scenario);
      assert.equal(calls.includes('ready-with-pr'),scenario==='pass',scenario);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('partially reported required checks and unfinished workflow matrices stay pending', () => {
  const meta={...green,requiredChecks:['lint','build'],statusCheckRollup:[{name:'lint',status:'COMPLETED',conclusion:'SUCCESS'}]};
  assert.equal(evaluate(meta).status,'pending');
  meta.statusCheckRollup.push({name:'build',status:'COMPLETED',conclusion:'SUCCESS'});
  assert.equal(evaluate(meta).status,'pass');
  assert.equal(evaluate({...meta,workflowRuns:[{status:'in_progress'}]}).status,'pending');
  assert.equal(evaluate({...meta,workflowRuns:[{status:'completed',conclusion:'failure'}]}).status,'ci_failed');
});

test('live lookup distinguishes workflows sharing a display name and deduplicates retries by ID', () => {
  const results=JSON.parse(execFileSync('python3',['-c',`
import sys,json,tempfile,os
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import pr_readiness as gate
meta={'state':'OPEN','headRefOid':'abc','baseRefOid':'def','baseRefName':'release/test','statusCheckRollup':[{'name':'lint','state':'SUCCESS'}]}
pr={**meta,'reviewThreads':{'nodes':[],'pageInfo':{'hasNextPage':False}}}
success={'workflowDatabaseId':1,'workflowName':'CI','event':'pull_request','status':'completed','conclusion':'success'}
pending={**success,'workflowDatabaseId':2,'status':'in_progress','conclusion':None}
results=[]
with tempfile.TemporaryDirectory() as root:
    os.environ['MC_HOME']=root
    gate.receipt_dir().mkdir(parents=True)
    (gate.receipt_dir()/'abc.json').write_text(json.dumps({'head':'abc','base':'def','verdict':'PASS','greptile':{'head':'abc','base':'def','status':'COMPLETED','verdict':'PASS','runId':'run','review':{'comments':[]}}}))
    for runs in ([success,pending],[success,{**success,'conclusion':'failure'}],[{**success,'workflowDatabaseId':None}]):
        def fake(args):
            if args[1]=='pr': return json.dumps(meta)
            if args[1]=='run':
                assert 'workflowDatabaseId' in args[-1]
                return json.dumps(runs)
            if args[2]=='graphql': return json.dumps({'data':{'repository':{'pullRequest':pr}}})
            assert 'release%2Ftest' in args[2]
            return '[]'
        gate.run=fake
        results.append(gate.check('https://github.com/acme/app/pull/1'))
print(json.dumps(results))
`,swarm],{encoding:'utf8'}));
  assert.deepEqual(results.map(r=>r.status),['pending','pass','unknown']);
  assert.equal(results[1].baseRefName,'release/test');
});

test('monitor reviews existing PR handoffs against the PR target, not the worktree starting branch', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'mc-handoff-review-'));
  try {
    const remote=join(dir,'remote'), checkout=join(dir,'checkout');
    mkdirSync(remote); mkdirSync(checkout); mkdirSync(join(dir,'logs'));
    const git=(...args)=>execFileSync('git',args,{cwd:checkout,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init','--bare',remote);
    git('init','-b','release/test');
    git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    git('commit','--allow-empty','-m','base');
    const base=git('rev-parse','HEAD');
    git('remote','add','origin',remote); git('push','origin','release/test');
    git('checkout','-b','feature/handoff'); git('commit','--allow-empty','-m','head');
    const head=git('rev-parse','HEAD');
    git('push','origin','feature/handoff');
    const registry=join(dir,'registry.json'), captured=join(dir,'review-base');
    writeFileSync(registry,JSON.stringify([{id:'task',worktree:checkout,baseBranch:'origin/feature/handoff'}]));
    writeFileSync(join(dir,'pre-review.sh'),`printf '%s' "$2" > ${JSON.stringify(captured)}\necho 'VERDICT: PASS'\n`);
    const source=readFileSync(join(swarm,'check-agents.sh'),'utf8');
    const fn=source.slice(source.indexOf('run_codex_review() {'),source.indexOf('review_has_blocking_issues() {'));
    const script=`
REGISTRY=${JSON.stringify(registry)}
SWARM_DIR=${JSON.stringify(dir)}
SCRIPT_DIR=${JSON.stringify(dir)}
LOG=${JSON.stringify(join(dir,'log'))}
TASK_ID=task
READINESS='${JSON.stringify({head,base,baseRefName:'release/test'})}'
codex(){ :; }
${fn}
run_codex_review ${JSON.stringify(checkout)} feature/handoff 1
`;
    execFileSync('bash',['-c',script],{encoding:'utf8'});
    assert.equal(readFileSync(captured,'utf8'),'refs/remotes/origin/release/test');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
