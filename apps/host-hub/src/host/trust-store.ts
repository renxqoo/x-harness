import { join } from "node:path";
import { normalizeCwd } from "../shared/settings-store.ts";
import { atomicWriteJson, readJson, updateJson } from "../shared/atomic-file.ts";
import type { ThreadTable } from "./thread-table.ts";

const TRUST_FILE = "trusted-workspaces.json";

const trustPath = (agentDir: string): string => join(agentDir, TRUST_FILE);

async function readRaw(agentDir: string): Promise<string[]> {
  const parsed = await readJson<unknown>(trustPath(agentDir), []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

export function createTrustStore(agentDir: string) {
  return {
    list: (): Promise<string[]> => readRaw(agentDir),
    async trust(cwd: string): Promise<void> {
      const normalized = await normalizeCwd(cwd);
      await updateJson(trustPath(agentDir), {
        read: () => readRaw(agentDir),
        write: (list) => atomicWriteJson(trustPath(agentDir), [...new Set([...list, normalized])].sort()),
        mutate: (list) => (list.includes(normalized) ? list : [...list, normalized]),
      });
    },
    async untrust(cwd: string): Promise<void> {
      const normalized = await normalizeCwd(cwd);
      await updateJson(trustPath(agentDir), {
        read: () => readRaw(agentDir),
        write: (list) => atomicWriteJson(trustPath(agentDir), list.filter((item) => item !== normalized).sort()),
        mutate: (list) => list,
      });
    },
    async isTrusted(cwd: string, table: ThreadTable): Promise<boolean> {
      const normalized = await normalizeCwd(cwd);
      const registry = await readRaw(agentDir);
      if (registry.includes(normalized)) return true;
      for (const entry of table.list()) {
        if (entry.trusted && (await normalizeCwd(entry.cwd)) === normalized) return true;
      }
      return false;
    },
  };
}

export type TrustStore = ReturnType<typeof createTrustStore>;
