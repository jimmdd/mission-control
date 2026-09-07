# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-05
- Primary product surfaces: Ticket board, ticket detail, Settings, agent activity and review.
- Evidence reviewed: `public/ticket.html`, `public/app.js`, `public/settings.js`, existing route and render tests.

## Brand
- Personality: Direct, calm, operational, and honest about what the system knows.
- Trust signals: Concrete repository/app targets, current activity, actionable deliverables, and explicit disabled/error states.
- Avoid: Decorative process diagrams, duplicated status, optimistic placeholders, and stale precision.

## Product goals
- Goals: Make state, owner, execution target, deliverables, and the next useful action understandable at a glance.
- Non-goals: Replacing the detailed plan view with dashboard decoration or exposing generated worktrees as user choices.
- Success signals: A user can identify the canonical repo, open a preview/PR, and see what is happening without reading logs.

## Personas and jobs
- Primary personas: Operators supervising coding agents and reviewing their output.
- User jobs: Route work safely, answer product decisions, inspect progress, preview branches, and review deliverables.
- Key contexts of use: Desktop control-room view and narrow/mobile ticket checks.

## Information architecture
- Primary navigation: Inbox, Tickets, Swarm, Review.
- Core routes/screens: Board, `/ticket`, Settings.
- Content hierarchy: Ticket identity/brief and true workflow actions on the main card; execution target, status, autonomy, source-ticket link, and review action on the full-height right card; conversation plus a compact decisions/timeline rail below; plan details on demand. The ticket rail is always ordered Triage, Building, Review, Holding, Done, Closed.

## Design principles
- Principle 1: Use one primary representation of current state.
- Principle 2: Show only canonical execution targets and actions the system can actually perform.
- Tradeoffs: Prefer a short truthful summary and explicit disabled state over a detailed but stale process visualization.

## Visual language
- Color: Existing status tones—cyan planning, green building, indigo review, amber human attention/hold, neutral complete, restrained red closed. On ticket cards, amber is reserved for a concrete unresolved operator action rather than general technical failure.
- Typography: Compact utilitarian type with monospace operational labels.
- Spacing/layout rhythm: Dense but scannable cards and consistent action rows.
- Shape/radius/elevation: Flat restrained cards, borders and spacing over decoration.
- Motion: Limited to meaningful live-state cues; no decorative motion.
- Imagery/iconography: Small operational symbols with accompanying text.

## Components
- Existing components to reuse: `summary-action`, colored status card, safety dialog, plan drawer, dashboard preview service.
- New/changed components: Ticket-detail preview action; ticket-detail Close ticket safety action; single-line right-card execution target block with Repo/Base/App and an inline repository selector; autonomy as an unlabeled header badge; source-ticket navigation only through the ticket number on the right status card; a scrollable newest-first activity timeline with five visible rows; settled decisions collapsed by default; status card preserving its original height and visual rhythm; no inert conversation shortcut; ticket-rail “needs you” card state with an amber outline/wash and bell.
- Variants and states: Repository selection is editable in the right status card only before dispatch. Once work has started, Repo/Base/App are read-only facts and stale legacy triage receipts must not recreate a confirmation prompt.
- Variants and states: Preview is omitted while work is planning/building; review, testing, and done states show either Start preview or the active preview link, with in-page startup errors. Holding pauses execution without revoking preview when a preview, PR, completed plan, or review-phase receipt proves the build had already reached review.
- Variants and states: Open decisions stay expanded; once every decision is settled, the section collapses to its settled count. Activity excludes heartbeat/lease transport noise but does not merge or collapse real events.
- Variants and states: Checkpoints are full agent questions in the conversation, with the answer controls directly below the stream. The activity rail does not duplicate their prompt.
- Variants and states: A rail card needs the operator when it has an unanswered triage question, a pending pre-dispatch confirmation, a pending checkpoint/decision, or a review handoff. Paused and technically blocked states do not receive this treatment unless they also expose one of those human actions.
- Token/component ownership: Ticket page CSS variables and existing status/action classes.

## Accessibility
- Target standard: Keyboard-operable controls with text labels and non-color status meaning.
- Keyboard/focus behavior: Native links/buttons and visible focus behavior; unavailable preview actions are omitted.
- Contrast/readability: Preserve current high-contrast operational palette.
- Screen-reader semantics: Descriptive action labels and native disabled state. The rail bell has an accessible reason string, so the state never depends on icon shape or amber color alone.
- Reduced motion and sensory considerations: Meaning remains available without animation or color.

## Responsive behavior
- Supported breakpoints/devices: Existing desktop grid and narrow/mobile stack.
- Layout adaptations: Ticket actions stack full-width; status card follows summary in reading order.
- Touch/hover differences: Controls remain usable without hover-only disclosure.

## Interaction states
- Loading: Preview button changes to “Starting preview…” and disables repeat clicks.
- Empty: Omit missing PR actions and avoid invented progress.
- Error: Put preview startup errors in the ticket summary/status copy.
- Success: Open the ready local preview and refresh ticket state.
- Disabled: Omit preview actions until the build is ready for review.
- Completion: Open, held, and done tickets offer Close ticket behind the shared safety dialog. Close moves the record to the distinct Closed archive and synchronously cancels a linked Linear issue; a failed Linear write leaves Mission Control unchanged. The record is never deleted.
- Timeline: Keep the newest five events visible, allow keyboard and pointer scrolling for older history, and preserve individual timestamps/messages.
- Needs attention: Keep the ticket in its normal operational group, add the bell and amber card treatment, and clear both as soon as the human action resolves.
- Offline/slow network, if applicable: Keep the starting state until the request resolves; restore the action after failure.

## Content voice
- Tone: Short, factual, operational.
- Terminology: Repository, plan, build, review, preview, pull request. Done means the requested work completed; Closed means an operator ended or archived the ticket.
- Microcopy rules: Name navigation as “Go to…” and operations by their result; do not blame the user or describe unavailable data as an alert.
- Repository confirmation copy points directly to the right-side Repo dropdown; it never refers to the main ticket card.

## Implementation constraints
- Framework/styling system: Dependency-free HTML/CSS/JavaScript ticket page and existing TypeScript routes.
- Design-token constraints: Reuse existing custom properties and action classes.
- Performance constraints: Bounded repository discovery; no recursive filesystem sweeps.
- Compatibility constraints: Repository labels remain `project/repo`; local preview uses the existing server endpoint.
- Test/screenshot expectations: Render/API regression tests plus desktop and narrow live checks for UI changes.

## Open questions
- [ ] None for the current ticket-attention scope.
