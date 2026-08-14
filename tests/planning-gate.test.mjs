// Two gates in `process_planning_tasks`, both of which failed silently and both
// of which were found by watching a real ticket sit still.
//
// A ticket with no questions has no answers, so `if not answers: continue` skipped
// it forever. That is not a rare shape: triage passing a ticket as ready posts no
// questions, and a spawn failure returns such a ticket to `planning` — where it
// then sat, polled every 60 seconds, while its own activity log promised it would
// "retry on the next cycle".
//
// The confirm gate lived inside `if state.get("questions")`, so the one path with
// no human gate was the one where triage was most confident: a ticket it waved
// through reached a branch, a worktree and a tmux session with nobody asked.
//
// bridge.py imports heavily at module scope, so these drive the source rather than
// the runtime — the conditions are what regressed, and they are what is asserted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const BRIDGE = readFileSync(fileURLToPath(new URL("../swarm/bridge.py", import.meta.url)), "utf8");

/** The body of one top-level def, up to the next one. */
function body(name) {
  const start = BRIDGE.indexOf(`def ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  const rest = BRIDGE.slice(start + 1);
  const end = rest.search(/\ndef [a-zA-Z_]/);
  return end === -1 ? rest : rest.slice(0, end);
}

test("a ticket with no questions is not skipped for having no answers", () => {
  const fn = body("process_planning_tasks");
  // The bare form is what wedged the demo ticket.
  assert.doesNotMatch(fn, /^\s*if not answers:\s*$/m,
    "an unconditional `if not answers: continue` skips every question-less ticket");
  assert.match(fn, /has_questions and not answers/,
    "the gate belongs on whether anything is still open, not on whether anyone answered");
});

test("confirmation is required whether or not triage asked anything", () => {
  const fn = body("process_planning_tasks");
  const confirmAt = fn.indexOf('.get("confirmed")');
  const questionsAt = fn.indexOf('if state and state.get("questions"):');
  assert.ok(confirmAt > -1, "there is still a confirm gate");
  assert.ok(questionsAt > -1, "and still a questions branch");

  // The confirm check must not be indented inside the questions branch. Compare the
  // indentation of the line each sits on: nested would be deeper.
  const lineOf = i => fn.slice(fn.lastIndexOf("\n", i) + 1, fn.indexOf("\n", i));
  const indent = s => s.length - s.trimStart().length;
  assert.ok(indent(lineOf(confirmAt)) <= indent(lineOf(questionsAt)),
    "the confirm gate is nested inside `if questions` again — question-less tickets skip it");
});

test("a question-less ticket is given something to confirm", () => {
  // Triage passing a ticket as ready persists no state at all, so there was no
  // object to write `confirmed` onto and the gate could never be satisfied.
  const fn = body("_ensure_confirmable");
  assert.match(fn, /triage-state/, "it writes a triage state");
  assert.match(fn, /"confirmed": False/);
  assert.match(fn, /questions/, "with an explicit question list, so the shape is complete");
  // Written once. Re-writing every poll would clobber whatever a human just did.
  assert.match(fn, /if state and state\.get\("questions"\) is not None:\s*\n\s*return/,
    "an existing state is left alone");
  // And it says so on the ticket, or the wait is invisible.
  assert.match(fn, /mc_log_activity/);
});

test("the human is told what the ticket is waiting for", () => {
  const fn = body("_ensure_confirmable");
  assert.match(fn, /Confirm on the ticket/i);
  // new_triage_question is the type the server turns into a notification — an
  // "updated" would be one more line in a log nobody reads.
  assert.match(fn, /"new_triage_question"/);
});

test("triage records its assessment even when it has nothing to ask", () => {
  // `post_planning_questions` is the only writer of triage state and it ran only
  // on the not-ready branch, so a ticket triage passed as ready kept nothing: no
  // reasoning, no repos, no trace of the judgement that skipped human review.
  // Three visible costs followed — the page could not tell "triage read this and
  // had no questions" from "triage never ran"; the repos it chose were discarded
  // so identify_repos re-ran once a minute; and there was nowhere for `confirmed`
  // to be written, so the gate could not be satisfied.
  const at = BRIDGE.indexOf('repos = triage.get("repos", repos)');
  assert.ok(at > -1, "the ready path is still where it was");
  const ready = BRIDGE.slice(at, at + 2200);
  assert.match(ready, /post_planning_questions\(task_id, \[\], triage_result=triage\)/,
    "the ready path must persist its assessment");
});

test("an empty question list does not post a 'needs clarification' activity", () => {
  // Otherwise recording the assessment would tell the user work is blocked on them
  // when triage's whole finding was that nothing is.
  const fn = body("post_planning_questions");
  const gate = fn.slice(0, fn.indexOf("now = datetime"));
  assert.match(gate, /display_qs = \[q for q in questions if not q\.get\("answer"\)\]/);
  assert.match(gate, /if display_qs:/, "the activity is posted only when there is something to show");
});
