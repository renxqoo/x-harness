// 插件提案暂存（plugin-runtime §5 安全门第 2 步）：plugin_propose 工具登记 →
// 用户 confirm → plugins/install 消费（origin:"agent" + proposalId 校验）。
//
// 信任边界（对抗审查 3a 修复后）：登记数据 = 文件面 <agentDir>/plugins/proposals.json
//（可被直写伪造——无害，仅展示数据）；**确认态 = host 进程内存**（confirm 命令置位，
// 文件里的 confirmed 字段只是回显快照，不参与判定）。install 消费时双查：
// 文件条目存在 ∧ 内存 Set 已确认。agent 写盘伪造登记后无任何通路伪造内存确认——
// 唯一确认口是 host 侧 trusted_source/confirm 命令（UI 应答驱动）。
// 有效期 30min：过期未消费即作废（agent 重新 propose 即可）。
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubLog } from "./hub-log.ts";
import type { PluginProposalRecord } from "../worker/plugin-propose.ts";

export type { PluginProposalRecord };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** 确认态寄存（host 进程内存——单 host 进程单例；文件伪造不可达） */
const confirmedIds = new Set<string>();

export function proposalsPath(agentDir: string): string {
  return join(agentDir, "plugins", "proposals.json");
}

/** 条目形状校验（文件面的 confirmed 字段仅回显——判定不看它） */
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
  /** 确认态落位（host confirm 命令面——内存 Set + 文件回显双写） */
  setConfirmed(proposalId: string, confirmed: boolean): Promise<boolean>;
  /** 确认态提案的一次性消费（install 时校验 + 防重放） */
  consumeConfirmed(proposalId: string): Promise<PluginProposalRecord | undefined>;
}

/** 提案暂存（登记=文件面；确认=进程内存；消费=双查） */
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
      // 判定态进内存；文件字段只是 UI 回显快照
      if (confirmed) confirmedIds.add(proposalId);
      else confirmedIds.delete(proposalId);
      found.confirmed = confirmed;
      await writeProposals(agentDir, current);
      return true;
    },
    async consumeConfirmed(proposalId) {
      const current = await readProposals(agentDir);
      const found = current.find((r) => r.proposalId === proposalId);
      // 双查：文件条目在场 ∧ 内存确认态（文件 confirmed 字段不参与判定——
      // 直写文件的伪造登记无内存确认，恒拒）
      if (found === undefined || !confirmedIds.has(proposalId)) return undefined;
      confirmedIds.delete(proposalId);
      await writeProposals(agentDir, current.filter((r) => r.proposalId !== proposalId));
      return { ...found };
    },
  };
}

/** 测试口径：确认寄存清空（进程级单例的隔离缝） */
export function resetProposalConfirms(): void {
  confirmedIds.clear();
}
