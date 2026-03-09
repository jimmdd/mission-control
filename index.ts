import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { MissionControlDB } from "./src/db.js";
import { registerRoutes } from "./src/routes.js";
import { registerTools } from "./src/tools.js";

interface PluginConfig {
  dbPath?: string;
}

function readPluginConfig(value: unknown): PluginConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const maybeConfig = value as Record<string, unknown>;
  if (typeof maybeConfig.dbPath === "string") {
    return { dbPath: maybeConfig.dbPath };
  }
  return {};
}

const missionControlPlugin = {
  id: "mission-control",
  name: "Mission Control",
  description:
    "Agent task management with SQLite, workspaces, and triage workflows",

  register(api: OpenClawPluginApi) {
    const config = readPluginConfig(api.pluginConfig);
    const dbPath = api.resolvePath(config.dbPath ?? "~/.openclaw/mission-control/mc.db");
    const db = new MissionControlDB(dbPath);

    registerRoutes(api, db);
    registerTools(api, db);

    api.registerService({
      id: "mission-control",
      start: async () => {
        db.initSchema();
        db.seedDefaults();
        api.logger.info("mission-control: database initialized");
      },
      stop: async () => {
        db.close();
        api.logger.info("mission-control: stopped");
      },
    });
  },
};

export default missionControlPlugin;
