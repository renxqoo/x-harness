import { describe, expect, it } from "vitest";
import type { GuardDeny } from "@x-harness/core";
import { createSessionStore } from "../store.ts";
import type { SessionStoreHooks } from "../store.ts";
import type { CreateSessionOptions, SessionEvent, SessionHeader } from "../types.ts";
import { sid, unwrap } from "./helpers.ts";

interface Harness {
  hooks: SessionStoreHooks;
  created: SessionHeader[];
  disposed: string[];
  events: SessionEvent[];
  flushes: string[];
  setGuard(reason: string | undefined): void;
  setFlushError(error: Error | undefined): void;
}

function makeStore(): Harness {
  const created: SessionHeader[] = [];
  const disposed: string[] = [];
  const events: SessionEvent[] = [];
  const flushes: string[] = [];
  let guardReason: string | undefined;
  let flushError: Error | undefined;
  const hooks: SessionStoreHooks = {
    onEvent: (_session, event) => {
      events.push(event);
    },
    onGuard: async (_header): Promise<GuardDeny | undefined> => {
      await Promise.resolve(); // 让并发 create 都越过预检查、抵达 birth 二次占用检查
      return guardReason === undefined ? undefined : { kind: "deny", reason: guardReason };
    },
    onCreated: (header) => {
      created.push(header);
    },
    onFlush: async (session) => {
      flushes.push(session);
      if (flushError !== undefined) throw flushError;
    },
    onDisposed: (session) => {
      disposed.push(session);
    },
  };
  return {
    hooks,
    created,
    disposed,
    events,
    flushes,
    setGuard: (reason) => {
      guardReason = reason;
    },
    setFlushError: (error) => {
      flushError = error;
    },
  };
}

function seedEvent(seq: number, turn = 0): SessionEvent {
  return { type: "turn/start", seq, time: 1, data: { turn } };
}

describe("create（docs/SESSION.md §1.5）", () => {
  it("默认铸号 session-<n>，header 盖当前版本", async () => {
    const h = makeStore();
    const store = createSessionStore(h.hooks);
    const a = unwrap(await store.create());
    const b = unwrap(await store.create());
    expect(a.id).toBe("session-0");
    expect(b.id).toBe("session-1");
    expect(typeof a.header.createdAt).toBe("number");
    expect(a.header.cwd).toBe(process.cwd());
    expect(h.created).toHaveLength(2);
  });

  it("显式 id / 非法 id / 冲突", async () => {
    const store = createSessionStore(makeStore().hooks);
    expect(unwrap(await store.create({ id: sid("my-session") })).id).toBe("my-session");
    expect(await store.create({ id: sid("my-session") })).toEqual({ ok: false, reason: "duplicate:my-session" });
    expect(await store.create({ id: sid("../x") })).toEqual({ ok: false, reason: "invalid-id:../x" });
  });

  it("guard 否决 → 零残留（docs/SESSION.md §1.2 否决点）", async () => {
    const h = makeStore();
    h.setGuard("quota");
    const store = createSessionStore(h.hooks);
    expect(await store.create({ id: sid("s") })).toEqual({ ok: false, reason: "denied:quota" });
    expect(store.list()).toEqual([]);
    expect(store.get(sid("s"))).toBeUndefined();
    expect(h.created).toEqual([]);
  });

  it("并发 create 同显式 id → 恰一个成功（await guard 后二次占用检查）", async () => {
    const h = makeStore();
    const store = createSessionStore(h.hooks);
    const [a, b] = await Promise.all([store.create({ id: sid("race") }), store.create({ id: sid("race") })]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(store.list()).toEqual(["race"]);
    expect(h.created).toHaveLength(1);
  });

  it("seed：resume 回灌 + end-seed；非法 seed 拒绝且零残留", async () => {
    const store = createSessionStore(makeStore().hooks);
    const seeded = unwrap(await store.create({ id: sid("r"), seed: [seedEvent(0)] }));
    expect(seeded.events().map((e) => e.type)).toEqual(["turn/start", "session/end-seed"]);
    expect(seeded.events()[1]?.data).toEqual({});

    expect(await store.create({ id: sid("g"), seed: [seedEvent(0), seedEvent(2)] })).toEqual({
      ok: false,
      reason: "corrupt-envelope:1:seq",
    });
    expect(store.get(sid("g"))).toBeUndefined();
  });

  it("seed 空数组 = 无标记空会话", async () => {
    const store = createSessionStore(makeStore().hooks);
    expect(unwrap(await store.create({ seed: [] })).events()).toEqual([]);
  });

  it("parent 血缘回填 / 非法 parent 拒绝", async () => {
    const store = createSessionStore(makeStore().hooks);
    expect(unwrap(await store.create({ parent: sid("p1") })).header.parentSession).toBe("p1");
    expect(await store.create({ parent: sid("../p") })).toEqual({ ok: false, reason: "invalid-parent:../p" });
  });

  it("header 覆盖：归档原文入账、元数据保留（docs/SESSION-RESUME §1.3）", async () => {
    const store = createSessionStore(makeStore().hooks);
    const archived = { id: sid("arch"), createdAt: 12345, cwd: "/old/cwd", parentSession: sid("old-parent") };
    const s = unwrap(await store.create({ header: archived }));
    expect(s.header).toEqual(archived);
    expect(Object.isFrozen(s.header)).toBe(true);
    expect(store.get(sid("arch"))).toBeDefined();
  });

  it.each<[string, CreateSessionOptions, string]>([
    ["非法 id", { header: { id: sid("../x"), createdAt: 1 } }, "invalid-header:shape"],
    ["id 冲突", { header: { id: sid("a"), createdAt: 1 }, id: sid("b") }, "invalid-header:id-mismatch"],
  ])("header 覆盖拒绝：%s", (_name, options, expected) => {
    return (async () => {
      const store = createSessionStore(makeStore().hooks);
      expect(await store.create(options)).toEqual({ ok: false, reason: expected });
    })();
  });
});

describe("fork（docs/SESSION.md §1.5）", () => {
  async function makeParent() {
    const h = makeStore();
    const store = createSessionStore(h.hooks);
    const parent = unwrap(await store.create({ id: sid("p") }));
    parent.append("turn/start", { turn: 0 });
    parent.append("user/message", { turn: 0, step: 0, content: [] }, { surfaceOp: "append" });
    parent.append("tool/call", { turn: 0, step: 0, callId: "c", name: "t", arguments: "{}" });
    return { h, store, parent };
  }

  it("前缀逐字复制 + inherited 标记 + 血缘 + created 广播", async () => {
    const { h, store, parent } = await makeParent();
    const child = unwrap(await store.fork(parent.id, { untilSeq: 1, id: sid("child") }));
    expect(child.events().slice(0, 2)).toEqual(parent.events().slice(0, 2));
    expect(child.events()[2]?.type).toBe("session/end-seed");
    expect(child.events()[2]?.data).toEqual({ inherited: true });
    expect(child.header.parentSession).toBe("p");
    expect(h.created.map((header) => header.id)).toContain("child");
  });

  it("快照隔离：fork 后父继续写不影响子", async () => {
    const { store, parent } = await makeParent();
    const child = unwrap(await store.fork(parent.id));
    const childLen = child.events().length;
    parent.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    expect(child.events()).toHaveLength(childLen);
  });

  it.each<[string, number | undefined, boolean]>([
    ["-1 越界", -1, false],
    ["len 越界", 3, false],
    ["0 合法（单事件前缀）", 0, true],
    ["len-1 合法（全量）", 2, true],
    ["缺省 = 全量", undefined, true],
  ])("untilSeq %s", (_name, untilSeq, shouldPass) => {
    return (async () => {
      const { store, parent } = await makeParent();
      const child = await store.fork(parent.id, untilSeq === undefined ? {} : { untilSeq });
      expect(child.ok).toBe(shouldPass);
      if (shouldPass && child.ok) {
        const prefix = untilSeq === undefined ? 3 : untilSeq + 1;
        expect(child.value.events()).toHaveLength(prefix + 1); // + end-seed
      }
    })();
  });

  it("源不存在 / 空源会话（无前缀可继承）→ 失败", async () => {
    const store = createSessionStore(makeStore().hooks);
    expect(await store.fork(sid("nope"))).toEqual({ ok: false, reason: "no-session:nope" });
    const empty = unwrap(await store.create());
    expect(await store.fork(empty.id)).toEqual({ ok: false, reason: "bad-cut:-1" });
  });
});

describe("flush / dispose（docs/SESSION.md §1.5）", () => {
  it("flush 未知 id 失败；成功返回 flushed；错误经 Result 上浮", async () => {
    const h = makeStore();
    const store = createSessionStore(h.hooks);
    expect(await store.flush(sid("nope"))).toEqual({ ok: false, reason: "no-session:nope" });
    const s = unwrap(await store.create());
    expect(await store.flush(s.id)).toEqual({ ok: true, value: { flushed: true } });
    expect(h.flushes).toEqual([s.id]);
    h.setFlushError(new Error("io"));
    expect(await store.flush(s.id)).toEqual({ ok: false, reason: "flush-failed:io" });
  });

  it("dispose：广播恰一次、封存写权、读面开放", async () => {
    const h = makeStore();
    const store = createSessionStore(h.hooks);
    const s = unwrap(await store.create());
    s.append("turn/start", { turn: 0 });
    expect(store.dispose(s.id)).toEqual({ ok: true, value: true });
    expect(h.disposed).toEqual([s.id]);
    expect(store.dispose(s.id).ok).toBe(false);
    expect(store.get(s.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(s.append("turn/start", { turn: 1 })).toEqual({ ok: false, reason: "session-disposed" });
    expect(s.events()).toHaveLength(1);
  });

  it("flush 已 dispose 的会话 → no-session", async () => {
    const store = createSessionStore(makeStore().hooks);
    const s = unwrap(await store.create());
    store.dispose(s.id);
    expect(await store.flush(s.id)).toEqual({ ok: false, reason: `no-session:${s.id}` });
  });
});
