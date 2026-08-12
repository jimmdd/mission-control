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
