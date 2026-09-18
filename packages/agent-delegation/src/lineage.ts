// 子代理血缘表与 spawn 决策（docs/AGENT-DELEGATION.md §1.2）：agentId 铸造、深度链、
// 占槽（occupied/armed 拆分）、fork 种子 surface 重铸（§1.4——裸切片破坏 seq 校验，机制性不可行）。

import type { AgentHandle } from "@x-harness/agent-loop";
import type { Session, SessionEvent, SessionId } from "@x-harness/session";
import type { SubagentType } from "./types.ts";

export interface ChildRow {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly type: string;
  readonly parent: SessionId;
  readonly depth: number;
  occupied: boolean; // 占槽（登记置；完成通知/stop 释）
  armed: boolean; // 通知臂（running 置；通知后复位）
  running: boolean;
  stopped: boolean;
}

export function createLineage() {
  const rows = new Map<SessionId, ChildRow>();
  let counter = 0;
  return {
    rows,
    depthOf: (session: SessionId): number => rows.get(session)?.depth ?? 0,
    mintAgentId: (): string => {
      counter += 1;
      return `agent-${String(counter)}`;
    },
    occupiedBy: (parent: SessionId): number =>
      [...rows.values()].filter((row) => row.parent === parent && row.occupied).length,
    register: (row: ChildRow): void => {
      rows.set(row.sessionId, row);
    },
    drop: (session: SessionId): void => {
      rows.delete(session);
    },
  };
}

/** fork 种子 surface 重铸：父 surface 节点滤至最后一个 turn/end（剔除开放轮）→ 投影消息 → 逐条重铸全新 append 事件（seq 0..n-1） */
export function forkSeed(parent: Session): readonly SessionEvent[] {
  const events = parent.events();
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
  const nodes = parent.surface().filter((node) => node.event.type === "system/message" || node.event.seq <= lastTurnEnd);
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

/** 子模型/线路：type 显式 > 父 options > 父末次 request/header */
export function inheritDial(
  parentHandle: AgentHandle,
  type: SubagentType,
  lastHeader: { model?: string; provider?: string } | undefined,
): { model?: string; provider?: string } {
  const model = type.model ?? parentHandle.agent.options.model ?? lastHeader?.model;
  const provider = type.provider ?? parentHandle.agent.options.provider ?? lastHeader?.provider;
  return { ...(model !== undefined ? { model } : {}), ...(provider !== undefined ? { provider } : {}) };
}

/** 沿树只收窄：type.tools ∩ 调用方白名单；undefined=全集 */
export function narrowTools(callerTools: readonly string[] | undefined, typeTools: readonly string[] | undefined): readonly string[] | undefined {
  if (typeTools === undefined) return callerTools;
  if (callerTools === undefined) return typeTools;
  const caller = new Set(callerTools);
  return typeTools.filter((name) => caller.has(name));
}
