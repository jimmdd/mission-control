/*
 * Settings / onboarding panel — self-contained, loaded after app.js.
 * Mission Control starts with zero config; this panel shows readiness and lets
 * you enable optional features (a generation key, Postgres knowledge memory,
 * integrations) by pasting values that are written to ~/.mission-control/.env.
 * Decoupled from app.js (only borrows the token via window.__MC_TOKEN__).
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
  async function post(path, body) {
    const res = await fetch(api(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  let state = { open: false, settings: null, conn: null };

  // Editable settings grouped into sections. `secret` masks the input.
  const SECTIONS = [
    {
      title: "Generation model (required for autopilot & triage)",
      note: "Pick one — Mission Control needs a single LLM for planning/scope/synthesis.",
      fields: [
        { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true },
        { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
        { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Gemini API key", secret: true },
      ],
    },
    {
      title: "Knowledge memory (optional)",
      note: "Cross-session memory needs PostgreSQL + pgvector. Leave blank to run without it.",
      fields: [
        { key: "CONTEXT_FABRICA_DSN", label: "Postgres DSN (postgresql://user@host/db)", secret: false },
      ],
    },
    {
      title: "Integrations (optional)",
      fields: [
        { key: "LINEAR_API_KEY", label: "Linear API key", secret: true },
        { key: "MISSION_CONTROL_NOTIFY_WEBHOOK", label: "Notification webhook URL", secret: false },
      ],
    },
  ];

  function statusDot(s) {
    const c = s === "connected" ? "#22c55e" : s === "needs_auth" ? "#f59e0b" : s === "not_connected" ? "#ef4444" : "#888";
    return `<span class="mc-set-dot" style="background:${c}"></span>`;
  }

  async function refresh() {
    try { state.settings = await get("/settings"); } catch { state.settings = null; }
    try { state.conn = await get("/connections"); } catch { state.conn = null; }
    render();
  }

  async function save(key) {
    const el = document.getElementById(`mc-set-${key}`);
    if (!el || !el.value.trim()) return;
    try {
      await post("/settings", { [key]: el.value.trim() });
      el.value = "";
      await refresh();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
  }

  function render() {
    let root = document.getElementById("mc-set-overlay");
    if (!state.open) { if (root) root.style.display = "none"; return; }
    if (!root) { root = document.createElement("div"); root.id = "mc-set-overlay"; document.body.appendChild(root); }
    root.style.display = "flex";

    const configured = (state.settings && state.settings.configured) || {};

    // Readiness summary from the connections probe.
    let readiness = '<div class="mc-set-empty">Readiness unavailable.</div>';
    if (state.conn) {
      const rows = [];
      for (const r of (state.conn.runtimes || [])) {
        const st = r.installed && r.authenticated ? "connected" : "not_connected";
        rows.push(`<div class="mc-set-status">${statusDot(st)} <b>${esc(r.name)}</b> <span>${esc(r.detail || (r.installed ? "" : "not installed"))}</span></div>`);
      }
      for (const s of (state.conn.sources || [])) {
        rows.push(`<div class="mc-set-status">${statusDot(s.status)} <b>${esc(s.name)}</b> <span>${esc(s.detail || s.status)}</span></div>`);
      }
      readiness = rows.join("");
    }

    const sections = SECTIONS.map((sec) => {
      const fields = sec.fields.map((f) => {
        const isSet = configured[f.key];
        return `
          <div class="mc-set-field">
            <label>${isSet ? "● " : "○ "}${esc(f.label)}</label>
            <div class="mc-set-row">
              <input id="mc-set-${esc(f.key)}" type="${f.secret ? "password" : "text"}"
                     placeholder="${isSet ? "configured — paste to replace" : "not set"}" />
              <button class="mc-set-btn" data-save="${esc(f.key)}">Save</button>
            </div>
          </div>`;
      }).join("");
      return `<div class="mc-set-section"><div class="mc-set-sectitle">${esc(sec.title)}</div>${sec.note ? `<div class="mc-set-note">${esc(sec.note)}</div>` : ""}${fields}</div>`;
    }).join("");

    root.innerHTML = `
      <div class="mc-set-modal">
        <div class="mc-set-head">SETTINGS <span class="mc-set-x" id="mc-set-close">×</span></div>
        <div class="mc-set-body">
          <div class="mc-set-col">
            <div class="mc-set-sectitle">Readiness</div>
            ${readiness}
          </div>
          <div class="mc-set-col">
            ${sections}
            <div class="mc-set-note" style="margin-top:14px;">Saved to <code>~/.mission-control/.env</code>. Restart a running bridge to apply changes to in-flight work.</div>
          </div>
        </div>
      </div>`;

    root.querySelector("#mc-set-close").onclick = () => { state.open = false; render(); };
    root.querySelectorAll("[data-save]").forEach((el) => { el.onclick = () => save(el.dataset.save); });
  }

  function mountButton() {
    if (document.getElementById("mc-set-launch")) return;
    const btn = document.createElement("button");
    btn.id = "mc-set-launch";
    btn.textContent = "⚙ SETTINGS";
    btn.onclick = () => { state.open = true; refresh(); };
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountButton);
  else mountButton();
})();
