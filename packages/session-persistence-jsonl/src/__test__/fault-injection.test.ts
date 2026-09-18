// 写路径故障注入：真实磁盘 + FileHandle 原型拦截（DSH jsonl.spec 故障注入技术承接）。
// 覆盖：append 半写回滚与重试无重复（G1/G2）、dispose 与在飞 flush 串行（G3）、
// 重生代与在飞终排空链继承（G4）、终排空失败不泄漏 fd（F4）。

import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionId } from "@x-harness/session";
import { makeWorld, unwrap, waitUntil } from "./helpers.ts";
import type { World } from "./helpers.ts";

let root: string;
let world: World;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-fi-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await world.ctx.dispose().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const sid = (id: string): SessionId => id as SessionId;

interface HandleProto {
  appendFile: (data: string) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

/** 运行时 FileHandle 值导出缺席环境下的原型探测：任何真实句柄共享同一原型 */
async function fileHandleProto(): Promise<HandleProto> {
  const probe = await open(join(root, "probe"), "a");
  try {
    return Object.getPrototypeOf(probe) as HandleProto;
  } finally {
    await probe.close();
  }
}
const turn = (s: Session, n: number): void => {
  s.append("turn/start", { turn: n });
};

describe("写路径故障注入（真实 fd + 原型拦截）", () => {
  it("append 半写失败 → 截断回滚 + pending 保留；恢复后重试落盘全量、无重复字节（G1+G2）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: sid("fi") }));
    turn(s, 0);
    s.append("user/message", { turn: 0, step: 0, content: [] }, { surfaceOp: "append" });
    expect(await world.store.flush(s.id)).toEqual({ ok: true, value: true });
    const beforeText = await readFile(join(root, "fi", "events.jsonl"), "utf8");

    turn(s, 1);
    turn(s, 2);
    const proto = await fileHandleProto();
    const originalAppend = proto.appendFile;
    const spy = vi.spyOn(proto, "appendFile");
    spy.mockImplementationOnce(async function (this: FileHandle, data: string) {
      await originalAppend.call(this, data.slice(0, Math.floor(data.length / 2))); // 半写后崩溃
      throw new Error("EIO-injected");
    });
    const failed = await world.store.flush(s.id);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toContain("EIO-injected");
    expect(await readFile(join(root, "fi", "events.jsonl"), "utf8")).toBe(beforeText); // 截断回滚到批前

    const retried = await world.store.flush(s.id); // spy 已耗尽，真实写
    expect(retried).toEqual({ ok: true, value: true });
    const text = await readFile(join(root, "fi", "events.jsonl"), "utf8");
    expect(text).toBe(`${beforeText}${JSON.stringify(s.events()[2])}\n${JSON.stringify(s.events()[3])}\n`);
    const read = unwrap(await world.archive.read(sid("fi")));
    expect(read.events).toEqual(s.events()); // 批次不丢、不重
  });

  it("dispose 与在飞 flush 同链串行：并发落账恰一次、无重复（G3）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: sid("race") }));
    turn(s, 0);
    turn(s, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const proto = await fileHandleProto();
    const originalAppend = proto.appendFile;
    const spy = vi.spyOn(proto, "appendFile");
    spy.mockImplementationOnce(async function (this: FileHandle, data: string) {
      enteredResolve();
      await gate; // 首灌批次悬停：dispose 在此窗口到达
      return originalAppend.call(this, data);
    });
    const flushP = world.store.flush(s.id);
    await entered;
    world.store.dispose(s.id); // 终排空必须排在在飞 flush 之后（同链）
    release();
    expect(await flushP).toEqual({ ok: true, value: true });
    await waitUntil(async () => {
      const read = await world.archive.read(sid("race"));
      return read.ok && read.value.events.length === 2;
    });
    const read = unwrap(await world.archive.read(sid("race")));
    expect(read.events).toEqual(s.events()); // 恰一次
    const seqs = read.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // 无重复
  });

  it("重生代与在飞终排空的链继承：resume 竞态下 seq 连续无交错（G4）", async () => {
    world = await makeWorld(root);
    const gen1 = unwrap(await world.store.create({ id: sid("chain") }));
    turn(gen1, 0);
    await world.store.flush(gen1.id);
    const snapshot = unwrap(await world.archive.read(sid("chain")));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const proto = await fileHandleProto();
    const originalSync = proto.sync;
    const spy = vi.spyOn(proto, "sync");
    spy.mockImplementationOnce(async function (this: FileHandle) {
      enteredResolve();
      await gate; // 旧代终排空悬停：新代 resume 在此窗口到达
      return originalSync.call(this);
    });
    world.store.dispose(gen1.id); // 终排空（空 pending → 仅 sync）被悬停

    const gen2 = unwrap(await world.store.create({ header: snapshot.header, seed: snapshot.events }));
    turn(gen2, 1);
    const flushP = world.store.flush(gen2.id); // 新代段落必须排在旧代 close 之后（链继承）
    await entered;
    release();
    expect(await flushP).toEqual({ ok: true, value: true });
    const read = unwrap(await world.archive.read(sid("chain")));
    expect(read.events).toEqual(gen2.events());
    const seqs = read.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // 连续无交错
  });

  it("终排空失败不泄漏 fd：drain 抛错后 writer.close 仍然执行（F4）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: sid("leak") }));
    turn(s, 0);
    await world.store.flush(s.id); // writer 已打开
    const failProto = await fileHandleProto();
    vi.spyOn(failProto, "appendFile").mockImplementation(async () => {
      throw new Error("EIO-permanent"); // 持续性写失败
    });
    const closeSpy = vi.spyOn(await fileHandleProto(), "close");
    turn(s, 1);
    world.store.dispose(s.id); // 终排空失败 → 错误捕获上报，但 close 必须发生
    const leakReported = (): boolean => world.ioErrors.some((message) => message.includes("session-dispose-persist-failed:leak"));
    await waitUntil(async () => leakReported());
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
