# OpenClaw Integration

Mission Control is standalone-first. This folder contains the minimal optional adapter needed to expose the standalone service through OpenClaw.

Files:

- `plugin.ts` — HTTP proxy and tool registration layer
- `tools.ts` — optional OpenClaw tool wrappers that call the standalone Mission Control API
- `openclaw.plugin.json` — example plugin manifest

To use it, run Mission Control normally and point the integration at the standalone service URL, typically `http://127.0.0.1:18900`.
