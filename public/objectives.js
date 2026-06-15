/*
 * Autopilot / Objectives panel — self-contained, loaded after app.js.
 * Lists objectives, lets you approve a proposed scope, and reads the generated
 * wiki. Decoupled from app.js (only borrows the access token via window.__MC_TOKEN__).
 */
(function () {
  "use strict";

  const api = (path) => {
    const token = window.__MC_TOKEN__;
    if (!token) return `/api${path}`;
    return `/api${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  };

  async function get(path) {
    const res = await fetch(api(path), { headers: { "Sec-Fetch-Site": "same-origin" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function send(method, path, body) {
    const res = await fetch(api(path), {
      method,
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Minimal, safe Markdown → HTML (escape first, then a few inline/block rules).
  function md(src) {
    const lines = String(src || "").split("\n");
    let html = "", inList = false, inCode = false;
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    for (const raw of lines) {
      if (raw.trim().startsWith("```")) {
        if (inList) { html += "</ul>"; inList = false; }
        inCode = !inCode;
        html += inCode ? "<pre><code>" : "</code></pre>";
        continue;
      }
      if (inCode) { html += esc(raw) + "\n"; continue; }
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      const li = raw.match(/^\s*[-*]\s+(.*)$/);
      if (h) {
        if (inList) { html += "</ul>"; inList = false; }
        const lvl = h[1].length;
        html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      } else if (li) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${inline(li[1])}</li>`;
      } else if (raw.trim() === "") {
        if (inList) { html += "</ul>"; inList = false; }
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        html += `<p>${inline(raw)}</p>`;
      }
    }
    if (inList) html += "</ul>";
    if (inCode) html += "</code></pre>";
    return html;
  }

  let state = { open: false, objectives: [], selected: null, detail: null, pages: [], page: null };

  function statusColor(s) {
    return {
      scoping: "#9382ff", awaiting_approval: "#f59e0b", running: "#00e0c7",
      blocked: "#ef4444", paused: "#f59e0b", done: "#22c55e", failed: "#ef4444",
    }[s] || "#888";
  }

  async function refresh() {
    try { state.objectives = await get("/objectives"); } catch { state.objectives = []; }
    render();
  }

  async function select(id) {
    state.selected = id;
    state.page = null;
    try {
      state.detail = await get(`/objectives/${id}`);
      const doc = await get(`/objectives/${id}/document`);
      state.pages = (doc && doc.pages) || [];
    } catch { state.detail = null; state.pages = []; }
    render();
  }

  async function approve(id) {
    try { await send("POST", `/objectives/${id}/approve`, { decision: "approve" }); }
    catch (e) { alert("Approve failed: " + e.message); }
    await refresh();
    if (state.selected === id) await select(id);
  }

  async function createObjective() {
    const goal = (document.getElementById("mc-obj-new").value || "").trim();
    if (!goal) return;
    try { await send("POST", "/objectives", { goal }); document.getElementById("mc-obj-new").value = ""; }
    catch (e) { alert("Create failed: " + e.message); }
    await refresh();
  }

  async function openPage(slug) {
    const docId = state.detail && state.detail.document && state.detail.document.id;
    if (!docId) return;
    try { state.page = await get(`/documents/${docId}/pages/${slug}`); } catch { state.page = null; }
    render();
  }

  function render() {
    let root = document.getElementById("mc-obj-overlay");
    if (!state.open) { if (root) root.style.display = "none"; return; }
    if (!root) {
      root = document.createElement("div");
      root.id = "mc-obj-overlay";
      document.body.appendChild(root);
    }
    root.style.display = "flex";

    const list = state.objectives.map((o) => `
      <div class="mc-obj-item ${o.id === state.selected ? "sel" : ""}" data-id="${esc(o.id)}">
        <div class="mc-obj-dot" style="background:${statusColor(o.status)}"></div>
        <div class="mc-obj-item-body">
          <div class="mc-obj-goal">${esc(o.goal)}</div>
          <div class="mc-obj-meta">${esc(o.status)} · round ${o.round}/${o.max_rounds}</div>
        </div>
      </div>`).join("") || `<div class="mc-obj-empty">No objectives yet.</div>`;

    const d = state.detail;
    let detail = `<div class="mc-obj-empty">Select an objective.</div>`;
    if (d) {
      const scope = parseJson(d.approved_scope) || parseJson(d.proposed_scope);
      const subgoals = scope && Array.isArray(scope.sub_goals)
        ? `<ul>${scope.sub_goals.map((s) => `<li>${esc(s.title)} <span class="mc-obj-kind">${esc(s.kind || "research")}</span></li>`).join("")}</ul>` : "";
      const approveBtn = d.status === "awaiting_approval"
        ? `<button class="mc-obj-btn approve" data-approve="${esc(d.id)}">Approve scope &amp; run</button>` : "";
      const pageList = state.pages.length
        ? `<div class="mc-obj-pages">${state.pages.map((p) => `<button class="mc-obj-pagebtn ${state.page && state.page.slug === p.slug ? "sel" : ""}" data-slug="${esc(p.slug)}">${esc(p.title)}</button>`).join("")}</div>` : "";
      const pageBody = state.page
        ? `<div class="mc-obj-page"><h1>${esc(state.page.title)}</h1>${md(state.page.body_md)}</div>` : "";
      detail = `
        <div class="mc-obj-detail-head">
          <div class="mc-obj-goal big">${esc(d.goal)}</div>
          <div class="mc-obj-meta"><span class="mc-obj-dot" style="background:${statusColor(d.status)}"></span> ${esc(d.status)}${d.blocked_reason ? " — " + esc(d.blocked_reason) : ""}</div>
        </div>
        ${scope && scope.interpretation ? `<p class="mc-obj-interp">${esc(scope.interpretation)}</p>` : ""}
        ${subgoals}
        ${approveBtn}
        ${pageList}
        ${pageBody}`;
    }

    root.innerHTML = `
      <div class="mc-obj-modal">
        <div class="mc-obj-sidebar">
          <div class="mc-obj-title">AUTOPILOT OBJECTIVES <span class="mc-obj-x" id="mc-obj-close">×</span></div>
          <div class="mc-obj-new-row">
            <input id="mc-obj-new" placeholder="New objective goal…" />
            <button class="mc-obj-btn" id="mc-obj-create">+</button>
          </div>
          <div class="mc-obj-list">${list}</div>
        </div>
        <div class="mc-obj-detail">${detail}</div>
      </div>`;

    root.querySelector("#mc-obj-close").onclick = () => { state.open = false; render(); };
    root.querySelector("#mc-obj-create").onclick = createObjective;
    root.querySelector("#mc-obj-new").addEventListener("keydown", (e) => { if (e.key === "Enter") createObjective(); });
    root.querySelectorAll(".mc-obj-item").forEach((el) => { el.onclick = () => select(el.dataset.id); });
    const ab = root.querySelector("[data-approve]");
    if (ab) ab.onclick = () => approve(ab.dataset.approve);
    root.querySelectorAll(".mc-obj-pagebtn").forEach((el) => { el.onclick = () => openPage(el.dataset.slug); });
  }

  function parseJson(v) { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } }

  function mountButton() {
    if (document.getElementById("mc-obj-launch")) return;
    const btn = document.createElement("button");
    btn.id = "mc-obj-launch";
    btn.textContent = "◎ OBJECTIVES";
    btn.onclick = () => { state.open = true; refresh(); };
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountButton);
  } else {
    mountButton();
  }
})();
