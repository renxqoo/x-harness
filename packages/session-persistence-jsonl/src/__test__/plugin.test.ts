import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context, Plugin } from "@x-harness/core";
import type { Session, SessionId } from "@x-harness/session";
import { sessionArchive as sessionArchiveToken } from "@x-harness/session";
import { sessionAuditEvent, sessionStore as sessionStoreToken } from "@x-harness/session";
import { createJsonlSessionPersistence } from "../plugin.ts";
import { makeWorld, unwrap, waitUntil } from "./helpers.ts";
import type { World } from "./helpers.ts";


let root: string;
let world: World;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-jsonl-"));
});

afterEach(async () => {
  await world.ctx.dispose().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const append = { surfaceOp: "append" } as const;

function turn(s: Session, n: number): void {
  s.append("turn/start", { turn: n });
}

describe("全链路落盘（docs/SESSION.md §1.8 链来源与时序）", () => {
  it("flush 屏障后 read 逐字节对账（活回路增量排空）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "s1" as SessionId }));
    turn(s, 0);
    s.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }, append);
    s.append("tool/result", { turn: 0, step: 0, callId: "c", content: "ok" }, append);
    expect(await world.store.flush(s.id)).toEqual({ ok: true, value: true });
    const read = unwrap(await world.archive.read(s.id));
    expect(read.events).toEqual(s.events());
    expect(read.header.id).toBe(s.id);
  });

  it("实时写盘：事件经审计通道即落 fd，不调 flush 轮询可见（症状：未到屏障的崩溃丢事件）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "rt" as SessionId }));
    turn(s, 0);
    expect(await world.store.flush(s.id)).toEqual({ ok: true, value: true }); // 确保 writer 已开
    turn(s, 1);
    turn(s, 2); // 全程无 flush——实时段（审计投递 → 链上 append，不 fsync）负责落盘
    await waitUntil(async () => {
      const read = unwrap(await world.archive.read(s.id));
      return read.events.length === 3;
    });
    const read = unwrap(await world.archive.read(s.id));
    expect(read.events).toEqual(s.events()); // 逐事件对账（含日志序）
  });

  it("首灌含构造期事件：fork 子会话落盘 = 前缀 + inherited end-seed", async () => {
    world = await makeWorld(root);
    const parent = unwrap(await world.store.create({ id: "p" as SessionId }));
    turn(parent, 0);
    parent.append("user/message", { turn: 0, step: 0, content: [] }, append);
    await world.store.flush(parent.id);

    const child = unwrap(await world.store.fork(parent.id, { id: "child" as SessionId }));
    expect(await world.store.flush(child.id)).toEqual({ ok: true, value: true });
    const read = unwrap(await world.archive.read("child" as SessionId));
    expect(read.events.map((event) => event.type)).toEqual(["turn/start", "user/message", "session/end-seed"]);
    expect(read.events[2]?.data).toEqual({ inherited: true });
    expect(read.header.parentSession).toBe("p");
  });

  it("resume 回灌：read → create({id, seed, parent}) 血缘不断链", async () => {
    world = await makeWorld(root);
    const parent = unwrap(await world.store.create({ id: "p" as SessionId }));
    turn(parent, 0);
    await world.store.flush(parent.id);
    const child = unwrap(await world.store.fork(parent.id, { id: "c" as SessionId }));
    await world.store.flush(child.id);
    world.store.dispose(child.id);

    const snapshot = unwrap(await world.archive.read("c" as SessionId));
    const resumed = unwrap(
      await world.store.create({
        id: "c" as SessionId,
        seed: snapshot.events,
        parent: snapshot.header.parentSession,
      }),
    );
    expect(resumed.header.parentSession).toBe("p");
    const resumedEvents = resumed.events();
    expect(resumedEvents.slice(0, snapshot.events.length)).toEqual(snapshot.events);
    expect(resumedEvents[snapshot.events.length]?.type).toBe("session/end-seed");
    expect(resumedEvents[snapshot.events.length]?.data).toEqual({});
  });

  it("空会话（仅 header）也可持久化：created 首灌无需任何 append", async () => {
    world = await makeWorld(root);
    unwrap(await world.store.create({ id: "bare" as SessionId }));
    await waitUntil(async () => world.archive.list().includes("bare" as SessionId));
    const read = await world.archive.read("bare" as SessionId);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.events).toEqual([]);
  });
});

describe("串行链不变量（docs/SESSION.md §1.8 per-id 串行）", () => {
  it("并发 flush 同 id 不交错、不重复落盘", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "cc" as SessionId }));
    for (let i = 0; i < 5; i++) turn(s, i);
    const results = await Promise.all([world.store.flush(s.id), world.store.flush(s.id), world.store.flush(s.id)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const read = unwrap(await world.archive.read("cc" as SessionId));
    expect(read.events).toHaveLength(5);
    expect(read.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(read.events).toEqual(s.events());
  });

  it("dispose 链终排空：append 后直接 dispose（无 flush）→ 落盘全量", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "dd" as SessionId }));
    turn(s, 0);
    turn(s, 1);
    world.store.dispose(s.id);
    await waitUntil(async () => {
      const read = await world.archive.read("dd" as SessionId);
      return read.ok && read.value.events.length === 2;
    });
  });

  it("插件卸载排空：pending 有货时卸载 → 全部落盘（docs/SESSION.md §1.8 终排空）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "uu" as SessionId }));
    turn(s, 0);
    turn(s, 1);
    await world.unload[1]!(); // 装载序 [session, jsonl]：卸载 jsonl 插件
    const read = unwrap(await world.archive.read("uu" as SessionId));
    expect(read.events).toHaveLength(2);
  });
});

describe("同 id 重用 fail-closed（docs/SESSION.md §1.8 排他创建）", () => {
  it("dispose 后重建同 id（新 header）：旧档逐字节不变、flush 失败 session-id-reused、onIoError 上报、dead 闩稳定", async () => {
    world = await makeWorld(root);
    const first = unwrap(await world.store.create({ id: "dup" as SessionId }));
    turn(first, 0);
    first.append("user/message", { turn: 0, step: 0, content: [] }, append);
    expect(await world.store.flush("dup" as SessionId)).toEqual({ ok: true, value: true });
    const before = await world.archive.read("dup" as SessionId);
    world.store.dispose("dup" as SessionId);
    await new Promise((resolve) => { setTimeout(resolve, 3); }); // 跨毫秒，确保新 header createdAt 严格不同

    const second = unwrap(await world.store.create({ id: "dup" as SessionId }));
    turn(second, 99);
    const flushed = await world.store.flush("dup" as SessionId);
    expect(flushed.ok).toBe(false);
    if (!flushed.ok) expect(flushed.reason).toContain("session-id-reused:dup");
    const reuseReported = (): boolean => world.ioErrors.some((message) => message.includes("session-id-reused:dup"));
    await waitUntil(async () => reuseReported());
    // dead 闩：第二次 flush 仍报 session-id-reused（docs/SESSION-RESUME 审查 #8）
    const again = await world.store.flush("dup" as SessionId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("session-id-reused:dup");

    const after = await world.archive.read("dup" as SessionId);
    expect(after.ok).toBe(true);
    expect(before.ok).toBe(true);
    if (!after.ok || !before.ok) return;
    expect(after.value.events).toEqual(before.value.events); // 旧档零损毁
    expect(after.value.header).toEqual(before.value.header);
  });

  it("篡改 seed（非磁盘前缀）→ 续写校验拒，旧档不变（docs/SESSION-RESUME §7 续写拒配）", async () => {
    world = await makeWorld(root);
    const first = unwrap(await world.store.create({ id: "tam" as SessionId }));
    turn(first, 0);
    await world.store.flush("tam" as SessionId);
    const snapshot = unwrap(await world.archive.read("tam" as SessionId));
    world.store.dispose("tam" as SessionId);

    const shorter = snapshot.events.slice(0, -1); // 磁盘比当前日志长 → 前缀反向
    const made = await world.store.create({ header: snapshot.header, seed: shorter });
    expect(made.ok).toBe(true);
    if (made.ok) turn(made.value, 1);
    const flushed = await world.store.flush("tam" as SessionId);
    expect(flushed.ok).toBe(false);
    if (!flushed.ok) expect(flushed.reason).toContain("archive-prefix-mismatch:tam");
    const after = unwrap(await world.archive.read("tam" as SessionId));
    expect(after.events).toEqual(snapshot.events);
  });
});

describe("turn/end reason 持久往返（DSH session.spec 承接：六态 reason 逐一对账）", () => {
  it.each([
    [{ kind: "completed" as const }],
    [{ kind: "aborted" as const }],
    [{ kind: "blocked" as const }],
    [{ kind: "error" as const, message: "boom", code: "E_API" }],
    [{ kind: "max-tokens" as const }],
    [{ kind: "interrupted" as const }],
  ])("reason %j 落盘读回逐字节一致", async (reason) => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "rt" as SessionId }));
    s.append("turn/start", { turn: 0 });
    s.append("turn/end", { turn: 0, reason });
    expect(await world.store.flush("rt" as SessionId)).toEqual({ ok: true, value: true });
    const read = unwrap(await world.archive.read("rt" as SessionId));
    expect(read.events[1]?.data).toEqual({ turn: 0, reason });
    expect(read.events[1]?.data).toEqual(s.events()[1]?.data);
  });
});

describe("resume 续写主链（docs/SESSION-RESUME §1.4/§7）", () => {
  it("同 id 归档 header 回灌 → 追加不重复落盘 → 重启读全量", async () => {
    world = await makeWorld(root);
    const gen1 = unwrap(await world.store.create({ id: "rs" as SessionId }));
    turn(gen1, 0);
    gen1.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }, append);
    expect(await world.store.flush("rs" as SessionId)).toEqual({ ok: true, value: true });
    const snapshot = unwrap(await world.archive.read("rs" as SessionId));
    world.store.dispose("rs" as SessionId);
    await waitUntil(async () => {
      const read = await world.archive.read("rs" as SessionId);
      return read.ok && read.value.events.length === snapshot.events.length;
    });

    // resume：seed = 归档卷 + repair closers（此处无残 turn → closers 空），构造器补 end-seed
    const gen2 = unwrap(await world.store.create({ header: snapshot.header, seed: snapshot.events }));
    turn(gen2, 1);
    expect(await world.store.flush("rs" as SessionId)).toEqual({ ok: true, value: true });
    const r2 = unwrap(await world.archive.read("rs" as SessionId));
    const expected = [...snapshot.events, { type: "session/end-seed" }, { type: "turn/start" }];
    expect(r2.events.map((e) => e.type)).toEqual(expected.map((e) => (e as { type: string }).type));
    const seqs = r2.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // 无重复
    expect(r2.events).toEqual(gen2.events());
    expect(r2.header).toEqual(snapshot.header); // header 原文保留
  });

  it("二次续写幂等链：第二次前缀 = 第一次续写后全量", async () => {
    world = await makeWorld(root);
    const gen1 = unwrap(await world.store.create({ id: "chain" as SessionId }));
    turn(gen1, 0);
    await world.store.flush("chain" as SessionId);
    let snapshot = unwrap(await world.archive.read("chain" as SessionId));
    world.store.dispose("chain" as SessionId);

    for (const round of [1, 2]) {
      await waitUntil(async () => {
        const read = await world.archive.read("chain" as SessionId);
        return read.ok && read.value.events.length === snapshot.events.length;
      });
      const next = unwrap(await world.store.create({ header: snapshot.header, seed: snapshot.events }));
      turn(next, round);
      expect(await world.store.flush("chain" as SessionId)).toEqual({ ok: true, value: true });
      const read = unwrap(await world.archive.read("chain" as SessionId));
      const seqs = read.events.map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(read.events).toEqual(next.events());
      snapshot = read;
      world.store.dispose("chain" as SessionId);
    }
  });
});


describe("flush 失败路由（docs/SESSION.md §1.8 I/O 失败路由）", () => {
  it("created 首灌失败（root 不可写）→ flush 上浮失败 + onIoError 记录", async () => {
    const fileRoot = join(root, "blocker");
    await writeFile(fileRoot, "x");
    const blocked = await makeWorld(fileRoot);
    world = blocked;
    const made = await blocked.store.create();
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    turn(made.value, 0);
    const flushed = await blocked.store.flush(made.value.id);
    expect(flushed.ok).toBe(false);
    await waitUntil(() => Promise.resolve(blocked.ioErrors.length > 0));
  });

  it("晚装载（错过 created）的会话：append 后 flush fail-closed，不写盘（症状：曾写literal undefined header）", async () => {
    // 装配序 session → creator → jsonl：creator 在 apply 期建会话，其 created 早于 jsonl 装载
    const creatorPlugin = {
      name: "creator",
      inject: ["session"],
      apply: async (ctx: Context) => {
        await ctx.use(sessionStoreToken).create({ id: "late" as SessionId });
      },
    } satisfies Plugin;
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const { sessionPlugin } = await import("@x-harness/session");
    const ioErrors: string[] = [];
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      creatorPlugin,
      createJsonlSessionPersistence({ root, onIoError: (message) => ioErrors.push(message) }),
    ]);
    const store = ctx.use(sessionStoreToken);
    world = { ctx, store, archive: ctx.use(sessionArchiveToken), unload, ioErrors };

    const made = await store.create({ id: "late2" as SessionId }); // 对照：正常会话可落盘
    expect(made.ok).toBe(true);
    if (made.ok) {
      turn(made.value, 0);
      expect(await store.flush(made.value.id)).toEqual({ ok: true, value: true });
    }

    // created 已错过的 "late"：新 append 建出无 header 条目 → flush 必须 fail-closed
    const late = store.get("late" as SessionId);
    expect(late).toBeDefined();
    if (late === undefined) return;
    turn(late, 0);
    const flushed = await store.flush("late" as SessionId);
    expect(flushed.ok).toBe(false);
    if (!flushed.ok) expect(flushed.reason).toContain("writer-unopened:late");
    const read = await world.archive.read("late" as SessionId);
    expect(read.ok).toBe(false); // 无 header，不落盘
  });
});

describe("排空竞态（回归：活引用批次长度膨胀误切未写事件）", () => {
  it("回归：排空期间新到事件不丢——二次 flush 后全部在盘", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: "race" as SessionId }));
    turn(s, 0);
    // marker 事件广播时挂 macrotask：在 writer.append 的 I/O await 窗口内追加新事件
    const appendSix = (): void => {
      turn(s, 6);
    };
    const off = world.ctx.on(sessionAuditEvent, ({ event }: { event: { data: unknown } }) => {
      if ((event.data as { turn?: number }).turn === 5) setTimeout(appendSix, 0);
    });
    turn(s, 5);
    expect(await world.store.flush(s.id)).toEqual({ ok: true, value: true });
    off();
    // 竞态新事件曾随活引用批次被误切丢弃（永不落盘）；修复后留在 pending，后续 flush 必然写出
    const turnsOnDisk = async (): Promise<Array<number | undefined>> => {
      const read = unwrap(await world.archive.read(s.id));
      return read.events.map((e) => (e.data as { turn?: number }).turn);
    };
    await waitUntil(async () => {
      expect(await world.store.flush(s.id)).toEqual({ ok: true, value: true });
      const turns = await turnsOnDisk();
      return turns.length === 3 && turns[0] === 0 && turns[1] === 5 && turns[2] === 6;
    });
  });
});
