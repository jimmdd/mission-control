import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
const python = (source) => JSON.parse(execFileSync("python3", ["-c", `
import sys,json,os,pathlib,tempfile,subprocess,time,signal
sys.path.insert(0,${JSON.stringify(SWARM)})
import review_run
${source}
`], { encoding: "utf8", timeout: 20000 }));

test("MET-939 QA and independent-lane gaps continue automatically; actual decisions stop", () => {
  const result = python(`
samples=[(1,'VERDICT: WARN\\nREVIEW_REASON: qa_gap'),
 (1,'VERDICT: WARN\\nREVIEW_REASON: independent_review'),
 (1,'VERDICT: FAIL\\nREVIEW_REASON: qa_gap'),
 (2,'timed out negotiating with the code-mode host'),
 (1,'VERDICT: WARN\\nREVIEW_REASON: authorization'),
 (1,'VERDICT: WARN\\nREVIEW_REASON: product_decision'),
 (1,'VERDICT: WARN\\nREVIEW_REASON: code_findings')]
print(json.dumps([review_run.classify(*x) for x in samples]))
`);
  assert.deepEqual(result.map(x => x.nextAction), ["complete_local_qa", "complete_independent_review", "fix_code", "bounded_readonly_diagnosis", "request_specific_decision", "request_specific_decision", "fix_code"]);
  assert.deepEqual(result.map(x => x.humanRequired), [false, false, false, false, true, true, false]);
});

test("completed reviews apply only to their exact clean head/base and unchanged QA evidence", () => {
  const result = python(`
state={'head':'new','base':'base','clean':True,'evidenceFingerprint':'proof'}
receipt={'head':'new','base':'base','verdict':'PASS','review':'VERDICT: PASS',
 'evidenceFingerprint':'proof','greptile':{'head':'new','base':'base','status':'COMPLETED','verdict':'PASS','runId':'id','review':{'comments':[]}}}
out=[review_run.reusable(receipt,state)]
for patch in [{'head':'old'},{'base':'old'},{'clean':False},{'evidenceFingerprint':'changed'}]:
 out.append(review_run.reusable(receipt,{**state,**patch}))
for patch in [{'verdict':'WARN'},{'review':'VERDICT: WARN\\nVERDICT: PASS'},{'greptile':None}]:
 out.append(review_run.reusable({**receipt,**patch},state))
print(json.dumps(out))
`);
  assert.deepEqual(result, [true, false, false, false, false, false, false, false]);
});

test("delivery consumes only a fresh finished outcome for its exact clean head, base and evidence", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);os.environ['MC_HOME']=str(root);wt=root/'work'
 state={'head':'head','base':'base','clean':True,'evidenceFingerprint':'proof'}
 review_run.snapshot=lambda *_:state
 key=review_run.hashlib.sha256(str(wt.resolve()).encode()).hexdigest()[:24]
 path=root/'swarm/pr-review-state/runs'/key/'latest.json';path.parent.mkdir(parents=True)
 now=time.time();stamp=lambda value:review_run.datetime.datetime.fromtimestamp(value,review_run.datetime.timezone.utc).isoformat()
 outcome={**state,'runId':'new-run','baseRef':'origin/main','startedAt':stamp(now),
  'endedAt':stamp(now+1),'nextAction':'complete_local_qa','humanRequired':False}
 def consume(patch=None):
  path.write_text(json.dumps({**outcome,**(patch or {})}))
  return review_run.consumable_outcome(wt,'origin/main',now-.1) is not None
 answers=[consume()]
 for patch in [{'startedAt':stamp(now-10)},{'endedAt':None},{'runId':None},
  {'head':'old'},{'base':'old'},{'baseRef':'origin/other'},{'evidenceFingerprint':'old'},
  {'nextAction':'none'},{'humanRequired':None}]:answers.append(consume(patch))
 answers.append(consume({'nextAction':'request_specific_decision','humanRequired':True}))
 state['clean']=False;answers.append(consume())
 path.unlink();answers.append(review_run.consumable_outcome(wt,'origin/main',now-.1) is not None)
 print(json.dumps(answers))
`);
  assert.deepEqual(result, [true, ...Array(9).fill(false), true, false, false]);
});

test("QA fingerprint changes with receipts and ignores symlink targets", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);proof=root/'.codex-evidence';proof.mkdir();(proof/'qa.json').write_text('before')
 a=review_run.evidence_fingerprint(root);(proof/'qa.json').write_text('after');b=review_run.evidence_fingerprint(root)
 (root/'outside').write_text('not proof');(proof/'link').symlink_to(root/'outside');c=review_run.evidence_fingerprint(root)
 print(json.dumps([a!=b,b==c]))
`);
  assert.deepEqual(result, [true, true]);
});

test("one review lease prevents duplicate workers and cancellation releases it", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);repo=root/'repo';repo.mkdir()
 for args in [['init','-q'],['config','user.name','Test'],['config','user.email','test@example.invalid']]:subprocess.run(['git',*args],cwd=repo,check=True,capture_output=True)
 (repo/'x').write_text('x');subprocess.run(['git','add','.'],cwd=repo,check=True);subprocess.run(['git','commit','-qm','fixture'],cwd=repo,check=True)
 ready=root/'ready';script=root/'review.sh';script.write_text('echo ready > '+str(ready)+'\\nsleep 30\\n')
 env={**os.environ,'MC_HOME':str(root)};cmd=[sys.executable,str(pathlib.Path(${JSON.stringify(SWARM)})/'review_run.py'),str(script),str(repo),'HEAD']
 first=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:
  until=time.monotonic()+4
  while not ready.exists() and time.monotonic()<until:time.sleep(.01)
  assert ready.exists()
  second=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=3)
  os.kill(first.pid,signal.SIGTERM);firstout,firsterr=first.communicate(timeout=7)
  latest=json.loads(next((root/'swarm/pr-review-state/runs').glob('*/latest.json')).read_text())
  # A third completed run proves the lease was released without touching others.
  script.write_text('echo "VERDICT: WARN"\\necho "REVIEW_REASON: qa_gap"\\nexit 1\\n')
  third=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=4)
  print(json.dumps({'duplicate':second.returncode,'message':second.stdout,'interrupted':latest['status'],'third':third.returncode,'first_exit':first.returncode,'first_error':firsterr.decode()}))
 finally:
  if first.poll() is None:os.killpg(first.pid,signal.SIGKILL);first.communicate()
`);
  assert.equal(result.duplicate, 3);
  assert.match(result.message, /already running/);
  assert.equal(result.interrupted, "interrupted", JSON.stringify(result));
  assert.equal(result.third, 1);
});

test("WARN output is retained with automatic QA routing and never becomes a PASS receipt", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);repo=root/'repo';repo.mkdir()
 for args in [['init','-q'],['config','user.name','Test'],['config','user.email','test@example.invalid']]:subprocess.run(['git',*args],cwd=repo,check=True,capture_output=True)
 (repo/'x').write_text('x');subprocess.run(['git','add','.'],cwd=repo,check=True);subprocess.run(['git','commit','-qm','fixture'],cwd=repo,check=True)
 script=root/'review.sh';script.write_text('echo "Missing /companies QA"\\necho "VERDICT: WARN"\\necho "REVIEW_REASON: qa_gap"\\nexit 1\\n')
 run=subprocess.run([sys.executable,str(pathlib.Path(${JSON.stringify(SWARM)})/'review_run.py'),str(script),str(repo),'HEAD'],env={**os.environ,'MC_HOME':str(root)},capture_output=True,text=True,timeout=4)
 latest=json.loads(next((root/'swarm/pr-review-state/runs').glob('*/latest.json')).read_text())
 print(json.dumps({'exit':run.returncode,'status':latest['status'],'next':latest['nextAction'],'human':latest['humanRequired'],'log':pathlib.Path(latest['log']).read_text(),'receipts':len(list((root/'swarm/pr-review-state').glob('*.json')))}))
`);
  assert.equal(result.exit, 1);
  assert.equal(result.status, "incomplete");
  assert.equal(result.next, "complete_local_qa");
  assert.equal(result.human, false);
  assert.match(result.log, /Missing \/companies QA/);
  assert.equal(result.receipts, 0);
});

test("cancellation preserves retained findings and authorization stops without accepting partial PASS", () => {
  const result = python(`
outcomes=[]
for verdict,reason,answer_only in [('FAIL','code_findings',False),('WARN','authorization',True),('PASS','',False)]:
 with tempfile.TemporaryDirectory() as temp:
  root=pathlib.Path(temp);repo=root/'repo';repo.mkdir()
  for args in [['init','-q'],['config','user.name','Test'],['config','user.email','test@example.invalid']]:subprocess.run(['git',*args],cwd=repo,check=True,capture_output=True)
  (repo/'x').write_text('x');subprocess.run(['git','add','.'],cwd=repo,check=True);subprocess.run(['git','commit','-qm','fixture'],cwd=repo,check=True)
  ready=root/'ready';payload=root/'payload';payload.write_text('VERDICT: '+verdict+'\\n'+('REVIEW_REASON: '+reason+'\\n' if reason else ''))
  emit=('mkdir -p "$MC_REVIEW_ARCHIVE_DIR/fixture"\\ncp '+str(payload)+' "$MC_REVIEW_ARCHIVE_DIR/fixture/answer-1.txt"' if answer_only else 'cat '+str(payload))
  script=root/'review.sh';script.write_text(emit+'\\necho ready > '+str(ready)+'\\nsleep 30\\n')
  process=subprocess.Popen([sys.executable,str(pathlib.Path(${JSON.stringify(SWARM)})/'review_run.py'),str(script),str(repo),'HEAD'],env={**os.environ,'MC_HOME':str(root)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  try:
   until=time.monotonic()+4
   while not ready.exists() and time.monotonic()<until:time.sleep(.01)
   assert ready.exists();os.kill(process.pid,signal.SIGTERM);process.communicate(timeout=7)
   outcome=json.loads(next((root/'swarm/pr-review-state/runs').glob('*/latest.json')).read_text())
   outcomes.append({k:outcome[k] for k in ['status','nextAction','humanRequired','interrupted']})
  finally:
   if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.communicate()
print(json.dumps(outcomes))
`);
  assert.deepEqual(result,[
    {status:'findings',nextAction:'fix_code',humanRequired:false,interrupted:true},
    {status:'authorization',nextAction:'request_specific_decision',humanRequired:true,interrupted:true},
    {status:'interrupted',nextAction:'resume_review',humanRequired:false,interrupted:true},
  ]);
});

test("the actual recovery worker input preserves NO-PR and concrete decision boundaries", () => {
  const result = python(`
import execution_prompt
print(json.dumps(execution_prompt.render('Prior user decision: preserve artwork.',
 'Execute ENTIRE workflow: push and create PR. Never ask questions.',True)))
`);
  assert.match(result,/Prior user decision: preserve artwork/);
  assert.match(result,/LOCAL VERIFICATION ONLY \/ NO-PR MODE/);
  assert.match(result,/Do not push, create\/edit a PR/);
  assert.match(result,/checkpoint\s+protocol.*STOP/s);
  assert.doesNotMatch(result,/Execute ENTIRE workflow/);
  const launcher = execFileSync("python3", ["-c", `from pathlib import Path; print((Path(${JSON.stringify(SWARM)})/'run-claude.sh').read_text())`], {encoding:"utf8"});
  assert.match(launcher,/python3 "\$SCRIPT_DIR\/execution_prompt.py" "\$PROMPT_FILE" "\$AUTONOMY_SUFFIX"/);
});

test("QA changed during a PASS review is typed as automatic completion and never records PASS", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);repo=root/'repo';repo.mkdir()
 for args in [['init','-q'],['config','user.name','Test'],['config','user.email','test@example.invalid']]:subprocess.run(['git',*args],cwd=repo,check=True,capture_output=True)
 (repo/'x').write_text('x');subprocess.run(['git','add','.'],cwd=repo,check=True);subprocess.run(['git','commit','-qm','fixture'],cwd=repo,check=True)
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
 (repo/'.git/info/exclude').write_text('.codex-evidence/\\n');proof=repo/'.codex-evidence';proof.mkdir();(proof/'qa').write_text('before')
 fingerprint=review_run.evidence_fingerprint(repo);(proof/'qa').write_text('changed')
 answer=root/'answer';answer.write_text('VERDICT: PASS');greptile=root/'greptile.json';greptile.write_text(json.dumps({'head':head,'base':head,'verdict':'PASS','status':'COMPLETED','runId':'fixture','review':{'comments':[]}}))
 r=subprocess.run([sys.executable,str(pathlib.Path(${JSON.stringify(SWARM)})/'pr_readiness.py'),'record',str(repo),'HEAD',head,head,str(answer),str(greptile)],env={**os.environ,'MC_HOME':str(root),'MC_REVIEW_EVIDENCE_FINGERPRINT':fingerprint},capture_output=True,text=True)
 print(json.dumps({'exit':r.returncode,'classification':review_run.classify(r.returncode,'VERDICT: PASS\\n'+r.stdout+r.stderr),'receipt':(root/'swarm/pr-review-state'/f'{head}.json').exists()}))
`);
  assert.equal(result.exit,1);assert.equal(result.receipt,false);
  assert.equal(result.classification.nextAction,"complete_local_qa");
});

test("successful Codex reviews retain the complete private per-attempt transcript", () => {
  const result = python(`
import contextlib,io,codex_review
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);stub=root/'codex';stub.write_text('#!/usr/bin/env python3\\nimport sys,pathlib\\n'
  +'sys.stdin.read()\\nprint("full-head-"+"x"*40000+"-full-tail",flush=True)\\n'
  +'pathlib.Path(sys.argv[sys.argv.index("--output-last-message")+1]).write_text("VERDICT: PASS")\\n');stub.chmod(0o755)
 os.environ['MC_HOME']=str(root)
 with contextlib.redirect_stdout(io.StringIO()):code=codex_review.run('private fixture prompt',root/'answer',3,executable=str(stub))
 archive=next((root/'swarm/pr-review-state/codex-transcripts').glob('*'));text=(archive/'transcript-1.jsonl').read_text()
 print(json.dumps({'exit':code,'head':text.startswith('full-head-'),'tail':text.rstrip().endswith('-full-tail'),'length':len(text),'mode':(archive/'transcript-1.jsonl').stat().st_mode & 0o777,'prompt':(archive/'prompt.txt').read_text()}))
`);
  assert.equal(result.exit,0);assert.equal(result.head,true);assert.equal(result.tail,true);
  assert.ok(result.length>40000);assert.equal(result.mode,0o600);assert.equal(result.prompt,"private fixture prompt");
});

test("an exited Greptile CLI leader cannot strand its descendant or the inherited lease", () => {
  const result = python(`
import fcntl,greptile_review
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);ready=root/'ready';survived=root/'survived'
 child=root/'child.py';child.write_text('import os,pathlib,time\\n'
  +'pathlib.Path('+repr(str(ready))+').write_text(str(os.getpid()))\\n'
  +'time.sleep(2);pathlib.Path('+repr(str(survived))+').write_text("orphan");time.sleep(30)\\n')
 stub=root/'stub.py';stub.write_text('import os,subprocess,sys\\n'
  +'fd=int(os.environ["MC_REVIEW_LOCK_FD"])\\n'
  +'subprocess.Popen([sys.executable,'+repr(str(child))+'],pass_fds=(fd,))\\n')
 with (root/'review.lock').open('a+') as lease:
  fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB);os.environ['MC_REVIEW_LOCK_FD']=str(lease.fileno())
  timed_out=False
  try:greptile_review.capture([sys.executable,str(stub)],root,time.monotonic()+1.5)
  except TimeoutError:timed_out=True
 os.environ.pop('MC_REVIEW_LOCK_FD',None)
 with (root/'review.lock').open('a+') as next_lease:
  try:fcntl.flock(next_lease,fcntl.LOCK_EX|fcntl.LOCK_NB);released=True
  except BlockingIOError:released=False
 time.sleep(.8)
 if ready.exists():
  try:os.kill(int(ready.read_text()),signal.SIGKILL)
  except ProcessLookupError:pass
 print(json.dumps({'timed_out':timed_out,'started':ready.exists(),'survived':survived.exists(),'released':released}))
`);
  assert.deepEqual(result,{timed_out:true,started:true,survived:false,released:true});
});

test("a shell leader exiting early cannot release the review lease before helper cleanup", () => {
  const result = python(`
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);repo=root/'repo';repo.mkdir()
 for args in [['init','-q'],['config','user.name','Test'],['config','user.email','test@example.invalid']]:subprocess.run(['git',*args],cwd=repo,check=True,capture_output=True)
 (repo/'x').write_text('x');subprocess.run(['git','add','.'],cwd=repo,check=True);subprocess.run(['git','commit','-qm','fixture'],cwd=repo,check=True)
 ready=root/'ready';cleaned=root/'cleaned';childpid=root/'childpid'
 helper=root/'helper.py';helper.write_text('import os,pathlib,subprocess,signal,time,sys\\n'
  +'fd=int(os.environ["MC_REVIEW_LOCK_FD"])\\n'
  +'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"],start_new_session=True,pass_fds=(fd,))\\n'
  +'pathlib.Path('+repr(str(childpid))+').write_text(str(child.pid))\\n'
  +'def finish(*a):\\n time.sleep(.3)\\n os.killpg(child.pid,signal.SIGKILL)\\n child.wait()\\n pathlib.Path('+repr(str(cleaned))+').write_text("done")\\n sys.exit(0)\\n'
  +'signal.signal(signal.SIGTERM,finish)\\npathlib.Path('+repr(str(ready))+').write_text("ready")\\ntime.sleep(30)\\n')
 script=root/'review.sh';script.write_text(sys.executable+' '+str(helper)+' &\\nwhile [ ! -f '+str(ready)+' ]; do sleep .01; done\\necho "VERDICT: WARN"\\necho "REVIEW_REASON: qa_gap"\\nexit 1\\n')
 env={**os.environ,'MC_HOME':str(root)};cmd=[sys.executable,str(pathlib.Path(${JSON.stringify(SWARM)})/'review_run.py'),str(script),str(repo),'HEAD']
 first=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  until=time.monotonic()+3
  while not ready.exists() and time.monotonic()<until:time.sleep(.01)
  second=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=4)
  first.communicate(timeout=7)
  alive=True
  try:os.kill(int(childpid.read_text()),0)
  except ProcessLookupError:alive=False
  print(json.dumps({'duplicate':second.returncode,'cleaned':cleaned.exists(),'child_alive':alive,'first':first.returncode}))
 finally:
  if first.poll() is None:first.kill();first.communicate()
  if childpid.exists():
   try:os.killpg(int(childpid.read_text()),signal.SIGKILL)
   except ProcessLookupError:pass
`);
  assert.equal(result.duplicate,3);assert.equal(result.cleaned,true);assert.equal(result.child_alive,false);assert.equal(result.first,1);
});
