// A question is not just a prompt and some options. It carries why it is being
// asked, what its answer binds, the conversation about it, and the three exits that
// stop one unanswerable question holding up the other eight.
//
// questions.py is Python, so each case drives it through a short python3 program.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SWARM = fileURLToPath(new URL("../swarm", import.meta.url));

/** Call one questions.py function with JSON args, return its JSON result. */
function call(fn, args) {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import questions
fn, args = json.loads(sys.stdin.read())
print(json.dumps(getattr(questions, fn)(*args)))
`;
  const stdout = execFileSync("python3", ["-c", program], {
    input: JSON.stringify([fn, args]),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

const q = (over = {}) => ({ id: "q1", question: "Which font licence?", ...over });

test("a question gets a decision id, so an answer binds something", () => {
  const out = call("canonical", [q(), 1]);
  assert.equal(out.becomes, "D-01");
  assert.equal(out.source, "triage");
  assert.deepEqual(out.thread, []);
  assert.equal(out.deferred, false);
});

test("an unknown source falls back rather than propagating a bad label", () => {
  assert.equal(call("canonical", [q({ source: "nonsense" }), 1]).source, "triage");
  assert.equal(call("canonical", [q({ source: "planner" }), 1]).source, "planner");
});

test("a deferred question stops blocking, which is the point of deferring", () => {
  const qs = [q({ id: "a" }), q({ id: "b", deferred: true })];
  assert.deepEqual(call("blocking", [qs]).map((x) => x.id), ["a"]);
  assert.equal(call("all_settled", [qs]), false);
  assert.equal(call("all_settled", [[q({ id: "b", deferred: true })]]), true);
});

test("an empty question set is settled, not stuck", () => {
  assert.equal(call("all_settled", [[]]), true);
});

test("a thread ending on the human's message is our turn to answer", () => {
  const waiting = q({ id: "w", thread: [{ role: "you", text: "what would you pick?" }] });
  const done = q({
    id: "d",
    thread: [{ role: "you", text: "?" }, { role: "research", text: "created_at" }],
  });
  assert.deepEqual(call("awaiting_reply", [[waiting, done]]).map((x) => x.id), ["w"]);
});

test("delegation is only pending until it is answered", () => {
  const open = q({ id: "o", delegate_requested: true });
  const settled = q({ id: "s", delegate_requested: true, answer: "50" });
  assert.deepEqual(call("awaiting_decision", [[open, settled]]).map((x) => x.id), ["o"]);
});

test("an agent's pick records why, and clears the delegation", () => {
  const out = call("record_answer", [q({ delegate_requested: true }), "50", "agent", "covers a scroll"]);
  assert.equal(out.answered_by, "agent");
  assert.equal(out.reason, "covers a scroll");
  assert.equal(out.delegate_requested, false);
});

test("answering a deferred question un-defers it", () => {
  const out = call("record_answer", [q({ deferred: true }), "Web Project", "you", ""]);
  assert.equal(out.deferred, false);
  assert.equal(out.answered_by, "you");
});

test("taking an answer back keeps the reasoning that justified it", () => {
  const answered = call("record_answer", [q(), "50", "agent", "easiest to reverse"]);
  const out = call("reopen", [answered]);
  assert.equal(out.answer, null);
  assert.equal(out.answered_by, null);
  // The person overriding the pick should be able to read why it was made.
  assert.equal(out.reason, "easiest to reverse");
});

test("a new round keeps the conversation that was the reason a question was open", () => {
  const existing = [q({ id: "q1", thread: [{ role: "you", text: "what are the options?" }] })];
  const incoming = [{ id: "q1", question: "Which font licence did we buy?" }];
  const merged = call("merge", [existing, incoming]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].thread.length, 1, "thread survived the round");
  assert.equal(merged[0].question, "Which font licence did we buy?", "improved text wins");
});

test("a new round never reopens an answered question", () => {
  const existing = [q({ id: "q1", answer: "Web Project", answered_by: "you" })];
  const merged = call("merge", [existing, [{ id: "q1", question: "Which font licence?" }]]);
  assert.equal(merged[0].answer, "Web Project");
  assert.equal(merged[0].answered_by, "you");
});

test("a question absent from the new round still stands", () => {
  // Dropping it would lose an answer, or an open thread, with no trace.
  const existing = [q({ id: "old", answer: "yes" })];
  const merged = call("merge", [existing, [{ id: "new", question: "something else" }]]);
  assert.deepEqual(merged.map((m) => m.id).sort(), ["new", "old"]);
});

test("the summary separates what blocks from what was set aside", () => {
  const qs = [
    q({ id: "a", answer: "x" }),
    q({ id: "b" }),
    q({ id: "c", deferred: true }),
    q({ id: "d", thread: [{ role: "you", text: "?" }] }),
    q({ id: "e", delegate_requested: true }),
  ];
  const s = call("summarise", [qs]);
  assert.equal(s.total, 5);
  assert.equal(s.answered, 1);
  assert.equal(s.deferred, 1);
  assert.equal(s.threads_open, 1);
  assert.equal(s.delegated, 1);
  // b, d and e block; the answered one and the deferred one do not.
  assert.equal(s.blocking, 3);
});

// ─────────── found by review, not by running ───────────

test("state kept beside the questions survives a new round", () => {
  // The questions merged, but post_planning_questions still rebuilt the dict around
  // them field by field. Losing `confirmed` parked a task at "answered but not
  // confirmed" forever; losing `resume_log` reset the loop guard so it could never
  // trip; losing `promotion` made a promoted investigation undispatchable.
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import bridge

existing = {
    "confirmed": True,
    "resume_log": [{"at": "t", "question_ids": ["p1"]}],
    "promotion": {"mode": "implementation"},
    "questions": [{"id": "q1", "question": "a", "answer": "settled"}],
    "created_at": "first",
    "triage_repos": [{"project": "p", "repo": "r"}],
}
put = {}
def fake_request(method, path, body=None):
    if method == "GET":
        return existing
    put.update(body or {})
    return {}
bridge.mc_request = fake_request
bridge.mc_log_activity = lambda *a, **k: None

bridge.post_planning_questions("t1", [{"id": "q2", "question": "b"}])
print(json.dumps({
    "confirmed": put.get("confirmed"),
    "resume_log": len(put.get("resume_log") or []),
    "promotion": bool(put.get("promotion")),
    "created_at": put.get("created_at"),
    "repos": len(put.get("triage_repos") or []),
    "ids": sorted(q["id"] for q in put.get("questions") or []),
    "q1_answer": next((q.get("answer") for q in put["questions"] if q["id"] == "q1"), None),
}))
`;
  const r = JSON.parse(execFileSync("python3", ["-c", program], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }));

  assert.equal(r.confirmed, true, "a confirmed task does not un-confirm itself");
  assert.equal(r.resume_log, 1, "the loop guard keeps its history");
  assert.equal(r.promotion, true, "a promoted investigation stays promoted");
  assert.equal(r.created_at, "first", "the original creation time is not reset");
  assert.equal(r.repos, 1, "the repos already chosen are kept");
  assert.deepEqual(r.ids, ["q1", "q2"]);
  assert.equal(r.q1_answer, "settled");
});

test("a settled question stops costing a model call for its old thread", () => {
  // Its thread ends on a human message forever, so it was re-answered every tick.
  const qs = [
    q({ id: "answered", answer: "yes", thread: [{ role: "you", text: "?" }] }),
    q({ id: "deferred", deferred: true, thread: [{ role: "you", text: "?" }] }),
    q({ id: "open", thread: [{ role: "you", text: "?" }] }),
  ];
  assert.deepEqual(call("awaiting_reply", [qs]).map((x) => x.id), ["open"]);
});

test("research settles what it can answer, and only asks what it cannot", () => {
  // A question research can answer is not a question. Asking it anyway trains
  // people to click through, which is how the real ones stop being read.
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SWARM)})
import bridge

state = {"questions": [
  {"id": "settles", "question": "Which base branch?", "options": ["coda/new-ui", "master"],
   "thread": [{"role": "you", "text": "apps/new-ui only exists on coda/new-ui"}]},
  {"id": "asks", "question": "Which font licence did we buy?", "options": ["Host & Link", "Adobe"],
   "thread": [{"role": "you", "text": "which one?"}]},
]}
replies = {
  "settles": {"reply": "It follows from what you said.", "model": "m", "settles": "coda/new-ui", "recommends": ""},
  "asks":    {"reply": "Only you know what was purchased.", "model": "m", "settles": "", "recommends": "Host & Link"},
}
bridge.mc_request = lambda m, p, body=None: (state if m == "GET" else {})
bridge.mc_log_activity = lambda *a, **k: None
bridge._build_triage_context = lambda tid: ""
bridge._answer_thread = lambda task, q, ctx: replies[q["id"]]
bridge._decide_delegated = lambda *a, **k: None
bridge._service_task_questions({"id": "t1", "title": "x"})
out = {q["id"]: {"answer": q.get("answer"), "by": q.get("answered_by"),
                 "rec": q.get("recommended"), "reason": bool(q.get("reason"))}
       for q in state["questions"]}
print(json.dumps(out))
`;
  const r = JSON.parse(execFileSync("python3", ["-c", program], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }));

  // Determinable: recorded, attributed to the agent, with its reasoning kept.
  assert.equal(r.settles.answer, "coda/new-ui");
  assert.equal(r.settles.by, "agent");
  assert.equal(r.settles.reason, true, "why it settled is kept, so it can be argued with");

  // Only a person can answer what was bought — it stays open, with a suggestion.
  assert.equal(r.asks.answer, null);
  assert.equal(r.asks.rec, "Host & Link");
});
