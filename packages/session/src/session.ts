// 单会话：append-only 日志 + 增量 surface 投影 + 写权封存（docs/SESSION.md §1.3–§1.5）。
// append 链：封存检查 → intent 一致性 → 形状门 → replace 区间门 → 分配 seq/time → 深冻 → 入账 → 投影步进 → 广播回调。

import { deepFreeze } from "@x-harness/core";
import { gateEvent, parseSurfaceOp } from "./gates.ts";
import { materializeJson } from "./snapshot.ts";
import { applySurfaceEvent, isSurfaceEventType, projectSurface, surfaceToMessages } from "./surface.ts";
import type { Result } from "@x-harness/core";
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SurfaceEventType,
  SurfaceIntent,
  SurfaceNode,
} from "./types.ts";

export interface SessionHandle {
  readonly session: Session;
  /** store.dispose 调用：封存写权（append 此后返回 session-disposed，读面仍开放） */
  readonly seal: () => void;
}

export interface CreateSessionInput {
  readonly header: SessionHeader;
  readonly seed: readonly SessionEvent[];
  /** fork 前缀的 end-seed 带 inherited 标记；resume/replay 不带 */
  readonly inherited: boolean;
  readonly onAppend: (session: SessionId, event: SessionEvent) => void;
}

export function createSession(input: CreateSessionInput): SessionHandle {
  // 收养即脱钩：seed 事件物化为纯 JSON 快照后深冻——宿主对象不被冻结、getter 值一次性定影
  const log: SessionEvent[] = input.seed.map((event) => deepFreeze(materializeJson(event)) as SessionEvent);
  // 构造器是 end-seed 的唯一合法写者；seed 非空才落边界标记，不广播（经 created 首灌落盘）
  if (log.length > 0) {
    const marker = input.inherited ? { inherited: true } : {};
    log.push(deepFreeze({ type: "session/end-seed", seq: log.length, time: Date.now(), data: marker }) as SessionEvent);
  }
  let nodes: readonly SurfaceNode[] = projectSurface(log);
  let sealed = false;
  let appending = false; // 广播回调内的重入卫兵：监听器恒重入 append 会栈溢出，拒绝而非崩溃

  const session: Session = {
    id: input.header.id,
    header: input.header,
    events: () => Object.freeze([...log]),
    surface: () => Object.freeze([...nodes]),
    deriveMessages: () => Object.freeze(surfaceToMessages(nodes).map((message) => Object.freeze(message))),
    append: ((type: string, data: unknown, intent?: SurfaceIntent): Result<SessionEvent> => {
      if (sealed) return { ok: false, reason: "session-disposed" };
      if (appending) return { ok: false, reason: "append-reentrant" };
      const surface = isSurfaceEventType(type);
      if (surface !== (intent !== undefined)) {
        return { ok: false, reason: surface ? "surface-intent-required" : "surface-intent-not-allowed" };
      }
      // intent 本体的运行时门：null / 缺 surfaceOp / 形状不符一律拒绝（垃圾输入不崩）
      const parsedOp = surface ? parseSurfaceOp((intent as { surfaceOp?: unknown } | null)?.surfaceOp) : undefined;
      if (surface && parsedOp === undefined) return { ok: false, reason: "surface-op-invalid" };
      // 物化先行（单一读取）：门只看快照——stateful getter 无法给校验一个值、给存储另一个值
      let snapshot: unknown;
      try {
        snapshot = materializeJson(data);
      } catch {
        return { ok: false, reason: `not-json-safe:${type}` };
      }
      const gateErr = gateEvent(type, snapshot);
      if (gateErr !== undefined) return { ok: false, reason: gateErr };
      const event = deepFreeze({
        type,
        seq: log.length,
        time: Date.now(),
        data: snapshot,
        ...(parsedOp !== undefined ? { surfaceOp: parsedOp } : {}),
      }) as SessionEvent;
      // surface 步进先算后落账：区间不可行即拒，日志零变动
      if (parsedOp !== undefined) {
        const step = applySurfaceEvent(nodes, event as SessionEvent<SurfaceEventType>);
        if (!step.ok) return { ok: false, reason: step.reason };
        log.push(event);
        nodes = step.nodes;
      } else {
        log.push(event);
      }
      appending = true;
      try {
        input.onAppend(input.header.id, event);
      } finally {
        appending = false;
      }
      return { ok: true, value: event };
    }) as Session["append"],
  };
  return {
    session: Object.freeze(session),
    seal: () => {
      sealed = true;
    },
  };
}
