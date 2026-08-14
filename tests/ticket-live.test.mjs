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
  // stack a new copy each time, and every click would fire N handlers. Two now:
  // question actions and rail navigation, both wired at bootstrap and never again.
  const delegated = (HTML.match(/document\.addEventListener\("click"/g) || []).length;
  assert.equal(delegated, 2);
  const boot = HTML.split("// ---- BOOTSTRAP ----")[1];
  assert.match(boot, /wireQuestionActions\(\);/);
  assert.match(boot, /wireRailNavigation\(\);/);
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

// load() is the only function that assembles the page, and nothing was driving it:
// every other test called a renderer directly. So it kept calling renderQuestions
// long after that was deleted, and the page died with "renderQuestions is not
// defined" while 229 tests passed.

test("load builds the page without calling anything that no longer exists", async () => {
  const calls = [];
  const el = () => ({
    innerHTML: "", value: "", dataset: {}, tagName: "DIV",
    scrollTop: 0, scrollHeight: 0,
    addEventListener() {}, closest: () => null, querySelector: () => null,
  });
  const root = el();
  const shim = `
    const __root = ${"arguments"}; // placeholder, replaced below
  `;
  // A DOM stub just complete enough for one render pass.
  const fn = new Function("__root", "__fetch", "__calls", `
    const document = {
      activeElement: null,
      querySelector: (s) => s === "#root" ? __root : null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    };
    const location = { search: "?id=t1" };
    class URLSearchParams { constructor(){} get(){ return "t1"; } }
    const CSS = { escape: (s) => s };
    const fetch = __fetch;
    const setInterval = () => {};
    ${BODY}
    return load({ force: true }).then(() => __root.innerHTML);
  `);

  const body = {
    "/api/tasks/t1": { id: "t1", title: "MET-635", status: "planning", triage_state: JSON.stringify({
      questions: [{ id: "p1", source: "planner", becomes: "D-01", question: "Which licence?",
                    options: ["Host & Link"] }],
    }) },
    "/api/tasks/t1/plan": { plan: null, progress: null },
    "/api/tasks/t1/activities": [],
  };
  const fakeFetch = async (url) => {
    calls.push(url);
    const key = Object.keys(body).find(k => url.startsWith(k) && url.length === k.length);
    return { ok: true, json: async () => body[key] ?? {} };
  };

  const html = await fn(root, fakeFetch, calls);
  // The real failure was a ReferenceError inside the try, caught and rendered as
  // "Couldn't load this ticket" — so an error string in #root is the assertion.
  assert.doesNotMatch(html, /Couldn't load this ticket/, html.slice(0, 200));
  assert.match(html, /Which licence\?/, "the question reached the page");
  assert.match(html, /id="say"/, "and so did the composer");
});

// The page replaced all of #root every fifteen seconds whether or not anything had
// changed, and forced the stream to the bottom on every render — so it moved under
// whoever was reading it, folded away anything they had opened, and lost their place.

test("a poll that changes nothing does not touch the DOM", () => {
  assert.match(HTML, /const key = JSON\.stringify\(/);
  assert.match(HTML, /if \(!force && key === lastRenderKey\) return;/);
  // Forced loads still render: they follow an action that changed something.
  const idx = HTML.indexOf("key === lastRenderKey");
  assert.ok(HTML.slice(idx - 200, idx).includes("force"), "the guard is skipped when forced");
});

test("the stream follows the conversation only for someone already at the bottom", () => {
  // Yanking a reader back to the newest message on every poll is how the page ends
  // up moving under them.
  assert.match(HTML, /if \(!keptScroll \|\| keptScroll\.atBottom\) stream\.scrollTop = stream\.scrollHeight;/);
  assert.match(HTML, /else stream\.scrollTop = keptScroll\.top;/);
  assert.match(HTML, /atBottom: streamEl\.scrollHeight - streamEl\.scrollTop - streamEl\.clientHeight < 40/);
});

test("a group the reader opened stays open across a render", () => {
  assert.match(HTML, /details\.csettled\[open\]/);
  assert.match(HTML, /setAttribute\("open", ""\)/);
});

// Switching tickets in the rail reloaded the whole document — refetching the page,
// the rail, and every ticket in it, to change one column.

test("the rail switches tickets in place, without a document load", () => {
  assert.match(HTML, /function wireRailNavigation\(/);
  assert.match(HTML, /history\.pushState/);
  assert.match(HTML, /addEventListener\("popstate"/, "back and forward still move between tickets");
  // Delegated once at the document, like the other handler — the rail is replaced
  // on every render, so per-render listeners would stack.
  assert.equal((HTML.match(/document\.addEventListener\("click"/g) || []).length, 2);
});

test("a click the browser should own is left to the browser", () => {
  // Middle-click, ⌘-click and "open in new tab" have to keep working, or the rail
  // stops behaving like links and people notice immediately.
  const idx = HTML.indexOf("function wireRailNavigation(");
  const fn = HTML.slice(idx, idx + 900);
  assert.match(fn, /ev\.button !== 0/);
  assert.match(fn, /metaKey/);
  assert.match(fn, /ctrlKey/);
  assert.match(fn, /shiftKey/);
});

test("switching tickets drops what belonged to the last one", () => {
  // Carried over, the new ticket opens focused on a question that is not on it.
  const idx = HTML.indexOf("function goToTicket(");
  const fn = HTML.slice(idx, idx + 700);
  for (const reset of ["focusedQuestion = null", "selectedStep = null", "planOpen = false",
                       "lastRenderKey = null", "loaded: false"]) {
    assert.ok(fn.includes(reset), `goToTicket must reset ${reset}`);
  }
});
