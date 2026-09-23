// 插件提案暂存（plugin-runtime §5 安全门第 2 步）：plugin_propose 工具登记 →
// 用户 confirm → plugins/install 消费（origin:"agent" + proposalId 校验）。
// 暂存 = 文件面 <agentDir>/plugins/proposals.json（worker 与 host 是不同进程——
// 内存不共享；文件是数据不是代码，写经 atomic-file 串行链，坏文件降级空清单）。
// 有效期 30min：过期未消费即作废（agent 重新 propose 即可）。
// 唯一性：proposalId 内含源树哈希前缀——同源重复 propose 幂等覆盖。
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { activeAtomicPaths, atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubLog } from "./hub-log.ts";
import type { PluginProposalRecord } from "../worker/plugin-propose.ts";

export type { PluginProposalRecord };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export function proposalsPath(agentDir: string): string {
  return join(agentDir, "plugins", "proposals.json");
}

/** 条目形状校验（confirmed/consumed 是可变状态位——文件面的信任边界：confirmed
 *  只能由 host 侧 confirm 命令置位；install 消费即清条目） */
function entryValid(value: unknown): value is PluginProposalRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["proposalId"] === "string" &&
    r["proposalId"] !== "" &&
    typeof r["sourcePath"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["description"] === "string" &&
    Array.isArray(r["requestedCapabilities"]) &&
    typeof r["sha256"] === "string" &&
    r["sha256"] !== "" &&
    typeof r["createdAt"] === "number" &&
    typeof r["confirmed"] === "boolean" &&
    typeof r["consumed"] === "boolean"
  );
}

async function readProposals(agentDir: string): Promise<PluginProposalRecord[]> {
  let raw: string | undefined;
  try {
    raw = await Bun.file(proposalsPath(agentDir)).text();
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    hubLog(`plugin proposals unreadable; degraded to empty (${proposalsPath(agentDir)})`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PluginProposalRecord[] = [];
  for (const item of parsed) {
    if (entryValid(item)) out.push(item);
  }
  // TTL 清扫随读（惰性——读即清过期）
  const now = Date.now();
  return out.filter((record) => now - record.createdAt <= PROPOSAL_TTL_MS);
}

async function writeProposals(agentDir: string, next: PluginProposalRecord[]): Promise<void> {
  await updateJson(proposalsPath(agentDir), {
    read: () => readProposals(agentDir),
    write: async (rows) => {
      await mkdir(join(agentDir, "plugins"), { recursive: true });
      await atomicWriteJson(proposalsPath(agentDir), rows);
    },
    mutate: () => next,
  });
}

export interface PluginProposalStore {
  record(proposal: PluginProposalRecord): Promise<void>;
  list(): Promise<readonly PluginProposalRecord[]>;
  /** 确认态落位（host confirm 命令面——UI 应答后调用） */
  setConfirmed(proposalId: string, confirmed: boolean): Promise<boolean>;
  /** 确认态提案的一次性消费（install 时校验 + 防重放） */
  consumeConfirmed(proposalId: string): Promise<PluginProposalRecord | undefined>;
}

/** 文件面提案暂存（agentDir 锚定；工具与命令共用同一路径的串行链） */
export function createPluginProposalStore(agentDir: string): PluginProposalStore {
  return {
    async record(proposal) {
      const current = await readProposals(agentDir);
      await writeProposals(agentDir, [...current.filter((r) => r.proposalId !== proposal.proposalId), { ...proposal }]);
    },
    async list() {
      return readProposals(agentDir);
    },
    async setConfirmed(proposalId, confirmed) {
      const current = await readProposals(agentDir);
      const found = current.find((r) => r.proposalId === proposalId);
      if (found === undefined) return false;
      found.confirmed = confirmed;
      await writeProposals(agentDir, current);
      return true;
    },
    async consumeConfirmed(proposalId) {
      const current = await readProposals(agentDir);
      const found = current.find((r) => r.proposalId === proposalId);
      if (found === undefined || !found.confirmed) return undefined;
      await writeProposals(agentDir, current.filter((r) => r.proposalId !== proposalId));
      return { ...found };
    },
  };
}

/** 写链活跃路径数（测试口径与 settings/registry 对齐） */
export function activeProposalPaths(): number {
  return activeAtomicPaths();
}
