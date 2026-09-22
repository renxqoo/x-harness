// 插件生命周期（docs/SANDBOX.md §1/§3）：假 srt runtime 注入缝——依赖缺失 fail-closed、双服务
// 可见、基线剖面、白名单热切换序列（授权即时生效/同集不切/sessionDisposed 收缩/networkOff 恒空）、
// env 清洗透传、拆卸契约（活句柄两段杀、fail-fast、wrap 期拆卸逃逸复查、单例占用与顺序复用）。
// 真内核执法面在 e2e.kernel.test.ts（darwin 默认门）。

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { toolsPlugin } from "@x-harness/tools";
import { createPermissionPlugin, permissionGrants } from "@x-harness/permission";
import { fenceFacts } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { execEnv } from "@x-harness/exec-env";
import { createSandboxPlugin } from "../plugin.ts";
import type { SrtFilesystem, SrtRuntime } from "../srt-runtime.ts";

interface FakeRuntime {
  readonly rt: SrtRuntime;
  readonly starts: SrtFilesystem[];
  readonly bindings: boolean[];
  readonly syncs: string[][];
  readonly resets: number;
  set failReset(value: boolean);
  setWrap(impl: (command: string) => readonly string[] | Promise<readonly string[]>): void;
  setDeps(errors: readonly string[]): void;
}

function makeFakeRuntime(): FakeRuntime {
  const starts: SrtFilesystem[] = [];
  const bindings: boolean[] = [];
  const syncs: string[][] = [];
  let resets = 0;
  let deps: readonly string[] = [];
  let failReset = false;
  let wrapImpl: (command: string) => readonly string[] | Promise<readonly string[]> = (command) => ["/bin/sh", "-c", command];
  const rt: SrtRuntime = {
    checkDeps: async () => deps,
    start: async (fs, allowLocalBinding) => {
      starts.push(fs);
      bindings.push(allowLocalBinding);
    },
    syncNetwork: (domains) => {
      syncs.push([...domains]);
    },
    wrap: async ({ command }) => wrapImpl(command),
    reset: async () => {
      resets += 1;
      if (failReset) throw new Error("reset boom");
    },
  };
  return {
    rt,
    starts,
    bindings,
    syncs,
    get resets() {
      return resets;
    },
    set failReset(value: boolean) {
      failReset = value;
    },
    setWrap: (impl) => {
      wrapImpl = impl;
    },
    setDeps: (errors) => {
      deps = errors;
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    text += dec.decode(read.value, { stream: true });
  }
  return text;
}

async function assemble(root: string, fake: FakeRuntime, options: Partial<Parameters<typeof createSandboxPlugin>[0]> = {}) {
  const ctx: Context = createContext();
  const unload = await loadPlugins(ctx, [
    toolsPlugin,
    createPermissionPlugin({ root }),
    createSandboxPlugin({ root, ...options }, fake.rt),
  ]);
  return { ctx, dispose: async () => { for (const d of [...unload].reverse()) await d(); } };
}

describe("createSandboxPlugin 装配", () => {
  it("依赖缺失 fail-closed 拒启（不占单例——后续装配可继续）", async () => {
    const fake = makeFakeRuntime();
    fake.setDeps(["sandbox-exec not found"]);
    const ctx = createContext();
    await expect(
      loadPlugins(ctx, [toolsPlugin, createPermissionPlugin({ root: "/w" }), createSandboxPlugin({ root: "/w" }, fake.rt)]),
    ).rejects.toThrow(/sandbox dependencies unavailable: sandbox-exec not found/);
  });

  it("双服务可见 + 基线剖面取最紧空集（文件面真值恒随 per-exec fence——fail-closed）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxasm-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      expect(ctx.tryUse(execEnv)?.kind).toBe("sandbox");
      const facts = ctx.tryUse(fenceFacts);
      expect(facts?.forSession(undefined)).toEqual({ writable: expect.arrayContaining([root, tmpdir()]), allowedDomains: [] });
      expect(fake.starts).toHaveLength(1);
      expect(fake.starts[0]).toEqual({ denyRead: [], allowWrite: [], denyWrite: [] });
      expect(fake.bindings).toEqual([true]); // 缺省开——用户裁决④（沙箱内本地工作流可用）
      await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("多实例共享 srt 会话：并发第二实例装配成功；域名并集；先退只收缩、末退才 reset", async () => {
    const fake = makeFakeRuntime(); // 同一 runtime → 同一共享点（WeakMap 键控）
    const rootA = mkdtempSync(join(tmpdir(), "xh-sbxm1-"));
    const rootB = mkdtempSync(join(tmpdir(), "xh-sbxm2-"));
    try {
      const a = await assemble(rootA, fake, { allowedDomains: ["a.test"] });
      const b = await assemble(rootB, fake, { allowedDomains: ["b.test"] });
      // 第二实例 spawn → 跨实例并集热切换
      const spawned = await b.ctx.use(execEnv).spawn({ argv: ["/bin/true"], cwd: rootB });
      expect(spawned.ok).toBe(true);
      expect(fake.syncs.at(-1)).toEqual(["a.test", "b.test"]);
      expect(fake.resets).toBe(0); // 仍有活实例
      await a.dispose(); // 先退：收缩白名单（余 b）
      expect(fake.resets).toBe(0);
      expect(fake.starts).toHaveLength(1); // 共享启动一次
      await b.dispose(); // 末退：reset
      expect(fake.resets).toBe(1);
      const again = await assemble(rootA, fake); // 释放后可重新启动
      await again.dispose();
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe("spawn 面（假 runtime 管道）", () => {
  it("wrap 命令文本 = exec 词法封装；子进程 env 清洗透传（SECRET 不达子进程）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxspw-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      const spawned = await ctx.use(execEnv).spawn({
        argv: ["/bin/sh", "-c", "echo v=[$MY_SECRET_X] s=[$SAFE_X]"],
        cwd: root,
        env: { PATH: process.env.PATH ?? "/bin", MY_SECRET_X: "leak", SAFE_X: "ok" },
      });
      if (!spawned.ok) throw new Error(spawned.reason.detail);
      const out = (await drain(spawned.proc.stdout)).trim();
      await spawned.proc.settled;
      expect(out).toBe("v=[] s=[ok]"); // 密钥键剥除；非密钥键透传
      expect(fake.syncs).toEqual([[]]); // 首次热切换（空表）
      await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("白名单热切换序列：同集不切；域名授权即时生效；sessionDisposed 即时收缩（不等下一次 spawn）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxnet-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      const grants = ctx.use(permissionGrants);
      const sid = "s-net" as never;
      const env = ctx.use(execEnv);
      await env.spawn({ argv: ["/bin/true"], cwd: root, session: sid }); // sync#1: []
      await env.spawn({ argv: ["/bin/true"], cwd: root, session: sid }); // 同集不切
      expect(fake.syncs).toEqual([[]]);
      grants.recordDomain(sid, "a.test", "allow");
      await env.spawn({ argv: ["/bin/true"], cwd: root, session: sid }); // sync#2: [a.test]
      expect(fake.syncs).toEqual([[], ["a.test"]]);
      ctx.emit(sessionDisposed, { session: sid }); // 逐出→收缩立即落表（sync#3: []）
      expect(fake.syncs).toEqual([[], ["a.test"], []]);
      await env.spawn({ argv: ["/bin/true"], cwd: root }); // 收缩后同集不切
      expect(fake.syncs).toEqual([[], ["a.test"], []]);
      await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("并发首装串行化：两个世界 Promise.all 装配——共享启动恰一次（双启动=代理泄漏）", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "xh-sbxpar1-"));
    const rootB = mkdtempSync(join(tmpdir(), "xh-sbxpar2-"));
    const fake = makeFakeRuntime();
    try {
      const [a, b] = await Promise.all([assemble(rootA, fake), assemble(rootB, fake)]);
      expect(fake.starts).toHaveLength(1);
      await a.dispose();
      await b.dispose();
      expect(fake.resets).toBe(1);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("wrap 抛错收殓为判别联合 sandbox_unavailable（不裸 rejection——ExecEnv 契约）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxthr-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      fake.setWrap(() => {
        throw new Error("shell not found in PATH");
      });
      const r = await ctx.use(execEnv).spawn({ argv: ["/bin/true"], cwd: root });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason.kind).toBe("sandbox_unavailable");
        expect(r.reason.detail).toContain("shell not found");
      }
      await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detach（reset）抛错不阻断服务下线：服务已摘除、错误聚合上抛", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxrth-"));
    const fake = makeFakeRuntime();
    fake.failReset = true;
    try {
      const { ctx, dispose } = await assemble(root, fake);
      const env = ctx.use(execEnv);
      await expect(dispose()).rejects.toThrow(/reset boom/);
      expect(ctx.tryUse(execEnv)).toBeUndefined(); // offs 已执行——半拆卸不泄漏服务
      const after = await env.spawn({ argv: ["/bin/true"], cwd: root });
      expect(after.ok).toBe(false); // fail-fast 照常
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allowLocalBinding：显式 false 传入 start；实例间不一致=装配期冲突 fail-fast；会话释放后可重启新值", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "xh-sbxlb1-"));
    const rootB = mkdtempSync(join(tmpdir(), "xh-sbxlb2-"));
    const fake = makeFakeRuntime();
    try {
      const strict = await assemble(rootA, fake, { allowLocalBinding: false });
      expect(fake.bindings).toEqual([false]);
      await expect(assemble(rootB, fake, { allowLocalBinding: true })).rejects.toThrow(/allowLocalBinding conflict/);
      await strict.dispose();
      const relaxed = await assemble(rootB, fake); // 会话已释放——新值可启动
      expect(fake.bindings).toEqual([false, true]);
      await relaxed.dispose();
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("空 argv 降级 not_found（不崩溃、不触 wrap）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxemp-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      const r = await ctx.use(execEnv).spawn({ argv: [], cwd: root });
      expect(r).toEqual({ ok: false, reason: { kind: "not_found", detail: "empty argv" } });
      await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("拆卸契约", () => {
  it("dispose：活句柄两段杀→settled→reset→claimed 释放；dispose 后 spawn fail-fast", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxdis-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      const spawned = await ctx.use(execEnv).spawn({ argv: ["/bin/sh", "-c", "sleep 30"], cwd: root });
      if (!spawned.ok) throw new Error(spawned.reason.detail);
      const exited = spawned.proc.exited;
      const env = ctx.use(execEnv); // 先捕获——dispose 后服务下线，语义面向已持引用的调用方
      await dispose();
      expect(await exited).not.toBe(0); // 已被 term 杀
      expect(fake.resets).toBe(1);
      const after = await env.spawn({ argv: ["/bin/true"], cwd: root });
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.reason.kind).toBe("sandbox_unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wrap 在飞时拆卸：逃逸复查自杀（不交还调用方）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxesc-"));
    const fake = makeFakeRuntime();
    try {
      const { ctx, dispose } = await assemble(root, fake);
      let releaseWrap: (() => void) | undefined;
      fake.setWrap(
        () =>
          new Promise((resolve) => {
            releaseWrap = () => resolve(["/bin/true"]);
          }),
      );
      const inFlight = ctx.use(execEnv).spawn({ argv: ["/bin/true"], cwd: root });
      await new Promise((r) => {
        setTimeout(r, 20);
      }); // wrap 已在飞
      const disposing = dispose();
      await new Promise((r) => {
        setTimeout(r, 20);
      });
      releaseWrap?.();
      const r = await inFlight;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.kind).toBe("sandbox_unavailable");
      await disposing;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
