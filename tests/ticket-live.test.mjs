// The page re-renders by replacing all of #root and polls every 15 seconds, so a
// poll landing while someone was typing threw the sentence away. The composer is
// one field for the whole conversation, so draft handling has to follow it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HTML = readFileSync(new URL("../public/ticket.html", import.meta.url), "utf8");
const BODY = /<script>([\s\S]*)<\/script>/.exec(HTML)[1].split("// ---- BOOTSTRAP ----")[0];

/** A DOM stub with a settable active element and a set of fields. */
function withDom(fields, activeTag = null) {
  const nodes = fields.map((f) => ({
    id: f.say ? "say" : "",
    dataset: f.say ? {} : { free: f.id },
    value: f.value ?? "",
    tagName: f.say ? "INPUT" : "TEXTAREA",
  }));
  const shim = `
    const __nodes = ${JSON.stringify(nodes)};
    const document = {
      activeElement: ${activeTag ? `{ tagName: ${JSON.stringify(activeTag)} }` : "null"},
      querySelector: (sel) => {
        if (sel === "#say") return __nodes.find(n => n.id === "say") || null;
        const m = /\\[data-(free|ask)="([^"]+)"\\]/.exec(sel);
        return m ? (__nodes.find(n => n.dataset[m[1]] === m[2]) || null) : null;
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
  assert.equal(withDom([{ say: true, value: "" }], "INPUT").isEditing(), true);
});

test("an unfocused draft still counts — clicking away does not discard it", () => {
  assert.equal(withDom([{ say: true, value: "Dalton Maag Host & Link" }]).isEditing(), true);
});

test("empty fields with nothing focused do not block the poll", () => {
  // Otherwise the page would stop updating the moment the composer rendered.
  assert.equal(withDom([{ say: true, value: "   " }]).isEditing(), false);
});

test("what is typed in the composer survives a render", () => {
  // The composer is one field for the whole conversation, so it keys on itself:
  // the text belongs to the person typing, not to whichever question was in focus.
  const m = withDom([{ say: true, value: "what changes between them?" }]);
  const drafts = m.captureDrafts();
  assert.deepEqual(Object.keys(drafts), ["say"]);

  m.__nodes.forEach((n) => { n.value = ""; });
  m.restoreDrafts(drafts);
  assert.equal(m.__nodes[0].value, "what changes between them?");
});

test("restore never overwrites what the new render already put there", () => {
  const m = withDom([{ say: true, value: "old draft" }]);
  const drafts = m.captureDrafts();
  m.__nodes[0].value = "something the render supplied";
  m.restoreDrafts(drafts);
  assert.equal(m.__nodes[0].value, "something the render supplied");
});

test("the poll is unforced and deliberate actions are forced", () => {
  // The interval must not pass force, or skipping while typing is pointless; and an
  // action must reload even though the field it just used still has text in it.
  assert.match(HTML, /setInterval\(\(\) => load\(\), 15000\)/);
  assert.doesNotMatch(HTML, /setInterval\(load,/);
  assert.match(HTML, /if \(!force && isEditing\(\)\) return;/);
  assert.ok((HTML.match(/load\(\{ force: true \}\)/g) || []).length >= 3);
});

test("the click handler is delegated once, not attached per render", () => {
  // wireConversation runs on every render; a document listener added there would
  // stack a new copy each time, and every click would fire N handlers.
  const delegated = (HTML.match(/document\.addEventListener\("click"/g) || []).length;
  assert.equal(delegated, 1);
});

test("every question action goes through one poster", () => {
  // The exits and the composer drifting apart is how the second button ends up
  // wired to nothing — which already happened once with two submits.
  assert.match(HTML, /async function postQuestionAction\(/);
  const posts = (HTML.match(/questions\/\$\{encodeURIComponent\(qid\)\}/g) || []).length;
  assert.equal(posts, 1, "exactly one place posts a question action");
});

test("a failed action keeps what was typed", () => {
  // onOk runs only after the response is checked, so a network blip never clears
  // the box.
  const idx = HTML.indexOf("async function postQuestionAction(");
  const fn = HTML.slice(idx, idx + 900);
  assert.ok(fn.indexOf("throw new Error") < fn.indexOf("onOk?.()"),
    "the throw comes first, so a failure never reaches the clear");
});
