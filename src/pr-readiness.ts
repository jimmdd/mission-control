import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PrReadiness {
  status: string;
  reason: string;
  head?: string;
  base?: string;
  baseRefName?: string;
}

export function checkPrReadiness(url: string): Promise<PrReadiness> {
  const gate = fileURLToPath(new URL("../swarm/pr_readiness.py", import.meta.url));
  return new Promise((resolve) => {
    execFile("python3", [gate, "check", url], { timeout: 90_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      try {
        if (error) throw error;
        const result = JSON.parse(stdout) as PrReadiness;
        if (!result.status || !result.reason) throw new Error("Missing readiness verdict");
        resolve(result);
      } catch {
        resolve({ status: "unknown", reason: "PR readiness could not be verified; completion remains blocked" });
      }
    });
  });
}
