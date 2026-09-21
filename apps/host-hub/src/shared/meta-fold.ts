// session/meta 尾值折叠（单源——host 直读与 worker 读口共用）：last-wins（后写胜），
// 空键跳过；值形状归消费方校验（内核只运不判）。dial 双源（meta 显式 > request/header
// 隐式）的读序也在此单点。
import type { SessionEvent } from "@x-harness/session";

export type MetaRecord = Record<string, unknown>;

/** 全量折叠（list_saved/直读面——一次读全档） */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function foldMeta(events: readonly SessionEvent[]): MetaRecord {
  const out: MetaRecord = Object.create(null); // 原型污染防护（伪造卷的 __proto__ 键不得设原型）
  for (const event of events) {
    if (event.type === "session/meta" && !UNSAFE_KEYS.has(event.data.key)) out[event.data.key] = event.data.value;
  }
  return out;
}

export interface DialFact {
  provider: string;
  model: string;
}

function metaDialOf(event: SessionEvent): DialFact | undefined {
  if (event.type !== "session/meta" || event.data.key !== "dial") return undefined;
  const value = event.data.value;
  if (typeof value !== "object" || value === null) return undefined;
  const model = (value as { model?: unknown }).model;
  if (typeof model !== "string" || model === "") return undefined;
  const provider = (value as { provider?: unknown }).provider;
  return { provider: typeof provider === "string" ? provider : "", model };
}

/** dial 双源尾值：session/meta{key:"dial"}（显式）> request/header（隐式——内核
 *  落账的实拨事实）> fallback（装配拨号）。 */
export function foldDial(events: readonly SessionEvent[], fallback: DialFact): DialFact {
  for (let i = events.length - 1; i >= 0; i--) {
    const dial = metaDialOf(events[i] as SessionEvent);
    if (dial !== undefined) return { provider: dial.provider !== "" ? dial.provider : fallback.provider, model: dial.model };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "request/header" && event.data.model !== "") {
      return { provider: event.data.provider ?? fallback.provider, model: event.data.model };
    }
  }
  return fallback;
}

/** 单键尾值（worker 命令面——只关心一个键，反向扫首中即止） */
export function metaTailOf(events: readonly SessionEvent[], key: string): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "session/meta" && event.data.key === key) return event.data.value;
  }
  return undefined;
}
