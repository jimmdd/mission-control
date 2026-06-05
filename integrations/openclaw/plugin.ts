import { request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "./sdk-shim.js";
import { registerTools } from "./tools.js";

const MC_URL = process.env.MISSION_CONTROL_URL ?? "http://127.0.0.1:18790";

const missionControlPlugin = {
  id: "mission-control",
  name: "Mission Control",
  description: "Optional OpenClaw proxy for the standalone Mission Control service",

  register(api: OpenClawPluginApi) {
    registerTools(api);

    api.registerHttpRoute({
      path: "/ext/mission-control",
      auth: "plugin",
      match: "prefix",
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const incomingPath = req.url ?? "/";
        const normalizedPath = incomingPath.replace(/^\/ext\/mission-control/, "") || "/";
        const target = new URL(normalizedPath, MC_URL);
        const proxyReq = request(target, {
          method: req.method,
          headers: { ...req.headers, host: target.host },
        }, proxyRes => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Mission Control service unavailable" }));
          }
        });
        req.pipe(proxyReq);
      },
    });

    api.registerService({
      id: "mission-control",
      start: async () => {
        try {
          const healthRes = await fetch(`${MC_URL}/health`);
          if (healthRes.ok) {
            api.logger.info("mission-control: connected to standalone service");
          } else {
            api.logger.error("mission-control: standalone service returned non-OK health");
          }
        } catch {
          api.logger.error(`mission-control: standalone service unreachable at ${MC_URL}`);
        }
      },
      stop: async () => {
        api.logger.info("mission-control: proxy stopped");
      },
    });
  },
};

export default missionControlPlugin;
