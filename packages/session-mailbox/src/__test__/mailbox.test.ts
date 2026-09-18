// session-mailbox 单测（docs/AGENT-DELEGATION.md §5.3/§5.4/§11.2）：
// 原子性三则、开箱认领、抢占单读者、墓碑两步回收、订阅结算、timing 注入。

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createContext } from "@x-harness/core";
import { createMailboxService, validateTiming } from "../service.ts";
import { createMailboxPlugin, defaultTiming } from "../plugin.ts";
import { mailboxService } from "../tokens.ts";
import type { BoxManifest, MailboxTiming } from "../types.ts";

const DEAD_PID = 999_999_999; // 超出 pid 上限——kill 恒 ESRCH

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

function makeTiming(over: Partial<MailboxTiming> = {}): MailboxTiming & { advance: (ms: number) => void } {
  let nowMs = 1_000_000;
  const timing: MailboxTiming = {
    pollIntervalMs: 300,
    heartbeatMs: 10_000,
    graceMs: 30_000,
    staleMs: 7 * 24 * 3_600_000,
    now: () => nowMs,
    ...over,
  };
  return { ...timing, advance: (ms) => (nowMs += ms) } as MailboxTiming & { advance: (ms: number) => void };
}

async function makeRoot(): Promise<{ root: string; warn: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "xh-mailbox-"));
  const warn: string[] = [];
  return { root, warn };
}

function serviceOf(root: string, timing: MailboxTiming, warn: string[]) {
  return createMailboxService({ root, timing, onWarn: (m) => warn.push(m) });
}

async function rawManifest(root: string, box: string, manifest: BoxManifest): Promise<void> {
  await mkdir(join(root, box), { recursive: true });
  await writeFile(join(root, box, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}

describe("session-mailbox", () => {
  it("开箱：manifest 落盘、bootId/ref 形态、坏名拒绝", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    const box = await svc.open("alpha");
    expect(box.name).toBe("alpha");
    expect(box.bootId).toMatch(/^[0-9a-f]{12}$/);
    expect(box.ref).toMatch(/^[0-9a-f]{6}$/);
    const manifest = JSON.parse(await readFile(join(root, "alpha", "manifest.json"), "utf8")) as BoxManifest;
    expect(manifest.pid).toBe(process.pid);
    expect(manifest.status).toBe("idle");
    await expect(svc.open("bad/name")).rejects.toThrow("invalid-args");
    await expect(svc.open("")).rejects.toThrow("invalid-args");
  });

  it("开箱：活箱真重名构造期 throw", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    await svc.open("dup");
    await expect(svc.open("dup")).rejects.toThrow("box-name-taken");
  });

  it("开箱认领：死 pid 箱被接管并清 inbox/subs 残留", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, []);
    await rawManifest(root, "ghost", { pid: DEAD_PID, bootId: "aabbccddeeff", status: "running", updatedTs: timing.now() });
    await mkdir(join(root, "ghost", "inbox"), { recursive: true });
    await mkdir(join(root, "ghost", "subs"), { recursive: true });
    await writeFile(join(root, "ghost", "inbox", "stale.proc"), "x");
    await writeFile(join(root, "ghost", "subs", "old.json"), "{}");
    const box = await svc.open("ghost");
    expect(box.bootId).not.toBe("aabbccddeeff");
    expect(await readdir(join(root, "ghost", "inbox"))).toEqual([]);
    expect(await readdir(join(root, "ghost", "subs"))).toEqual([]);
  });

  it("开箱认领：pid 活但心跳超宽限（断流三拍）也认领", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, []);
    await rawManifest(root, "stuck", { pid: process.pid, bootId: "aabbccddeeff", status: "idle", updatedTs: timing.now() });
    timing.advance(31_000);
    await expect(svc.open("stuck")).resolves.toBeTruthy();
  });

  it("setStatus 即时重写；beat 保留当前 status（心跳不打回 idle）", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    const box = await svc.open("stat");
    await box.setStatus("running");
    let manifest = JSON.parse(await readFile(join(root, "stat", "manifest.json"), "utf8")) as BoxManifest;
    expect(manifest.status).toBe("running");
    await box.beat();
    manifest = JSON.parse(await readFile(join(root, "stat", "manifest.json"), "utf8")) as BoxManifest;
    expect(manifest.status).toBe("running");
  });

  it("周期心跳推进 updatedTs，停止后不再推进", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming({ heartbeatMs: 5, now: () => Date.now() });
    const svc = serviceOf(root, timing, []);
    const box = await svc.open("beat");
    const before = (JSON.parse(await readFile(join(root, "beat", "manifest.json"), "utf8")) as BoxManifest).updatedTs;
    const stop = box.startHeartbeat();
    await sleep(25);
    stop();
    const after = (JSON.parse(await readFile(join(root, "beat", "manifest.json"), "utf8")) as BoxManifest).updatedTs;
    expect(after).toBeGreaterThan(before);
    await sleep(15);
    const settled = (JSON.parse(await readFile(join(root, "beat", "manifest.json"), "utf8")) as BoxManifest).updatedTs;
    expect(settled).toBe(after);
  });

  it("投递：活箱得 .msg（无 .tmp 残留）；死箱 not-live", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, []);
    const box = await svc.open("t1");
    const sent = await svc.send("t1", { from: box.name, message: "hello", kind: "message" });
    expect(sent.ok).toBe(true);
    expect(await readdir(join(root, "t1", "inbox"))).toEqual([`${sent.id}.msg`]);
    await rawManifest(root, "dead", { pid: DEAD_PID, bootId: "aabbccddeeff", status: "idle", updatedTs: timing.now() });
    const refused = await svc.send("dead", { from: "t1", message: "x", kind: "message" });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("not-live:dead");
  });

  it("排空：按 ts 排序返回并清空；坏信封丢弃走 onWarn", async () => {
    const { root, warn } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, warn);
    await svc.open("t2");
    timing.advance(1);
    await svc.send("t2", { from: "a", message: "first", kind: "message" });
    timing.advance(1);
    await svc.send("t2", { from: "a", message: "second", kind: "message" });
    await writeFile(join(root, "t2", "inbox", "broken.msg"), "{not json");
    const drained = await svc.drain("t2");
    expect(drained.map((e) => e.message)).toEqual(["first", "second"]);
    expect(warn.some((m) => m.includes("malformed"))).toBe(true);
    expect(await readdir(join(root, "t2", "inbox"))).toEqual([]);
    expect(await svc.drain("t2")).toEqual([]);
  });

  it("排空抢占：并发两路 drain 恰好一次（单读者语义）", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    await svc.open("t3");
    for (let i = 0; i < 20; i++) {
      await svc.send("t3", { from: "x", message: `m${String(i)}`, kind: "message" });
    }
    const [batchA, batchB] = await Promise.all([svc.drain("t3"), svc.drain("t3")]);
    const ids = [...batchA, ...batchB].map((e) => e.id);
    expect(new Set(ids).size).toBe(20);
    expect(batchA.length + batchB.length).toBe(20);
  });

  it("订阅：add/list/remove 往返；同 from 覆盖不累积", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    await svc.open("target");
    await svc.subs.add("target", "watcher");
    await svc.subs.add("target", "watcher");
    await svc.subs.add("target", "other");
    expect(await svc.subs.list("target")).toEqual(["other", "watcher"].sort());
    await svc.subs.remove("target", "watcher");
    expect(await svc.subs.list("target")).toEqual(["other"]);
  });

  it("发现：活箱带 ref/status 列出；死箱不列", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, []);
    const box = await svc.open("live");
    await box.setStatus("running");
    await rawManifest(root, "dead", { pid: DEAD_PID, bootId: "aabbccddeeff", status: "idle", updatedTs: timing.now() });
    const found = await svc.discover();
    expect(found.map((b) => b.name)).toEqual(["live"]);
    expect(found[0]?.status).toBe("running");
    expect(found[0]?.ref).toMatch(/^[0-9a-f]{6}$/);
  });

  it("陈尸回收：discover 惰性回收（目录消失）并向订阅方结算 idle-expired", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, []);
    const watcher = await svc.open("watcher");
    await rawManifest(root, "gone", { pid: DEAD_PID, bootId: "aabbccddeeff", status: "running", updatedTs: timing.now() });
    await mkdir(join(root, "gone", "subs"), { recursive: true });
    await writeFile(join(root, "gone", "subs", `${watcher.name}.json`), `{"from":"${watcher.name}","ts":0}`);
    timing.advance(7 * 24 * 3_600_000 + 1); // 超 staleMs
    const found = await svc.discover();
    expect(found.map((b) => b.name)).not.toContain("gone");
    const drained = await svc.drain("watcher");
    expect(drained).toHaveLength(1);
    expect(drained[0]?.kind).toBe("idle-expired");
    expect(drained[0]?.message).toContain("expired");
  });

  it("墓碑两步：rename 后复验见活 → 还原不删、不结算", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    const watcher = await svc.open("watcher2");
    await svc.open("victim");
    await svc.subs.add("victim", watcher.name);
    await svc.reclaim("victim", {
      afterTombstone: async (tomb) => {
        // 模拟判尸后、搬走前 owner 重写 manifest（活 pid）——rename 搬走的是新 manifest
        await writeFile(join(tomb, "manifest.json"), `${JSON.stringify({ pid: process.pid, bootId: "aabbccddeeff", status: "running", updatedTs: Date.now() })}\n`);
      },
    });
    expect((await svc.discover()).map((b) => b.name)).toContain("victim");
    expect(await svc.drain(watcher.name)).toEqual([]);
    expect(await svc.subs.list("victim")).toEqual([watcher.name]);
  });

  it("关箱：目录删除，重开即新 bootId", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    const box = await svc.open("bye");
    await box.close();
    const again = await svc.open("bye");
    expect(again.bootId).not.toBe(box.bootId);
  });

  it("配置垃圾值 fail-fast", () => {
    const base = makeTiming();
    expect(() => validateTiming({ ...base, pollIntervalMs: 0 })).toThrow();
    expect(() => validateTiming({ ...base, heartbeatMs: 1.5 })).toThrow();
    expect(() => validateTiming({ ...base, staleMs: Number.NaN })).toThrow();
    expect(() => validateTiming({ ...base, now: undefined as unknown as () => number })).toThrow();
    expect(() => validateTiming(defaultTiming())).not.toThrow();
  });

  it("插件装配：provide 服务、root 三级解析（custom > env > 缺省）", async () => {
    const custom = await mkdtemp(join(tmpdir(), "xh-mailbox-"));
    const ctx = createContext();
    createMailboxPlugin({ root: custom, timing: makeTiming() }).apply(ctx);
    expect(ctx.use(mailboxService).root).toBe(custom);

    const envRoot = await mkdtemp(join(tmpdir(), "xh-mailbox-env-"));
    process.env["X_HARNESS_MAILBOX_DIR"] = envRoot;
    try {
      const ctx2 = createContext();
      createMailboxPlugin({ timing: makeTiming() }).apply(ctx2);
      expect(ctx2.use(mailboxService).root).toBe(envRoot);
    } finally {
      delete process.env["X_HARNESS_MAILBOX_DIR"];
    }
    const ctx3 = createContext();
    createMailboxPlugin({ timing: makeTiming() }).apply(ctx3);
    expect(ctx3.use(mailboxService).root).toBe(join(homedir(), ".x-harness", "mailbox"));
  });

  it("投递：坏名 invalid-args；信封形状坏（合法 JSON 缺字段）丢弃走 onWarn", async () => {
    const { root, warn } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), warn);
    await svc.open("t4");
    const bad = await svc.send("t4", { from: "bad/name", message: "x", kind: "message" });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("invalid-args");
    await writeFile(join(root, "t4", "inbox", "shape.msg"), `{"id":1}`);
    const drained = await svc.drain("t4");
    expect(drained).toEqual([]);
    expect(warn.some((m) => m.includes("malformed"))).toBe(true);
  });

  it("排空：不可读信封（mode 000）丢弃走 onWarn；rename 失败（同名 .proc 目录占位）跳过", async () => {
    const { root, warn } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), warn);
    await svc.open("t5");
    await writeFile(join(root, "t5", "inbox", "unreadable.msg"), `{"id":"a"}`, { mode: 0o000 });
    expect(await svc.drain("t5")).toEqual([]);
    expect(warn.some((m) => m.includes("unreadable"))).toBe(true);
    const stuck = await svc.send("t5", { from: "x", message: "stuck", kind: "message" });
    await mkdir(join(root, "t5", "inbox", `${String(stuck.id)}.proc`));
    expect(await svc.drain("t5")).toEqual([]);
    expect(await readdir(join(root, "t5", "inbox"))).toContain(`${String(stuck.id)}.msg`);
  });

  it("订阅：坏名 throw", async () => {
    const { root } = await makeRoot();
    const svc = serviceOf(root, makeTiming(), []);
    await expect(svc.subs.add("bad/name", "x")).rejects.toThrow("invalid-args");
  });

  it("发现：root 不存在 → 空清单；manifest 形状坏按死箱不列", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(join(root, "nope"), timing, []);
    expect(await svc.discover()).toEqual([]);
    await rawManifest(root, "shaped", { pid: "x" } as unknown as BoxManifest);
    const svc2 = serviceOf(root, timing, []);
    expect((await svc2.discover()).map((b) => b.name)).toEqual([]);
  });

  it("回收：不存在的 box 无操作不抛；无 subs 的死箱不产 notice", async () => {
    const { root } = await makeRoot();
    const timing = makeTiming();
    const svc = serviceOf(root, timing, []);
    await svc.open("w");
    await expect(svc.reclaim("never-was")).resolves.toBeUndefined();
    await rawManifest(root, "bare", { pid: DEAD_PID, bootId: "aabbccddeeff", status: "idle", updatedTs: timing.now() });
    timing.advance(7 * 24 * 3_600_000 + 1);
    await svc.reclaim("bare");
    expect(await svc.drain("w")).toEqual([]);
    expect(await readdir(root)).toEqual([".tomb", "w"]);
  });
});
