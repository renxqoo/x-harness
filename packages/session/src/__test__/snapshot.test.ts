import { describe, expect, it } from "vitest";
import { isJsonSafe } from "../gates.ts";
import { materializeJson } from "../snapshot.ts";
import { createSession } from "../session.ts";
import type { SessionEvent, SessionHeader, SessionId } from "../types.ts";

const header: SessionHeader = { id: "s1" as SessionId, createdAt: 1, cwd: "/tmp" };

function makeSession() {
  return createSession({ header, seed: [], inherited: false, onAppend: () => {} }).session;
}

describe("JSON 脱钩快照（docs/SESSION.md §1.3——DSH json.spec/TOCTOU 承接）", () => {
  it("append 后调用方对象不被冻结、继续修改不影响日志（脱钩而非就地冻结）", () => {
    const session = makeSession();
    const data = { turn: 0, step: 0, text: "a" };
    expect(session.append("system/message", data, { surfaceOp: "append" }).ok).toBe(true);
    expect(Object.isFrozen(data)).toBe(false);
    data.text = "changed";
    const first = session.events()[0];
    expect(first).toBeDefined();
    expect((first!.data as { text: string }).text).toBe("a");
  });

  it("seed 收养脱钩：宿主手造事件事后可改，日志不受影响", () => {
    const seed = [{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } }] as SessionEvent[];
    const session = createSession({ header, seed, inherited: false, onAppend: () => {} }).session;
    (seed[0] as { data: { turn: number } }).data.turn = 99; // 宿主对象仍是宿主的
    const adopted = session.events()[0];
    expect(adopted).toBeDefined();
    expect((adopted!.data as { turn: number }).turn).toBe(0);
  });

  it("getter 不稳定值在物化时刻定影：事件读取恒稳定（TOCTOU 关闭）", () => {
    const session = makeSession();
    let reads = 0;
    const unstable = {
      turn: 0,
      step: 0,
      get text(): string {
        reads += 1;
        return `t${reads}`;
      },
    };
    expect(session.append("system/message", unstable, { surfaceOp: "append" }).ok).toBe(true);
    const settled = session.events()[0];
    expect(settled).toBeDefined();
    const first = (settled!.data as { text: string }).text;
    const second = (settled!.data as { text: string }).text;
    const third = JSON.parse(JSON.stringify(settled)).data.text;
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("__proto__ 自有键（JSON 来源）保留为自有键、不污染原型", () => {
    const parsed = JSON.parse('{"__proto__": {"a": 1}, "b": 2}');
    expect(isJsonSafe(parsed)).toBe(true);
    const out = materializeJson(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toContain("__proto__");
    expect(Object.keys(out)).toContain("b");
    expect(JSON.stringify(out)).toBe(JSON.stringify(parsed));
  });

  it("字面量/显式设置的原型污染被 isJsonSafe 拒绝（验证不可被原型链跳过）", () => {
    const crafted: Record<string, unknown> = {};
    Object.setPrototypeOf(crafted, { hidden: { deep: 1 } });
    expect(isJsonSafe(crafted)).toBe(false);
    const viaNullProto = Object.assign(Object.create(null), { a: 1 });
    expect(isJsonSafe(viaNullProto)).toBe(true); // null 原型的普通 record 合法
  });

  it("稀疏数组 → false（洞读为 undefined，JSON 会静默写 null）", () => {
    const sparse = [1, 2];
    delete sparse[1];
    expect(isJsonSafe(sparse)).toBe(false);
  });

  it("拒绝路径不 mutate 输入", () => {
    const session = makeSession();
    const bad = { turn: -1 };
    session.append("turn/start", bad);
    expect(bad).toEqual({ turn: -1 });
    const cyclic: Record<string, unknown> = { turn: 0, step: 0, content: [] };
    cyclic["self"] = cyclic;
    const raw = session.append as unknown as (type: string, data: unknown, intent?: unknown) => { ok: boolean };
    raw("user/message", cyclic, { surfaceOp: "append" });
    expect(cyclic["self"]).toBe(cyclic);
  });

  it("物化输出与原值深度相等（稠密数组/嵌套对象/null 原型）", () => {
    const value = { a: [1, { b: "x" }], c: null, d: true };
    expect(materializeJson(value)).toEqual(value);
    expect(materializeJson(Object.assign(Object.create(null), { k: 1 }))).toEqual({ k: 1 });
    expect(materializeJson(null)).toBe(null);
    expect(materializeJson("s")).toBe("s");
  });
});
