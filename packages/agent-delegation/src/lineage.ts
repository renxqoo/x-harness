// 子代理血缘表与 spawn 决策原语（docs/AGENT-DELEGATION.md §4.2/§6/§1.4——修订A「去名」）：
// agentId 唯一身份（8hex 随机，header 落盘跨重启稳定）；双索引；fork 种子 surface 重铸；
// 模型覆盖序；白名单沿树收窄。

import type { AgentHandle } from "@x-harness/agent-loop";
import type { ToolFilter } from "@x-harness/tools";
import type { Session, SessionEvent, SessionId } from "@x-harness/session";
import type { LoadedAgentType } from "./types.ts";

export interface ChildRow {
  /** agent-<8hex> 随机；跨重启稳定（header.agentId 落盘，复活沿用不重铸） */
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly type: string;
  readonly parent: SessionId;
  readonly depth: number;
  /** spawn 任务摘要（header.agentWork 持久锚——复活回填；旧档案可能缺席） */
  readonly work?: string;
  occupied: boolean; // 占槽（登记置；完成通知/stop 释）
  armed: boolean; // 通知臂（running 置；通知后复位）
  running: boolean;
  stopped: boolean;
  worktree?: string;
}

export function createLineage() {
  const byAgentId = new Map<string, ChildRow>();
  const bySessionId = new Map<SessionId, string>();
  const rowOf = (session: SessionId): ChildRow | undefined => {
    const agentId = bySessionId.get(session);
    return agentId === undefined ? undefined : byAgentId.get(agentId);
  };
  return {
    register: (row: ChildRow): void => {
      byAgentId.set(row.agentId, row);
      bySessionId.set(row.sessionId, row.agentId);
    },
    drop: (sessionId: SessionId): void => {
      const agentId = bySessionId.get(sessionId);
      if (agentId === undefined) return;
      byAgentId.delete(agentId);
      bySessionId.delete(sessionId);
    },
    get: (agentId: string): ChildRow | undefined => byAgentId.get(agentId),
    bySession: rowOf,
    depthOf: (session: SessionId): number => rowOf(session)?.depth ?? 0,
    rows: (): readonly ChildRow[] => [...byAgentId.values()],
    occupiedBy: (parent: SessionId): number => [...byAgentId.values()].filter((row) => row.parent === parent && row.occupied).length,
  };
}

export type Lineage = ReturnType<typeof createLineage>;

/** agentId 铸造：agent-<8hex> 随机（进程内唯一；跨重启碰撞概率 ~2^-32·n，可忽略） */
export function mintAgentId(): string {
  const bytes = new Uint8Array(4);
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
    const recast = recastOne(event, seed.length); // seq = 种子位置（envelope 校验要求连续）
    if (recast !== undefined) seed.push(recast);
  }
  return seed;
}

/** assistant/message 重铸 data（recastOne 复杂度治理） */
function assistantRecastData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn: 0,
    step: 0,
    content: data["content"] ?? [],
    ...(data["usage"] !== undefined ? { usage: data["usage"] } : {}),
    ...(data["stopReason"] !== undefined ? { stopReason: data["stopReason"] } : {}),
  };
}

/** agent/message 重铸 data：仅 content（AGENT-MESSAGE.md §5——兄弟报告是事实）；directive 返回 undefined（过期作废） */
function agentMessageRecast(data: Record<string, unknown>): { readonly turn: number; readonly step: number; readonly source: string; readonly kind: "content"; readonly content: unknown } | undefined {
  if (data["kind"] !== "content") return undefined;
  return { turn: 0, step: 0, source: typeof data["source"] === "string" ? data["source"] : "", kind: "content", content: data["content"] ?? [] };
}

/** 单事件重铸（recastSurface 复杂度治理）：未知/不进种子的类型返回 undefined。
 *  agent/message 仅 content 重铸（AGENT-MESSAGE.md §5——兄弟报告是事实）；directive
 *  丢弃（协议指令过期作废，与摘要跳过同口径）。 */
function recastOne(event: SurfaceLikeEvent, seq: number): SessionEvent | undefined {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "system/message":
      return mint({ seq, type: "system/message", data: { turn: 0, step: 0, text: data["text"] ?? "" } });
    case "user/message":
      return mint({ seq, type: "user/message", data: { turn: 0, step: 0, content: data["content"] ?? [] } });
    case "assistant/message":
      return mint({ seq, type: "assistant/message", data: assistantRecastData(data) });
    case "tool/result":
      return mint({
        seq,
        type: "tool/result",
        data: {
          turn: 0,
          step: 0,
          callId: data["callId"] ?? "",
          content: data["content"] ?? "",
          ...(data["isError"] === true ? { isError: true } : {}),
        },
      });
    case "agent/message": {
      const recast = agentMessageRecast(data);
      return recast === undefined ? undefined : mint({ seq, type: "agent/message", data: recast });
    }
    default:
      return undefined;
  }
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
export function narrowTools(callerTools: ToolFilter | undefined, typeTools: readonly string[] | undefined): ToolFilter | undefined {
  if (typeTools === undefined) return callerTools;
  if (callerTools === undefined) return typeTools;
  if (callerTools === "deny-all") return []; // deny-all ∩ 任何 = 空（X15 单调）
  const caller = new Set(callerTools);
  return typeTools.filter((name) => caller.has(name));
}
