// 插件装配（docs/EXEC-ENV.md §5 拆卸契约 + §0 装配即围栏）：probe fail-closed 拒启注入缝、
// execEnv/fenceFacts 双服务可见、拆卸后新 spawn fail-fast（sandbox_unavailable——不裸跑）。

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Plugin } from "@x-harness/core";
import { toolsPlugin } from "@x-harness/tools";
import { createPermissionPlugin } from "@x-harness/permission";
import { createSandboxPlugin } from "../plugin.ts";
import { probeWrappers, assertProbes } from "../probe.ts";
import { execEnv } from "@x-harness/exec-env";
import { fenceFacts } from "@x-harness/permission";

describe("createSandboxPlugin（装配即围栏）", () => {
  it("probe fail-closed：linux bwrap 缺席注入态拒启文案可行动（不裸跑）", () => {
    const r = probeWrappers({ platform: "linux", which: () => null });
    expect(() => assertProbes(r, true)).toThrow(/refusing to run unfenced/);
    expect(() => assertProbes(r, false)).toThrow(/refusing to run unfenced/);
  });

  it("代理生命周期：allowlist 首次 spawn 惰性起口、同会话复用；sessionDisposed 关口（darwin 真链）", async () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "xh-sbxpr-"));
    try {
      const ctx = createContext();
      const { sessionStore } = await import("@x-harness/session");
      const { sessionPlugin } = await import("@x-harness/session");
      const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createPermissionPlugin({ root }), createSandboxPlugin({ root })]);
      const fenced = ctx.use(execEnv);
      const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
        const reader = stream.getReader();
        const dec = new TextDecoder();
        let text = "";
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          text += dec.decode(read.value, { stream: true });
        }
        return text;
      };
      const runEcho = async (session: unknown): Promise<string> => {
        const spawned = await fenced.spawn({ argv: ["/bin/sh", "-c", "echo pong"], cwd: root, ...(session !== undefined ? { session: session as never } : {}) });
        if (!spawned.ok) throw new Error("spawn failed");
        const text = await drain(spawned.proc.stdout);
        await spawned.proc.exited;
        await spawned.proc.settled;
        return text.trim();
      };
      expect(await runEcho(undefined)).toBe("pong"); // 惰性起口 + 命令照常
      expect(await runEcho(undefined)).toBe("pong"); // 同会话复用同一代理
      const created = await ctx.use(sessionStore).create();
      if (!created.ok) throw new Error("create failed");
      const session = created.value.id;
      expect(await runEcho(session)).toBe("pong"); // 新会话各自起口
      await ctx.use(sessionStore).dispose(session); // sessionDisposed → 关该会话代理口
      expect(await runEcho(session)).toBe("pong"); // 关口后新 spawn 重新起口
      for (const dispose of [...unload].reverse()) await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("networkOff：无需 socat/代理——off 档 spawn 直行（darwin 真链）", async () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "xh-sbxoff-"));
    try {
      const ctx = createContext();
      const unload = await loadPlugins(ctx, [toolsPlugin, createPermissionPlugin({ root }), createSandboxPlugin({ root, networkOff: true })]);
      const fenced = ctx.use(execEnv);
      const spawned = await fenced.spawn({ argv: ["/bin/sh", "-c", "echo off-ok"], cwd: root });
      if (!spawned.ok) throw new Error("spawn failed");
      const reader = spawned.proc.stdout.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        text += dec.decode(read.value, { stream: true });
      }
      await spawned.proc.exited;
      await spawned.proc.settled;
      expect(text.trim()).toBe("off-ok"); // off 档无代理依赖
      for (const dispose of [...unload].reverse()) await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("代理 ask 全链：域外 CONNECT 经 broker 裁决（拒→403；批→放行连上游）；broker 抛错 deny（darwin 真链）", async () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "xh-sbxask-"));
    try {
      let verdict: "allow" | "deny" = "deny";
      let asked = 0;
      const permissionMod = await import("@x-harness/permission");
      const broker: Plugin = {
        name: "scripted-broker",
        apply: (c: Context) =>
          c.provide(permissionMod.permissionBroker, {
            ask: async () => {
              asked += 1;
              return verdict;
            },
          }),
      };
      const ctx = createContext();
      const unload = await loadPlugins(ctx, [toolsPlugin, createPermissionPlugin({ root }), createSandboxPlugin({ root }), broker]);
      const fenced = ctx.use(execEnv);
      const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
        const reader = stream.getReader();
        const dec = new TextDecoder();
        let text = "";
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          text += dec.decode(read.value, { stream: true });
        }
        return text;
      };
      const fetchViaProxy = async (host: string): Promise<{ out: string; code: number | null }> => {
        const spawned = await fenced.spawn({ argv: ["/bin/sh", "-c", `curl -sS --proxytunnel --max-time 5 http://${host}:9/ 2>&1; echo RC:$?`], cwd: root });
        if (!spawned.ok) throw new Error("spawn failed");
        const out = await drain(spawned.proc.stdout);
        const done = await spawned.proc.exited;
        await spawned.proc.settled;
        return { out, code: done.code };
      };
      const denied = await fetchViaProxy("127.0.0.1"); // broker 拒 → 403 可见；负缓存（重试同域不重弹）
      expect(denied.out).toContain("403");
      expect(asked).toBe(1);
      const again = await fetchViaProxy("127.0.0.1"); // 同域重试命中负缓存——零新 ask
      expect(again.out).toContain("403");
      expect(asked).toBe(1);
      verdict = "allow";
      const allowed = await fetchViaProxy("127.0.0.2"); // 新域 → ask → 批 → 放行（上游 127.0.0.2:9 沉默——隧道已建立，非 403）
      expect(asked).toBe(2);
      expect(allowed.out).not.toContain("403"); // 隧道过代理放行（超时/拒连属上游侧）
      for (const dispose of [...unload].reverse()) await dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("拆卸契约：活句柄两段杀收口（kill 升级定时器路径）", async () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "xh-sbxdis-"));
    try {
      const ctx = createContext();
      const unload = await loadPlugins(ctx, [toolsPlugin, createPermissionPlugin({ root }), createSandboxPlugin({ root, networkOff: true })]);
      const fenced = ctx.use(execEnv);
      const spawned = await fenced.spawn({ argv: ["/bin/sh", "-c", "sleep 30"], cwd: root });
      if (!spawned.ok) throw new Error("spawn failed");
      const started = Date.now();
      for (const dispose of [...unload].reverse()) await dispose(); // 拆卸：TERM → settled（不必等满宽限）
      await spawned.proc.settled;
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("apply 提供 execEnv（围栏版）与 fenceFacts（会话解析）；拆卸后 spawn fail-fast", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-sbxp-"));
    try {
      const ctx = createContext();
      const unload = await loadPlugins(ctx, [toolsPlugin, createPermissionPlugin({ root }), createSandboxPlugin({ root })]);
      const fenced = ctx.use(execEnv);
      expect(fenced.kind).toBe("sandbox");
      const facts = ctx.use(fenceFacts).forSession(undefined);
      expect(facts.writable.length).toBeGreaterThan(0);
      // 拆卸契约：新 spawn fail-fast（真 spawn 会真跑命令——拆卸断言在 torn-down 后零进程）
      for (const dispose of [...unload].reverse()) await dispose();
      const spawned = await fenced.spawn({ argv: ["/bin/sh", "-c", "true"] });
      expect(spawned.ok).toBe(false);
      if (!spawned.ok) expect(spawned.reason.kind).toBe("sandbox_unavailable");
      expect(ctx.tryUse(execEnv)).toBeUndefined(); // 服务已撤
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
