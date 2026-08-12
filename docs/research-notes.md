# Research notes — prior art for Mission Control v2

External projects read while planning v2. Captured 10–11 Aug 2026.
Companion to the approved plan at `~/.claude/plans/kind-mixing-pixel.md` and the Slack design notes
in [`slack-adaptor.md`](./slack-adaptor.md).

**How to use this file.** Start at the steal list — it is the revisit index. Each row points at the
project entry that explains it. The last section records what we deliberately rejected, so we don't
re-litigate it in three months.

---

## Steal list — by phase

| # | Idea | From | Phase | Status |
|---|---|---|---|---|
| 1 | Plan as first-class data, not a file on disk | *(our own gap)* | **P0** | queued |
| 2 | Global concurrency cap + honour `parallel_groups` | *(our own gap)* | **P0** | queued |
| 3 | Host-side APFS clone (`cp -c`) of warm `node_modules` instead of reinstalling per worktree | pdb-env | **P1** | queued |
| 4 | Auth terminates before the translation layer; agents hold randomized internal keys, never real credentials | codex-router | **P1** | queued |
| 5 | Durable per-scope sandbox — tools and logins persist between sessions | qm | **P1** | queued |
| 6 | Security posture as one declared setting (`strict` / `auto` / `dangerous`) over a predeclared command policy | qm | **P1** | queued |
| 7 | Zero ambient authority — capabilities granted per step, not inherited from the environment | cloudflare-os | **P1** | queued |
| 8 | Read-only scouts need no VCS coupling — drop worktrees for the discovery ensemble | pdb-env | **P2** | queued |
| 9 | Sessions bootstrap from a catalog, transcripts flow back into it | Xirp | **P2 / P6** | queued |
| 10 | Surface-agnostic adaptor SPI; thread = ticket | qm + linear-sync precedent | **P3** | queued |
| 11 | Simulate-then-queue approvals — agent continues, human batches | cloudflare-os | **P4** | queued |
| 12 | Portable session envelope — harness swap without losing working state | Xirp | **P4** | queued |
| 13 | Rate-limit headers read without extra API calls → the trigger `fallbackProfile` lacks | codex-router | **P4** | queued |
| 14 | Master/worker where workers are visible and directly addressable | AgentGrid | **P4** | queued |
| 15 | Notes-as-shared-context — a durable surface every agent reads | AgentGrid | **P4** | queued |
| 16 | Ship the dumb-correct backend as the oracle; keep the fast one behind proof | pdb-env | *discipline* | adopt now |
| 17 | Deployment layers pattern — org config in `deploy/layers/`, core byte-identical upstream | qm | *later* | if MC is ever used by others |
| 18 | Boundary-level secret injection — sandbox holds a proxy token, real credential swapped at egress | iron-proxy | **P5** | queued |
| 19 | Default-deny egress allowlist per scope, with upstream IP deny lists (SSRF / DNS rebinding) | iron-proxy | **P5** | queued |
| 20 | Per-request egress audit — which rules matched, which secrets swapped | iron-proxy | **P5** | queued |
| 21 | MCP tool-call policy enforced at the network boundary, not by a CLI flag | iron-proxy | **P5** | queued |

---

## Xirp — Spotify

**Source:** <https://portal.spotify.com/blog/introducing-xirp> · closed source, no repo or licence
**Secondary:** [explainx analysis](https://www.explainx.ai/blog/spotify-xirp-vendor-neutral-agent-development-environment-2026)

### What it is

A vendor-neutral agentic development environment managing dozens of concurrent coding-agent sessions
across harnesses — Claude Code, Gemini CLI, Codex, self-hosted open-weight models. **Every session
runs in its own git worktree**, which is what makes "50+ parallel sessions on one codebase" tenable.

The real claim is that *context is decoupled from the harness*: switch tools mid-task and the working
state carries over, so jobs route to the best price-performance rather than to whoever you're locked
into.

Connected to Portal (Spotify's Backstage descendant), sessions **start** with organizational context
— component architecture, dependency graphs, ownership — and transcripts flow **back** into Portal
afterwards, plus an MCP/skills marketplace across teams.

### Worth stealing

- **The session envelope** as a first-class portable object, independent of launcher. We have
  profiles but not envelopes — a session is currently whatever tmux happens to be holding.
- **Catalog in, transcripts out.** We already own both halves — `mc-explore` and
  `swarm/knowledge-distill.py` — but they are not wired as a mandatory loop around each run.

### Skip

Org-scale catalog and marketplace. Treat the numbers cautiously: adoption is self-reported (1,300+
engineers in one place, "thousands across 36,000+ sessions" in another), with no public repo,
licence, or benchmark.

---

## AgentGrid

**Source:** <https://agentgrid.sh> · desktop app

### What it is

One infinite canvas per project — pan, zoom, launch agents with ⌘1–9, spaces with ⌘T, minimap, undo,
everything persisted to `.agent-grid` on disk so a restart doesn't kill mid-task state. Nine
harnesses side by side (Claude, Codex, OpenCode, Antigravity, Kimi, Grok, Devin, Cursor, Pi).

Panes are not only agents — terminal, VS Code, git, and Chromium with DevTools share the canvas, and
**agents read the other panes**: notes, terminal output, each other. A master agent splits work among
workers, and you can read every worker's full conversation and send any of them a direct follow-up.

Names its loop explicitly: **Plan** (notes / master conversation) → **Implement** (visible workers) →
**Review** (diffs). Shows provider usage limits so work can move off a harness about to rate-limit.

### Worth stealing

- **Master/worker where workers are visible and directly addressable** — exactly what our blocking
  parent→child delegation (`src/routes.ts:1201`) lacks.
- **Notes-as-shared-context.** A durable surface every agent reads is the cheapest possible
  blackboard, and the closest thing on the market to the pre-phase we're building.
- **Provider-limit awareness as a routing input.** See codex-router for the mechanism.

### Skip

The canvas as primary metaphor. Freeform space is good for exploration and bad for determinism,
auditability and unattended runs — which is where Mission Control's value sits.

---

## qm — YC Software

**Source:** <https://github.com/yc-software/qm> · open source

### What it is

Not a coding-task orchestrator — a multiplayer agent harness for *work*. The unit is the **scope**:
every person and every channel gets its own memory, files, keychain view, permissions, crons, web
apps and **durable sandbox** where installed tools and logins persist between sessions.

Headless TypeScript/Fastify core, Postgres for sessions/memory/queue, swappable harnesses beneath
(Pi, OpenCode, Claude Code), optional surfaces (Slack, web UI, admin) over one HTTP API and one
identity.

Security is a declared posture — **Strict** (approve every call), **Auto** (classifier screens
external data), **Dangerous** (no screening) — over a universal predeclared command policy blocking
destructive operations at all levels.

Organizations create their own deployment repo depending on `@yc-software/qm`, with everything custom
in `deploy/layers/`, so the core stays byte-identical upstream.

### Worth stealing

- **The durable sandbox.** Our worktrees are disposable, so every agent re-pays setup cost and
  re-learns the environment. A per-scope persistent container that worktrees mount into is a large,
  cheap win.
- **Security posture as one declared setting** rather than ad-hoc prompt instructions — and the same
  posture governing every harness.
- **The layers deployment pattern**, if Mission Control is ever used by anyone but us.

### Skip

Human multiplayer and the Slack-as-workspace surface. Our scopes are repos and objectives, not
employees. **This is the explicit non-goal: do not rebuild qm.**

---

## cloudflare-os

**Source:** <https://github.com/cloudflare/cloudflare-os> · open source

### What it is

An "OS" for AI work on Workers. Each workspace is a Durable Object, each app a Dynamic Worker Facet.
**Gadgets** are per-user sandboxed app instances — you run your own private copy, so an agent
rewriting its code is safe. **Blueprints** share the code as a template rather than hosting it
centrally.

The two ideas that matter here are **Gatekeepers** and **Code Mode**:

- **Gatekeepers** are "supercharged MCP servers" mediating all external access — wrapping APIs,
  handling OAuth, narrowing what's reachable, logging everything — and they implement **asynchronous
  human approval by simulation**: the side effect is simulated, the real action queued, the agent
  *keeps going*, and the human approves or denies later in a batch.
- Access is **capability-based**: an agent starts with *zero* permissions and only ever holds what
  was explicitly introduced.
- **Code Mode** agents accomplish tasks by writing and running code rather than emitting one tool
  call per step. Every gadget automatically exposes an agent-callable RPC API.

### Worth stealing

- **Simulate-then-queue approvals** — a direct upgrade to `task_checkpoints`, which today parks the
  task in `on_hold` and stops the agent dead. Worktrees make the optimistic branch cheap to discard.
- **Zero ambient authority** — grant capabilities per plan step (these paths, these tools, this
  network) instead of inheriting the operator's environment through profile `env`.
- **Our own API is the agent API.** We're close: the CLI and dashboard both go through `/api/*`. Make
  agents first-class callers rather than shell-scripted `curl` embedded in prompts
  (`swarm/bridge.py:1022`).

### Skip

The Workers / Durable Object substrate, unless Mission Control goes cloud. Locally, container +
worktree is the equivalent.

---

## pdb-env — filesystem isolation without worktrees or containers

**Source:** <https://pdb-env-research.swyxio.workers.dev> · swyx · 10 Aug 2026

### What it is

macOS-first research into giving each coding agent a private, writable copy of a pinned immutable
base — no git worktrees, no containers, no privileged mounts. Framing question: *"Can the filesystem
be the interface without being the authority?"*

Validated by running Codex and Claude concurrently over the same files: both edited `shared.txt`,
deleted and renamed base files, created nested structures, and neither saw the other's changes. Base
stayed pinned at digest `a8cd…807ff` across 60 Node workload runs.

| Backend | Verdict | Reason |
|---|---|---|
| Full-copy | **Chosen** | Portable, inspectable, native watcher support |
| APFS clone | Experimental | *"Promising startup and physical growth"* but *"must prove forced clone success without silent fallback"* |
| AgentFS 0.6.4 | Rejected | Timed out before mutations on the tested macOS |
| Git worktree | Optional | *"Requires Git and couples workspace mechanics to VCS state"* |

Benchmarks: npm install 3.7s p50 / 10.7s p95 · pnpm 3.5s p50 / 11.7s p95.

### The load-bearing distinction

> *"Workspace isolation is not hostile-code containment."*

Five concerns usually mushed together, separated: workspace visibility, dependency graphs, runtime
collisions, authority, and security. Private directories stop *"accidental overwrites and
cross-visible dirt"*; they do not stop *"a same-user process from reading another path, opening a
socket, or accessing credentials."* Containers answer security; directories answer workspace.

**This validates our two-layer split.** Colima container = containment. Worktree = workspace. We are
not conflating them.

### Where the worktree critique lands — and where it doesn't

**Doesn't land on step agents (P1).** For us VCS coupling is the feature. The worktree *is* the
deliverable: GSD commits atomically, dependent steps branch-chain off each other
(`swarm/bridge.py:1528-1534`), and the PR comes off that branch. Remove Git and you remove the work
product.

**Does land on the discovery scouts (P2).** Those agents are read-only — they never commit, branch,
or open a PR. "3–4 read-only scouts in one shared worktree" pays the whole VCS coupling cost for zero
benefit. They should read the repo directly or share one cheap copy.

### Worth stealing

`swarm/spawn-agent.sh:166-172` runs `pnpm`/`yarn`/`npm install` in **every new worktree** — the
dominant cost in time and disk when steps run in parallel on a 24 GB mini. An APFS clone (`cp -c`) of
a warm `node_modules` is near-instant and near-zero disk until written.

Two caveats:

1. swyx's own: a clone that silently degrades to a full copy hides corruption. **Force it and fail
   loudly.**
2. Ours: APFS clone semantics only exist on APFS. Inside the Colima container the filesystem is the
   Linux VM's. This must happen **host-side in `spawn-agent.sh`, before the `docker exec`**, on the
   bind-mounted worktree root.

---

## codex-router — a local multi-provider gateway for Codex

**Source:** <https://github.com/duolahypercho/codex-router> · MIT · ~1.5k stars · TypeScript + Python

### What it is

A local credential-isolating gateway making 40+ models across ~25 providers appear in Codex's native
model picker beside the GPT models. Community project, not official.

```
Codex (Responses API) → LiteLLM (protocol translation) → provider adapters → external APIs
```

Binds `127.0.0.1:4102`; LiteLLM on 4100; OAuth/API-key handling on 4101-4103. Integrates by adding
managed blocks to Codex's `config.toml`:

```toml
openai_base_url    = "http://127.0.0.1:4102/_codex-router/<capability>/v1"
model_catalog_json = "/path/to/.codex/codex-router/merged-models.json"
```

Codex keeps ownership of agent loops, tools, permissions and conversation state — the router only
moves protocol and credentials. Providers span OAuth sessions (Kimi, Grok, GitHub Copilot), API keys
(DeepSeek, Anthropic, OpenRouter, Groq, Mistral), subscription plans (Qwen, ClinePass, opencode,
Command Code) and local inference (Ollama). Needs Node 22.19+ and Python 3.10+.

### Worth stealing

1. **The missing signal for `fallbackProfile`.** We have per-profile `fallbackProfile`
   (`swarm/spawn-agent.sh:94-105`) but nothing to trigger it — Mission Control has zero rate-limit
   awareness. codex-router *"reads rate-limit headers from compatible providers without extra API
   calls."* That is exactly the input the harness-swap half of the Session Envelope (P4) needs. Lift
   the idea whether or not we adopt the router.
2. **Its credential model is the shape we want for scoped secrets (P1).** Auth terminates *before*
   traffic reaches LiteLLM; only randomized internal keys pass forward, so provider credentials never
   enter the translation layer. Same principle as "the scope declares what it needs and the agent
   never holds the real key." State files mode 600 on POSIX, ACL-restricted on Windows;
   browser-origin requests rejected; health endpoints sanitise errors.
3. **Cheap model breadth.** Our profiles already inject `OPENAI_BASE_URL` / `OPENAI_API_KEY`
   (`swarm/spawn-agent.sh:207-213`) — a crude version of the same idea.

### Caveats

- **Codex only.** Our `claude` and `pi` launchers don't go through it — a per-launcher improvement,
  not a universal routing layer.
- **Networking under Colima.** Host-bound on `127.0.0.1`; agents inside the scope container reach it
  via `host.docker.internal` or the gateway IP, which must be explicit and belongs in P1's per-step
  network allowlist.
- **Community project, fast-moving area,** and it edits Codex's `config.toml` via managed blocks.
  Pin a version rather than tracking main.

---

---

## iron-proxy — Paradigm

`https://github.com/paradigmxyz/iron-proxy`

### What it is

A default-deny egress firewall for untrusted workloads, framed exactly at our problem:
*"CI jobs, AI coding agents, and sandboxed containers can make arbitrary outbound
requests."* A single binary and one YAML file. It targets Claude Code, Cursor and Codex
by name.

The mechanism is a MITM proxy with an embedded DNS server. Containers point their
resolver at it, every hostname resolves to the proxy's own address, and traffic is
steered through it without the workload being configured — no per-agent setup to forget.
HTTP CONNECT, SOCKS5 and kernel TPROXY exist for stronger enforcement.

### Worth stealing

**Boundary-level secret injection.** The sandbox holds `proxy-token-123`; the proxy swaps
it for the real credential at egress, sourced from env, a file, AWS Secrets Manager, SSM
or 1Password. The agent never possesses a usable key.

This is the answer to a failure we hit for real today. A Linear API key was pasted into
chat to unblock the run and is now permanently in a transcript; separately I passed on a
false "rotate your Codex token" warning because a hook flagged output I had not actually
read. Both stop mattering if agents never hold real credentials. It generalises
codex-router's idea (#4 above) from one provider to every outbound call, and it is the
only mechanism here that makes "the agent leaked a key" structurally impossible rather
than merely discouraged.

**Default-deny allowlist per scope.** Matching domains and CIDRs pass, everything else
gets a 403. A scope already owns a container in P5; the allowlist is the natural
companion — this repo's package registry and API, nothing else. Upstream IP deny lists
close SSRF and DNS-rebinding, which matters because agents fetch URLs out of tickets, and
ticket text is attacker-influenceable by anyone who can edit the ticket.

**Per-request audit.** Structured JSON showing which rules matched and which secrets were
swapped. That is our `events` table with real content, and it answers "what did this
agent actually reach?" — which today we cannot answer at all.

**MCP tool-call policy, default-deny.** We already restrict the design summarizer to a
read-only tool allowlist, but it is enforced by a CLI flag we pass and the model runs
behind. Enforcing at the network boundary means a prompt injection inside a Paper file
cannot widen its own tool surface. Given that summarizer reads untrusted design content,
this is the right layer for it.

### Skip

**The LLM `judge` transform.** Same reasoning that cut the judge from our plan: highest
cost, least certain payoff. Deterministic allowlists are the point — putting a model back
in the enforcement path reintroduces exactly what we removed from verification today.

### Cost

A second always-on process on a 24 GB box, plus MITM certificate distribution into every
container. Worth it only once scopes have containers (P5); pointless before.

## Deliberately not taking

Recorded so we don't re-open these without new information.

| Rejected | Why | Revisit when |
|---|---|---|
| **Apple `container`** as the runtime | 1 GB default floor per container, per-container VM kills density under concurrency, incomplete memory ballooning (Apple's own docs), ~32.6 MB/s bind mounts vs OrbStack's ~548. Wrong trade on a 24 GB box whose workload is source-mounting. | Ballooning completes and virtiofs throughput improves |
| **OrbStack** | Best bind-mount throughput and a drop-in `docker` CLI swap, but ~1.6 GB idle is 6.7% of 24 GB, and it's a paid licence commercially. | Colima's virtiofs becomes the measured bottleneck |
| **Dropping git worktrees** (pdb-env's model) | For step agents the worktree *is* the deliverable — atomic GSD commits, branch-chaining between dependent steps, the PR. | Never for step agents; already adopted for P2 scouts |
| **AgentFS** | Rejected upstream by swyx — timed out before mutations on tested macOS. | Upstream reports it working |
| **Rebuilding qm** | Explicit non-goal. Our scopes are repos and objectives, not employees. Take the sandbox and posture ideas, not the multiplayer workspace. | — |
| **Workers / Durable Objects substrate** | Only meaningful if Mission Control goes cloud. Container + worktree is the local equivalent. | If MC is ever hosted |
| **Panel + red team + judge as an early phase** | Two weeks for the least certain payoff, and it was the part that made the UI confusing in mock review. | After P0–P4 are proven and plan quality is the measured bottleneck |
| **iron-proxy's LLM `judge` transform`** | A model back in the enforcement path is what we just removed from verification. Deterministic allowlists are the point. | If allowlists prove too coarse in practice |
