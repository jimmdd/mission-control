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

  let state = { open: false, settings: null, conn: null, linearMeta: null, repoMeta: null };

  // Editable settings grouped into sections. `secret` masks the input.
  const SECTIONS = [
    {
      title: "Generation model (required for autopilot & triage)",
      note: "Pick one — Mission Control needs a single LLM for planning/scope/synthesis.",
      fields: [
        { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true },
        { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
        { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Gemini API key", secret: true },
        { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", secret: true },
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
      title: "Repo watcher (optional)",
      note: "Repos whose architectural changes feed the knowledge store. Leave repos empty to watch all under the root.",
      fields: [
        { key: "REPO_WATCH_ROOT", label: "Repo root folder (default ~/GitProjects)", secret: false },
        { key: "__repo_pull", type: "action", action: "repos" },
        { key: "REPO_WATCH_REPOS", label: "Repos to watch (empty = all discovered)", type: "multiselect", source: "repos" },
        { key: "__repo_scan", type: "action", action: "repo_scan" },
      ],
    },
    {
      title: "Integrations (optional)",
      fields: [
        { key: "LINEAR_API_KEY", label: "Linear API key", secret: true },
        { key: "__linear_pull", type: "action", action: "linear" },
        { key: "LINEAR_LABEL", label: "Linear labels to watch", type: "multiselect", source: "labels" },
        { key: "LINEAR_TRIAGE_LABEL", label: "Linear triage labels (optional)", type: "multiselect", source: "labels" },
        { key: "LINEAR_TEAM_KEYS", label: "Linear teams (optional)", type: "multiselect", source: "teams" },
        { key: "LINEAR_ASSIGNEES", label: "Linear assignees (optional)", type: "multiselect", source: "assignees" },
        { key: "LINEAR_INTERACTION", label: "Linear interaction level", type: "select", default: "intake",
          options: [
            { value: "intake", label: "Intake only — import issues, never write back" },
            { value: "updates", label: "Updates — also post progress / done comments" },
            { value: "full", label: "Full — also reply to @mention questions" },
          ] },
        { key: "__linear_sync", type: "action", action: "linear_sync" },
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
    const linearReady = state.settings && state.settings.configured && state.settings.configured.LINEAR_API_KEY;
    if (linearReady && !state.linearMeta) {
      try { state.linearMeta = await get("/linear/meta"); }
      catch (e) { state.linearMeta = { error: e.message }; }
    }
    if (!state.repoMeta) {
      try { state.repoMeta = await get("/repos/meta"); }
      catch (e) { state.repoMeta = { error: e.message }; }
    }
    render();
  }

  async function reloadLinearMeta() {
    state.linearMeta = null;
    await refresh();
  }
  async function reloadRepoMeta() {
    state.repoMeta = null;
    await refresh();
  }
  async function buildKnowledgeNow(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Scanning… (this can take a minute)"; }
    try {
      const r = await post("/repos/scan", {});
      alert("Knowledge scan complete:\n\n" + (r.output || "done"));
    } catch (e) {
      alert("Scan failed: " + e.message);
    }
    await refresh();
  }
  async function syncLinearNow(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Syncing Linear…"; }
    try {
      const r = await post("/linear/sync", {});
      alert("Linear sync complete:\n\n" + (r.output || "done"));
    } catch (e) {
      alert("Linear sync failed: " + e.message);
    }
    await refresh();
  }

  // Which pulled-meta object backs a multiselect source.
  function metaFor(source) { return source === "repos" ? state.repoMeta : state.linearMeta; }

  // Build {value,text} options for a multiselect from the pulled meta.
  function metaOptions(source) {
    const m = metaFor(source) || {};
    if (source === "labels") return (m.labels || []).map((l) => ({ value: l, text: l }));
    if (source === "teams") return (m.teams || []).map((t) => ({ value: t.key, text: `${t.key} · ${t.name}` }));
    if (source === "assignees") return (m.assignees || []).map((a) => ({ value: a.email, text: a.name ? `${a.name} <${a.email}>` : a.email }));
    if (source === "repos") return (m.repos || []).map((r) => ({ value: r.domain, text: r.domain }));
    return [];
  }

  async function saveMulti(key) {
    const panel = document.getElementById(`mc-ms-panel-${key}`);
    if (!panel) return;
    const vals = Array.from(panel.querySelectorAll("input[type=checkbox]:checked")).map((c) => c.value);
    try {
      await post("/settings", { [key]: vals.join(",") });
      await refresh();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
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

    const values = (state.settings && state.settings.values) || {};

    const sections = SECTIONS.map((sec) => {
      const fields = sec.fields.map((f) => {
        const isSet = configured[f.key];
        if (f.type === "action" && f.action === "repos") {
          const rm = state.repoMeta;
          const st = rm && rm.error ? `Repo scan failed: ${rm.error}`
            : rm ? `Found ${(rm.repos || []).length} repos under ${rm.root || "~/GitProjects"}`
            : "Loading…";
          return `
          <div class="mc-set-field">
            <button class="mc-set-btn" id="mc-repo-pull" style="width:100%">↻ Scan repos folder</button>
            <div class="mc-set-note">${esc(st)}</div>
          </div>`;
        }
        if (f.type === "action" && f.action === "repo_scan") {
          return `
          <div class="mc-set-field">
            <button class="mc-set-btn" id="mc-repo-scan" style="width:100%">⚙ Build knowledge now (scan watched repos)</button>
            <div class="mc-set-note">Runs extraction over the watched repos and stores facts in the knowledge base. First scan of a repo is a full index.</div>
          </div>`;
        }
        if (f.type === "action" && f.action === "linear_sync") {
          return `
          <div class="mc-set-field">
            <button class="mc-set-btn" id="mc-linear-sync" style="width:100%"${configured.LINEAR_API_KEY ? "" : " disabled"}>↻ Sync Linear now</button>
            <div class="mc-set-note">Pull issues and push status changes now, without waiting for the 5-minute cycle.</div>
          </div>`;
        }
        if (f.type === "action") {
          const st = !configured.LINEAR_API_KEY ? "Add a Linear API key to enable pickers."
            : state.linearMeta && state.linearMeta.error ? `Linear pull failed: ${state.linearMeta.error}`
            : state.linearMeta ? `Pulled ${(state.linearMeta.labels || []).length} labels · ${(state.linearMeta.teams || []).length} teams · ${(state.linearMeta.assignees || []).length} people`
            : "Loading…";
          return `
          <div class="mc-set-field">
            <button class="mc-set-btn" id="mc-linear-pull" style="width:100%"${configured.LINEAR_API_KEY ? "" : " disabled"}>↻ Refresh labels / teams / people from Linear</button>
            <div class="mc-set-note">${esc(st)}</div>
          </div>`;
        }
        if (f.type === "multiselect") {
          const selected = (values[f.key] || "").split(",").map((s) => s.trim()).filter(Boolean);
          const fmeta = metaFor(f.source);
          // No data pulled yet (no key / failed) → plain text fallback so it still works.
          if (!fmeta || fmeta.error) {
            return `
          <div class="mc-set-field">
            <label>${selected.length ? "● " : "○ "}${esc(f.label)}</label>
            <div class="mc-set-row">
              <input id="mc-set-${esc(f.key)}" type="text" value="${esc(selected.join(", "))}"
                     placeholder="set Linear API key, then Refresh — or type comma-separated" />
              <button class="mc-set-btn" data-save="${esc(f.key)}">Save</button>
            </div>
          </div>`;
          }
          const opts = metaOptions(f.source);
          const known = new Set(opts.map((o) => o.value));
          selected.forEach((v) => { if (!known.has(v)) opts.push({ value: v, text: `${v} (not in workspace)` }); });
          const summary = selected.length ? selected.join(", ") : "— none —";
          const checks = opts.length
            ? opts.map((o) => `<label class="mc-ms-opt"><input type="checkbox" value="${esc(o.value)}"${selected.includes(o.value) ? " checked" : ""}/> ${esc(o.text)}</label>`).join("")
            : '<div class="mc-set-note">No options found.</div>';
          return `
          <div class="mc-set-field">
            <label>${selected.length ? "● " : "○ "}${esc(f.label)}</label>
            <div class="mc-set-row">
              <div class="mc-ms">
                <div class="mc-ms-toggle" data-ms-toggle="${esc(f.key)}">${esc(summary)}</div>
                <div class="mc-ms-panel" id="mc-ms-panel-${esc(f.key)}" hidden>${checks}</div>
              </div>
              <button class="mc-set-btn" data-save-ms="${esc(f.key)}">Save</button>
            </div>
          </div>`;
        }
        if (f.type === "select") {
          const current = values[f.key] || f.default || (f.options[0] && f.options[0].value);
          const opts = f.options.map((o) =>
            `<option value="${esc(o.value)}"${o.value === current ? " selected" : ""}>${esc(o.label)}</option>`
          ).join("");
          return `
          <div class="mc-set-field">
            <label>● ${esc(f.label)}</label>
            <div class="mc-set-row">
              <select id="mc-set-${esc(f.key)}">${opts}</select>
              <button class="mc-set-btn" data-save="${esc(f.key)}">Save</button>
            </div>
          </div>`;
        }
        // Non-secret fields prefill their current value so it's visible/editable;
        // secret fields never echo back.
        const current = !f.secret && values[f.key] ? values[f.key] : "";
        return `
          <div class="mc-set-field">
            <label>${isSet ? "● " : "○ "}${esc(f.label)}</label>
            <div class="mc-set-row">
              <input id="mc-set-${esc(f.key)}" type="${f.secret ? "password" : "text"}"
                     value="${esc(current)}"
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
    root.querySelectorAll("[data-save-ms]").forEach((el) => { el.onclick = () => saveMulti(el.dataset.saveMs); });
    root.querySelectorAll("[data-ms-toggle]").forEach((el) => {
      el.onclick = () => {
        const p = document.getElementById(`mc-ms-panel-${el.dataset.msToggle}`);
        if (p) p.hidden = !p.hidden;
      };
    });
    const pull = root.querySelector("#mc-linear-pull");
    if (pull) pull.onclick = reloadLinearMeta;
    const repoPull = root.querySelector("#mc-repo-pull");
    if (repoPull) repoPull.onclick = reloadRepoMeta;
    const repoScan = root.querySelector("#mc-repo-scan");
    if (repoScan) repoScan.onclick = () => buildKnowledgeNow(repoScan);
    const linearSync = root.querySelector("#mc-linear-sync");
    if (linearSync) linearSync.onclick = () => syncLinearNow(linearSync);
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
