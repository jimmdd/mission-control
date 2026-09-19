import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `
import sys, json
sys.path.insert(0, ${JSON.stringify(SWARM)})
import bridge
${code}
`], { encoding: "utf8" }));
}

test("MET-738 app and governance discovery stay with the agent", () => {
  const result = python(`
questions = [
 "Which specific application is responsible for rendering the metadao.fi/apply page?",
 "Which frontend app contains the apply page?",
 "Do the top bar or border elements utilize components governed by the MERLIN design system?",
 "Which font licence did we buy?",
 "Should we change the permissionless fee rate?",
 "Should we replace the existing frontend application with a different product?",
]
print(json.dumps([bridge._is_repo_internal_lookup_question({'question': q}) for q in questions]))
`);
  assert.deepEqual(result, [true, true, true, false, false, false]);
});

test("current frontend defaults and legacy product aliases resolve without questions", () => {
  const result = python(`
from pathlib import Path
bridge.find_repo_path = lambda *a: Path('/repo')
bridge._resolve_base_branch = lambda *a: 'origin/master'
repo = [{'project': 'GitProjects', 'repo': 'backend'}]
def target(title, description='', questions=[]):
 return bridge._execution_target({'id':'test','title':title,'description':description}, repo, questions)['apps']
print(json.dumps({
 'default':target('Fix UI padding on the apply page'),
 'metadao':target('Fix the metadao.fi/apply top bar'),
 'permissionless':target('Add a permissionless raise field'),
 'futardio':target('Fix Futardio navbar'),
 'accelerate':target('Fix Accelerate button'),
 'old':target('Fix UI', 'Target app: apps/frontend'),
 'old_permissionless':target('Fix UI', 'Target app: apps/accelerated'),
 'answer':target('Fix UI', '', [{'question':'Which app: apps/frontend, apps/new-ui, apps/backable?', 'answer':'new-ui'}]),
 'explicit':target('Fix UI', 'Target app: apps/backoffice'),
 'api':target('Fix apps/new-api request validation'),
}))
`);
  assert.deepEqual(result, {
    default: ["apps/new-ui"], metadao: ["apps/new-ui"], permissionless: ["apps/backable"],
    futardio: ["apps/backable"], accelerate: ["apps/backable"], old: ["apps/new-ui"],
    old_permissionless: ["apps/backable"], answer: ["apps/new-ui"],
    explicit: ["apps/backoffice"], api: ["apps/new-api"],
  });
});

test("triage passes settled decisions and current routing to the model", () => {
  const result = python(`
captured=[]
bridge.call_gemini=lambda prompt, **kw: (captured.append(prompt) or json.dumps({'ready':True,'repos':[],'questions':[]}))
bridge.triage_task('Fix apply padding', 'Remove sticky; add 8px', 'GitProjects/backend')
print(json.dumps(captured[0]))
`);
  assert.match(result, /apps\/frontend.*removed/i);
  assert.match(result, /permissionless.*apps\/backable/i);
  assert.match(result, /small, reversible/i);
  assert.doesNotMatch(result, /Ask questions about SPECIFIC implementation choices/);
});

test("initialization and planning honor routine choices and prior answers", () => {
  const result = python(`
import plan_stage
task={'id':'test','title':'Fix apply padding','description':'Remove sticky; add 8px'}
print(json.dumps([plan_stage.build_init_prompt(task),plan_stage.build_prompt(task)]))
`);
  for (const prompt of result) {
    assert.match(prompt, /small, reversible/i);
    assert.match(prompt, /earlier answers.*binding/i);
    assert.match(prompt, /licence|license/i);
  }
});

test("a real planner decision changes progress from running to waiting", () => {
  const result = python(`
progress=[]
bridge.record_step_attempt=lambda *a: None
bridge.post_planning_questions=lambda *a: None
bridge.mc_update_task=lambda *a: None
bridge.mc_log_activity=lambda *a: None
bridge.mc_set_progress=lambda *a, **kw: progress.append(kw)
proceed=bridge.route_plan_stage_outcome({'id':'test'}, {'outcome':'questions_raised','questions':[{'question':'Which font licence did we buy?'}]})
print(json.dumps({'proceed':proceed,'progress':progress}))
`);
  assert.equal(result.proceed, false);
  assert.equal(result.progress.at(-1)?.state, "waiting");
  assert.match(result.progress.at(-1).blocked_reason, /1.*decision/i);
});

test("planner lookup mistakes get one corrective retry, never a phantom human question", () => {
  const result = python(`
state={}; progress=[]; activities=[]; posted=[]
bridge.mc_request=lambda method, path, data=None: state.update(data or {}) if method=='PUT' else dict(state)
bridge.record_step_attempt=lambda *a: None
bridge.post_planning_questions=lambda *a: posted.append(a)
bridge.mc_update_task=lambda *a: None
bridge.mc_log_activity=lambda *a: activities.append(a[-1])
bridge.mc_set_progress=lambda *a, **kw: progress.append(kw)
verdict={'outcome':'questions_raised','questions':[{'question':'Which specific application renders the apply page?'}]}
bridge.route_plan_stage_outcome({'id':'test'}, verdict)
context=bridge._build_triage_context('test')
bridge.route_plan_stage_outcome({'id':'test'}, verdict)
print(json.dumps({'progress':progress,'activities':activities,'posted':posted,'context':context}))
`);
  assert.deepEqual(result.progress.map(p => p.state), ["running", "blocked"]);
  assert.deepEqual(result.posted, []);
  assert.match(result.context, /Which specific application/);
  assert.match(result.activities[0], /no human answer/);
  assert.match(result.activities[1], /planner failure/);
});

test("MET-738 triage removes the two original discovery blockers and is ready", () => {
  const result = python(`
repo={'project':'GitProjects','repo':'backend'}
bridge.discover_local_repos=lambda: [repo]
bridge._repo_for_named_apps=lambda *a: [repo]
bridge._build_codebase_context=lambda *a: 'apps/new-ui/src/routes/(app)/apply/+page.svelte'
bridge.recall_knowledge=lambda *a: {}
bridge._design_context=lambda *a: ''
bridge._video_context=lambda *a: ''
bridge._supercut_context=lambda *a: ''
bridge._fetch_task=lambda *a: {'id':'test'}
bridge._attachment_triage_context=lambda *a: ''
bridge._build_triage_context=lambda *a: 'User already answered new-ui and direct CSS.'
bridge.triage_task=lambda *a, **kw: {'ready':False,'repos':[repo],'questions':[
 {'question':'Which specific application is responsible for rendering the metadao.fi/apply page?'},
 {'question':'Do the top bar or border elements utilize components governed by the MERLIN design system?'},
]}
triage,repos=bridge._run_triage('MET-738','Remove sticky; add 8px','GitProjects/backend',task_id='test')
print(json.dumps(triage))
`);
  assert.equal(result.ready, true);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.repos, [{ project: "GitProjects", repo: "backend" }]);
});

test("current routing reaches execution and remains specific to the backend repo", () => {
  const result = python(`
task={'id':'test','title':'Fix UI padding','description':''}
bridge._build_triage_context=lambda *a: ''
prompts=[bridge.generate_prompt(task,'',p,r) for p,r in [('GitProjects','backend'),('GitProjects','other')]]
print(json.dumps(prompts))
`);
  assert.match(result[0], /apps\/frontend has been removed/);
  assert.match(result[0], /Permissionless work goes to apps\/backable/);
  assert.doesNotMatch(result[1], /apps\/frontend has been removed/);
});

test("self-answered questions respect Auto and existing explicit confirmation", () => {
  const result = python(`
bridge.mc_log_activity=lambda *a: None
bridge.mc_update_task=lambda *a: None
bridge.resolve_notion_urls=lambda text: text
bridge._existing_pr_handoff=lambda *a, **kw: None
bridge.read_manifest=lambda: ''
bridge._base_branch_override=lambda *a: ''
bridge._build_codebase_context=lambda *a: ''
bridge.recall_knowledge=lambda *a: {}
bridge.post_planning_questions=lambda *a, **kw: None
bridge._run_triage=lambda *a, **kw: ({'ready':False,'questions':[{'id':'q','question':'Known implementation detail'}]},[{'project':'GitProjects','repo':'backend'}])
def answer(questions,*a):
 questions[0]['answer']='Use the existing pattern'; return 1
bridge._self_answer_questions=answer
results=[]
for state in [{},{'process_level':'careful'},{'process_level':'careful','confirmed':True}]:
 bridge.mc_request=lambda *a: state
 bridge.mc_set_progress=lambda *a, **kw: results.append(kw)
 bridge.process_task({'id':'test','title':'Small fix','description':''})
print(json.dumps(results))
`);
  assert.deepEqual(result.map(p => p.state), ["running", "waiting", "running"]);
});
