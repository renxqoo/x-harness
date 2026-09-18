// 子代理血缘表与 spawn 决策原语（docs/AGENT-DELEGATION.md §4.2/§6.1/§1.4）：agentId 8hex
// 双索引 + 名索引（latest-wins）、fork 种子 surface 重铸、模型覆盖序、白名单沿树收窄。

import type { AgentHandle } from "@x-harness/agent-loop";
import type { Session, SessionEvent, SessionId } from "@x-harness/session";
import type { LoadedAgentType } from "./types.ts";

export interface ChildRow {
  /** agent-<8hex> 随机（进程内唯一且跨重启不撞——计数器重启归零会劫持旧档案） */
  readonly agentId: string;
  readonly sessionId: SessionId;
  /** 寻址主键之一；同名共存，裸名解析 latest-wins */
  readonly name: string;
  readonly type: string;
  readonly parent: SessionId;
  readonly depth: number;
  occupied: boolean; // 占槽（登记置；完成通知/stop 释）
  armed: boolean; // 通知臂（running 置；通知后复位）
  running: boolean;
  stopped: boolean;
  worktree?: string;
}

export function createLineage() {
  const byAgentId = new Map<string, ChildRow>();
  const bySessionId = new Map<SessionId, string>();
  const byName = new Map<string, string[]>();
  const rowOf = (session: SessionId): ChildRow | undefined => {
    const agentId = bySessionId.get(session);
    return agentId === undefined ? undefined : byAgentId.get(agentId);
  };
  return {    register: (row: ChildRow): void => {
      byAgentId.set(row.agentId, row);
      bySessionId.set(row.sessionId, row.agentId);
      const names = byName.get(row.name) ?? [];
      names.push(row.agentId);
      byName.set(row.name, names);
    },
    drop: (sessionId: SessionId): void => {
      const agentId = bySessionId.get(sessionId);
      if (agentId === undefined) return;
      const row = byAgentId.get(agentId);
      byAgentId.delete(agentId);
      bySessionId.delete(sessionId);
      if (row !== undefined) byName.set(row.name, (byName.get(row.name) ?? []).filter((id) => id !== agentId));
    },
    get: (agentId: string): ChildRow | undefined => byAgentId.get(agentId),
    bySession: rowOf,
    depthOf: (session: SessionId): number => rowOf(session)?.depth ?? 0,
    /** 同名 live 行（spawn 序，尾部=最新）；live = 内存行存在即 live（含 stopped 可复活） */
    liveByName: (name: string): readonly ChildRow[] => {
      const ids = byName.get(name);
      if (ids === undefined) return [];
      return ids.map((id) => byAgentId.get(id)).filter((row): row is ChildRow => row !== undefined);
    },
    rows: (): readonly ChildRow[] => [...byAgentId.values()],
    occupiedBy: (parent: SessionId): number => [...byAgentId.values()].filter((row) => row.parent === parent && row.occupied).length,
  };
}

export type Lineage = ReturnType<typeof createLineage>;

export function mintAgentId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `agent-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** [ref] = agentId 的 8hex 段尾 6 位（消歧用；规格 hex 形态） */
export function refOfAgentId(agentId: string): string {
  return agentId.slice("agent-".length).slice(-6);
}

/** name 缺省铸造：description slug（折叠空则回退随机段——非拉丁简述防误路由） */
export function slugify(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  if (slug !== "") return slug;
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return `agent-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** fork 种子 surface 重铸：父 surface 节点滤至最后一个 turn/end（剔除开放轮）→ 投影消息 → 逐条重铸全新 append 事件（seq 0..n-1） */
export function forkSeed(parentSession: Session): readonly SessionEvent[] {
  const events = parentSession.events();
  let lastTurnEnd = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as SessionEvent).type === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }
  if (lastTurnEnd < 0) return []; // 无已完成 turn：全新子（工具结果如实告知）
  // system 节点特赦：anchorSystem 的 replace 会把锚点 seq 换到新事件——轮内漂移替换后
  // 锚点 seq 可大于 lastTurnEnd，按 seq 滤会丢 system（子丢失父系统提示词）
  const nodes = parentSession.surface().filter((node) => node.event.type === "system/message" || node.event.seq <= lastTurnEnd);
  return recastSurface(nodes.map((node) => node.event));
}

type SurfaceLikeEvent = SessionEvent;

/** 投影事件 → 全新 append 形态事件（turn/step 全 0；纯 append 无 replace 寻的；log-only 事件天然不进 surface） */
function recastSurface(events: readonly SurfaceLikeEvent[]): SessionEvent[] {
  const seed: SessionEvent[] = [];
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case "system/message":
        seed.push(mint({ seq: seed.length, type: "system/message", data: { turn: 0, step: 0, text: data["text"] ?? "" } }));
        break;
      case "user/message":
        seed.push(mint({ seq: seed.length, type: "user/message", data: { turn: 0, step: 0, content: data["content"] ?? [] } }));
        break;
      case "assistant/message":
        seed.push(
          mint({
            seq: seed.length,
            type: "assistant/message",
            data: {
              turn: 0,
              step: 0,
              content: data["content"] ?? [],
              ...(data["usage"] !== undefined ? { usage: data["usage"] } : {}),
              ...(data["stopReason"] !== undefined ? { stopReason: data["stopReason"] } : {}),
            },
          }),
        );
        break;
      case "tool/result":
        seed.push(
          mint({
            seq: seed.length,
            type: "tool/result",
            data: {
              turn: 0,
              step: 0,
              callId: data["callId"] ?? "",
              content: data["content"] ?? "",
              ...(data["isError"] === true ? { isError: true } : {}),
            },
          }),
        );
        break;
      default:
        break;
    }
  }
  return seed;
}

function mint(spec: { seq: number; type: string; data: unknown }): SessionEvent {
  return { type: spec.type, seq: spec.seq, time: Date.now(), data: spec.data, surfaceOp: "append" } as SessionEvent;
}

/** 模型/线路覆盖序（docs/AGENT-DELEGATION.md §7.3）：按次 > 类型定义 > 父 options > 父末次 header */
export function inheritDial(
  parentHandle: AgentHandle,
  chain: {
    readonly type?: LoadedAgentType;
    readonly lastHeader?: { model?: string; provider?: string };
    readonly override?: { model?: string; provider?: string };
  },
): { model?: string; provider?: string } {
  const model = chain.override?.model ?? chain.type?.model ?? parentHandle.agent.options.model ?? chain.lastHeader?.model;
  const provider = chain.override?.provider ?? chain.type?.provider ?? parentHandle.agent.options.provider ?? chain.lastHeader?.provider;
  return { ...(model !== undefined ? { model } : {}), ...(provider !== undefined ? { provider } : {}) };
}

/** 沿树只收窄：type.tools ∩ 调用方白名单；undefined=全集 */
export function narrowTools(callerTools: readonly string[] | undefined, typeTools: readonly string[] | undefined): readonly string[] | undefined {
  if (typeTools === undefined) return callerTools;
  if (callerTools === undefined) return typeTools;
  const caller = new Set(callerTools);
  return typeTools.filter((name) => caller.has(name));
}
