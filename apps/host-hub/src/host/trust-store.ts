// 持久信任注册表（DESIGN §3.9）：<agentDir>/trusted-workspaces.json（规范化 cwd
// 数组）。写入口仅两条且都是用户显式动作：workspace/trust 命令、thread/start|
// resume|register 的 trusted:true（**登记由 host 转发链执行——worker 永不写**）；
// worker 侧判定 = 只读本文件 ∪ 自身 state.trusted。撤销不回收在途 live 线程的
// 信任（集成员资格随线程存续）。
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
    /** 登记（幂等；入参规范化；已登记则不重写盘） */
    async trust(cwd: string): Promise<void> {
      const normalized = await normalizeCwd(cwd);
      if ((await readRaw(agentDir)).includes(normalized)) return; // 幂等短路——少一次 IO
      await updateJson(trustPath(agentDir), {
        read: () => readRaw(agentDir),
        write: (list) => atomicWriteJson(trustPath(agentDir), [...list, normalized].sort()),
        mutate: (list) => list,
      });
    },
    /** 撤销（不回收在途 live 线程——仅影响下次装配/命令门禁） */
    async untrust(cwd: string): Promise<void> {
      const normalized = await normalizeCwd(cwd);
      await updateJson(trustPath(agentDir), {
        read: () => readRaw(agentDir),
        write: (list) => atomicWriteJson(trustPath(agentDir), list.filter((item) => item !== normalized).sort()),
        mutate: (list) => list,
      });
    },
    /** 信任集命中判定（注册表 ∪ live trusted 线程 cwd——双边规范化比对） */
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
