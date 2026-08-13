// The page re-renders by replacing all of #root, and it polls every 15 seconds. So
// a poll landing while someone was typing threw the sentence away — and because
// wireQuestions runs on every render, it added another pair of document listeners
// each time, so after ten polls ten refresh handlers fired on every keystroke.
//
// These drive the page's own helpers headlessly against a fake DOM.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HTML = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
const BODY = /<script>([\s\S]*)<\/script>/.exec(HTML)[1].split("// ---- BOOTSTRAP ----")[0];

/** A DOM stub with a settable active element and a set of fields. */
function withDom(fields, activeTag = null) {
  const nodes = fields.map((f) => ({
    dataset: f.ask ? { ask: f.id } : { free: f.id },
    value: f.value ?? "",
    tagName: "TEXTAREA",
  }));
  const shim = `
    const __nodes = ${JSON.stringify(nodes)};
    const document = {
      activeElement: ${activeTag ? `{ tagName: ${JSON.stringify(activeTag)} }` : "null"},
      querySelector: (sel) => {
        const m = /\\[data-(free|ask)="([^"]+)"\\]/.exec(sel);
        if (!m) return null;
        return __nodes.find(n => n.dataset[m[1]] === m[2]) || null;
      },
      querySelectorAll: () => __nodes,
      addEventListener: () => {},
    };
    const location = { search: "" };
    class URLSearchParams { get() { return "x"; } }
    const CSS = { escape: (s) => s };
  `;
  return new Function(`${shim}\n${BODY}\nreturn { isEditing, captureDrafts, restoreDrafts, __nodes };`)();
}

test("a focused field counts as editing, so a poll does not wipe it", () => {
  const m = withDom([{ id: "q1", value: "" }], "TEXTAREA");
  assert.equal(m.isEditing(), true);
});

test("an unfocused draft still counts — clicking away does not discard it", () => {
  const m = withDom([{ id: "q1", value: "Dalton Maag Host & Link" }]);
  assert.equal(m.isEditing(), true);
});

test("empty fields with nothing focused do not block the poll", () => {
  // Otherwise the page would stop updating the moment a question rendered.
  const m = withDom([{ id: "q1", value: "" }, { id: "q2", value: "   " }]);
  assert.equal(m.isEditing(), false);
});

test("drafts survive a render that has to happen anyway", () => {
  const m = withDom([
    { id: "q1", value: "self-hosted, per the licence" },
    { id: "q2", ask: true, value: "what does that cost?" },
    { id: "q3", value: "" },
  ]);
  const drafts = m.captureDrafts();
  assert.deepEqual(Object.keys(drafts).sort(), ["ask:q2", "free:q1"]);

  // The re-render blanks every field; restore puts the typing back.
  m.__nodes.forEach((n) => { n.value = ""; });
  m.restoreDrafts(drafts);
  assert.equal(m.__nodes[0].value, "self-hosted, per the licence");
  assert.equal(m.__nodes[1].value, "what does that cost?");
  assert.equal(m.__nodes[2].value, "");
});

test("restore never overwrites what the new render already put there", () => {
  const m = withDom([{ id: "q1", value: "old draft" }]);
  const drafts = m.captureDrafts();
  m.__nodes[0].value = "the saved answer";
  m.restoreDrafts(drafts);
  assert.equal(m.__nodes[0].value, "the saved answer");
});

test("the poll is unforced and deliberate actions are forced", () => {
  // The interval must not pass force, or skipping while typing is pointless; and a
  // submit must reload even though the field it just saved still has text in it.
  assert.match(HTML, /setInterval\(\(\) => load\(\), 15000\)/);
  assert.doesNotMatch(HTML, /setInterval\(load,/);
  assert.ok((HTML.match(/load\(\{ force: true \}\)/g) || []).length >= 2);
  assert.match(HTML, /if \(!force && isEditing\(\)\) return;/);
});

test("the input listeners are attached once, not on every render", () => {
  // wireQuestions runs on every load; attaching there stacked a new pair each time.
  assert.match(HTML, /wireQuestions\.listening/);
  const inputListeners = (HTML.match(/addEventListener\("input"/g) || []).length;
  assert.equal(inputListeners, 1, "exactly one input listener registration site");
});
