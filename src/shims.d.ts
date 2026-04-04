declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig: unknown;
    resolvePath(path: string): string;
    registerHttpRoute(route: {
      path: string;
      auth: "gateway" | "plugin";
      match?: "prefix" | "exact";
      handler: (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => void | Promise<void>;
    }): void;
    registerHttpHandler(
      handler: (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => Promise<boolean | void>,
    ): void;
    registerTool(
      factory: (ctx: unknown) => {
        name: string;
        label?: string;
        description?: string;
        parameters: unknown;
        execute: (toolCallId: string, params: unknown) => Promise<unknown>;
      },
      options: { name: string },
    ): void;
    registerService(service: {
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }): void;
    logger: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
  }
}
