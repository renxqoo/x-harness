import { describe, expect, it } from "vitest";
import { createSession } from "../session.ts";
import { projectSurface } from "../surface.ts";
import type { Session, SessionEvent, SessionHeader, SessionId, SurfaceEventType } from "../types.ts";

const header: SessionHeader = { id: "s1" as SessionId, createdAt: 1, cwd: "/tmp" };

/** 确定性 PRNG（mulberry32）：属性测试可复现，不引入外部属性测试依赖 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const surfaceTypes: readonly SurfaceEventType[] = ["system/message", "user/message", "assistant/message", "tool/result"];
const logOnlyTypes = ["turn/start", "step/start", "tool/call", "request/header", "request/context", "assistant/attempt"] as const;

function dataFor(type: string, i: number): Record<string, unknown> {
  switch (type) {
    case "system/message":
      return { turn: 0, step: 0, text: `sys-${i}` };
    case "user/message":
    case "assistant/message":
      return { turn: 0, step: 0, content: [{ type: "text", text: `m-${i}` }] };
    case "tool/result":
      return { turn: 0, step: 0, callId: `c${i}`, content: `r-${i}` };
    case "tool/call":
      return { turn: 0, step: 0, callId: `c${i}`, name: "t", arguments: "{}" };
    case "request/header":
      return { model: "m", tools: [{ name: "t" }] };
    case "request/context":
      return { provider: "p", model: "m" };
    case "assistant/attempt":
      return { turn: 0, step: 0, error: "e" };
    default:
      return { turn: i };
  }
}

type RawAppend = (type: string, data: unknown, intent?: { surfaceOp: unknown }) => { ok: boolean };

/** 随机驱动一个合法日志：surface append / 合法 replace / log-only 交错（弱类型通道直击运行时） */
function driveRandomSession(seed: number): Session {
  const rand = mulberry32(seed);
  const session = createSession({ header, seed: [], inherited: false, onAppend: () => {} }).session;
  const raw = session.append as unknown as RawAppend;
  let surfaceSeqs: number[] = [];
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  for (let i = 0; i < 80; i++) {
    const roll = rand();
    if (roll < 0.4 || surfaceSeqs.length === 0) {
      const type = pick(surfaceTypes);
      if (raw(type, dataFor(type, i), { surfaceOp: "append" }).ok) surfaceSeqs.push(i);
    } else if (roll < 0.6) {
      const a = pick(surfaceSeqs);
      const b = pick(surfaceSeqs);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (raw("assistant/message", dataFor("assistant/message", i), { surfaceOp: { op: "replace", startSeq: lo, endSeq: hi } }).ok) {
        surfaceSeqs = session.surface().map((n) => n.seq);
      }
    } else {
      const type = pick(logOnlyTypes);
      raw(type, dataFor(type, i));
    }
  }
  return session;
}

describe("日志代数性质（DSH properties.spec 承接——种子化随机日志，确定性可复现）", () => {
  it.each([1, 2, 3, 7, 11, 42, 99, 128, 777, 2024])("种子 %i：seq 连续、派生确定、增量==全量、重放等价", (seed) => {
    const session = driveRandomSession(seed);
    const events = session.events();

    // seq 严格从 0 连续
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    // 派生确定性：两次调用深度相等
    expect(session.deriveMessages()).toEqual(session.deriveMessages());
    expect(session.events()).toEqual([...events]);
    // 增量投影 == 全量重算
    expect(session.surface().map((n) => n.seq)).toEqual(projectSurface(events).map((n) => n.seq));
    expect(session.surface().map((n) => n.event)).toEqual(projectSurface(events).map((n) => n.event));

    // seed 重放等价：全量 events 作为 seed 重建，派生历史逐一致（end-seed 为 log-only 不上面）
    const replayed = createSession({ header, seed: events as SessionEvent[], inherited: false, onAppend: () => {} }).session;
    expect(replayed.events().slice(0, events.length)).toEqual(events);
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages());
    expect(replayed.surface().map((n) => n.seq)).toEqual(session.surface().map((n) => n.seq));
  });

  it("log-only 事件交错不影响投影：剔除后 surface 逐一致", () => {
    for (const seed of [5, 50, 500]) {
      const session = driveRandomSession(seed);
      const surfaceOnly = session.events().filter((e) => (surfaceTypes as readonly string[]).includes(e.type)) as SessionEvent[];
      expect(projectSurface(surfaceOnly).map((n) => n.seq)).toEqual(projectSurface(session.events()).map((n) => n.seq));
    }
  });
});
