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
  it("实时段半写失败 → 降级闩（纵深防御）+ 截断回滚 + pending 保留；屏障恢复落盘全量、无重复字节（G1+G2）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: sid("fi") }));
    turn(s, 0);
    s.append("user/message", { turn: 0, step: 0, content: [] }, { surfaceOp: "append" });
    expect(await world.store.flush(s.id)).toEqual({ ok: true, value: true });
    const beforeText = await readFile(join(root, "fi", "events.jsonl"), "utf8");

    const proto = await fileHandleProto();
    const originalAppend = proto.appendFile;
    const spy = vi.spyOn(proto, "appendFile");
    spy.mockImplementationOnce(async function (this: FileHandle, data: string) {
      await originalAppend.call(this, data.slice(0, Math.floor(data.length / 2)));
      throw new Error("EIO-injected");
    });
    turn(s, 1);
    const realtimeFailed = async (): Promise<boolean> =>
      world.ioErrors.some((message) => message.includes("session-realtime-append-failed:fi"));
    await waitUntil(realtimeFailed);
    expect(await readFile(join(root, "fi", "events.jsonl"), "utf8")).toBe(beforeText);

    const callsAfterFailure = spy.mock.calls.length;
    turn(s, 2);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spy.mock.calls.length).toBe(callsAfterFailure);

    const retried = await world.store.flush(s.id);
    expect(retried).toEqual({ ok: true, value: true });
    const text = await readFile(join(root, "fi", "events.jsonl"), "utf8");
    expect(text).toBe(`${beforeText}${JSON.stringify(s.events()[2])}\n${JSON.stringify(s.events()[3])}\n`);
    const read = unwrap(await world.archive.read(sid("fi")));
    expect(read.events).toEqual(s.events());
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
      await gate;
      return originalAppend.call(this, data);
    });
    const flushP = world.store.flush(s.id);
    await entered;
    world.store.dispose(s.id);
    release();
    expect(await flushP).toEqual({ ok: true, value: true });
    await waitUntil(async () => {
      const read = await world.archive.read(sid("race"));
      return read.ok && read.value.events.length === 2;
    });
    const read = unwrap(await world.archive.read(sid("race")));
    expect(read.events).toEqual(s.events());
    const seqs = read.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
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
      await gate;
      return originalSync.call(this);
    });
    world.store.dispose(gen1.id);

    const gen2 = unwrap(await world.store.create({ header: snapshot.header, seed: snapshot.events }));
    turn(gen2, 1);
    const flushP = world.store.flush(gen2.id);
    await entered;
    release();
    expect(await flushP).toEqual({ ok: true, value: true });
    const read = unwrap(await world.archive.read(sid("chain")));
    expect(read.events).toEqual(gen2.events());
    const seqs = read.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it("终排空失败不泄漏 fd：drain 抛错后 writer.close 仍然执行（F4）", async () => {
    world = await makeWorld(root);
    const s = unwrap(await world.store.create({ id: sid("leak") }));
    turn(s, 0);
    await world.store.flush(s.id);
    const failProto = await fileHandleProto();
    vi.spyOn(failProto, "appendFile").mockImplementation(async () => {
      throw new Error("EIO-permanent");
    });
    const closeSpy = vi.spyOn(await fileHandleProto(), "close");
    turn(s, 1);
    world.store.dispose(s.id);
    const leakReported = (): boolean => world.ioErrors.some((message) => message.includes("session-dispose-persist-failed:leak"));
    await waitUntil(async () => leakReported());
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
