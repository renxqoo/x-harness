// 插件装配（docs/EXEC-ENV.md §5/§7）：拼错规则拒启 / broker 缺席 ask→deny / ask 批→extraRoot 落账→
// 同会话二次免问 / deny 压过 allow / 默认拒读表工具面拒 / 审计每裁决一条 / 会话授权隔离 /
// sessionDisposed 逐出（经 session 插件真实事件）/ 未知工具保守 ask。真实 dispatch 管线全链。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolOutcome } from "@x-harness/tools";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createPermissionPlugin, permissionBroker, permissionDecided, permissionGrants } from "../index.ts";

interface Bench {
  readonly ctx: Context;
  readonly audits: { tool: string; verdict: string }[];
  readonly asks: { tool: string; reason: string }[];
  readonly unload: readonly Disposer[];
  call(name: string, args: unknown, session?: SessionId): Promise<ToolOutcome>;
}

/** 单装配多 dispatch：broker 可编程（脚本耗尽即 deny）；审计与 ask 全记账 */
async function bench(root: string, options: { rules?: readonly string[]; mode?: "plan" | "auto" | "full"; brokerScript?: readonly ("allow" | "deny")[] } = {}): Promise<Bench> {
  const ctx = createContext();
  const audits: { tool: string; verdict: string }[] = [];
  const asks: { tool: string; reason: string }[] = [];
  let at = 0;
  const broker: Plugin = {
    name: "test-broker",
    apply: (c) =>
      c.provide(permissionBroker, {
        ask: async (input) => {
          asks.push({ tool: input.tool, reason: input.reason });
          const verdict = options.brokerScript?.[at] ?? "deny";
          at += 1;
          return verdict;
        },
      }),
  };
  const unload = await loadPlugins(ctx, [
    toolsPlugin,
    createPermissionPlugin({ root, ...(options.rules !== undefined ? { rules: options.rules } : {}), ...(options.mode !== undefined ? { mode: options.mode } : {}) }),
    broker,
  ]);
  ctx.on(permissionDecided, (audit) => audits.push({ tool: audit.tool, verdict: audit.verdict }));
  const reg = ctx.use(toolRegistry);
  const disposers: Disposer[] = [];
  const toolNames = new Set<string>();
  const call = async (name: string, args: unknown, session?: SessionId): Promise<ToolOutcome> => {
    if (!toolNames.has(name)) {
      toolNames.add(name);
      disposers.push(reg.register({ name, inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) }));
    }
    return reg.dispatch({ callId: `c-${String(asks.length)}-${String(audits.length)}-${name}`, name, args, signal: new AbortController().signal, ...(session !== undefined ? { session } : {}) });
  };
  return {
    ctx,
    audits,
    asks,
    unload: [...disposers, ...unload],
    call,
  };
}

describe("permission 插件（真实管线）", () => {
  let root = "";
  let outsideFile = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-perm-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "f.txt"), "x", "utf8");
    await writeFile(join(root, ".env"), "SECRET=1", "utf8");
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_rsa"), "k", "utf8");
    await mkdir(join(root, "..", "xh-outside"), { recursive: true });
    outsideFile = join(root, "..", "xh-outside", "f.txt");
    await writeFile(outsideFile, "x", "utf8");
  });
  afterEach(async () => {
    await rm(join(root, "..", "xh-outside"), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it("拼错规则 fail-closed 拒启（apply throw）", async () => {
    const ctx = createContext();
    await expect(loadPlugins(ctx, [toolsPlugin, createPermissionPlugin({ root, rules: ["Bash(broken"] })])).rejects.toThrow(/unparseable/);
  });

  it("默认拒读表：read .env / .ssh/id_rsa → deny（user-origin deny 压过一切；不触发 ask）", async () => {
    const b = await bench(root);
    const env = await b.call("read", { path: ".env" });
    expect(env.isError).toBe(true);
    expect(env.content).toContain("rule:**/.env");
    // 默认表 ~/.ssh/** 射程是家目录凭证；工作区内 .ssh 属普通界内文件（允许）——分层语义锁定
    const homeSsh = await b.call("read", { path: join(homedir(), ".ssh", "id_rsa") });
    expect(homeSsh.isError).toBe(true);
    expect(b.asks).toHaveLength(0); // deny 不走 ask
    for (const d of b.unload) await d();
  });

  it("界内 read → 零交互 allow；审计恰好一条", async () => {
    const b = await bench(root);
    const out = await b.call("read", { path: "f.txt" }, "s1" as SessionId);
    expect(out.content).toBe("ran");
    expect(out.isError).toBeUndefined();
    expect(b.audits).toEqual([{ tool: "read", verdict: "allow" }]);
    for (const d of b.unload) await d();
  });

  it("界外 read：broker 缺席 → deny；批 → allow + extraRoot 落账 + 同会话二次零 ask；异会话不借用", async () => {
    const absent = await bench(root);
    const denied = await absent.call("read", { path: outsideFile }, "sA" as SessionId);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("outside-root");
    expect(absent.asks).toHaveLength(1); // broker 缺席也被问过（退化 deny）
    for (const d of absent.unload) await d();

    const b = await bench(root, { brokerScript: ["allow"] });
    const first = await b.call("read", { path: outsideFile }, "sA" as SessionId);
    expect(first.content).toBe("ran"); // 批准放行
    const second = await b.call("read", { path: outsideFile }, "sA" as SessionId);
    expect(second.content).toBe("ran");
    expect(b.asks).toHaveLength(1); // extraRoot 已落账——二次零 ask
    const stranger = await b.call("read", { path: outsideFile }, "sB" as SessionId);
    expect(stranger.isError).toBe(true); // B 会话不借用（脚本耗尽 → deny）
    for (const d of b.unload) await d();
  });

  it("bash：auto 档无规则 → ask→批→allow；allow 规则 → 零交互；deny 规则直接 deny", async () => {
    const b = await bench(root, { brokerScript: ["allow"] });
    const asked = await b.call("bash", { command: "ls" }, "s1" as SessionId);
    expect(asked.content).toBe("ran"); // 无规则 → ask → 批 → 放行
    expect(b.asks).toHaveLength(1);
    for (const d of b.unload) await d();

    const b2 = await bench(root, { rules: ["Bash(git status):allow"], brokerScript: [] });
    const zero = await b2.call("bash", { command: "git status" }, "s1" as SessionId);
    expect(zero.content).toBe("ran");
    expect(b2.asks).toHaveLength(0); // 规则放行零交互
    for (const d of b2.unload) await d();

    const b3 = await bench(root, { rules: ["Bash(ls):deny"] });
    const denied = await b3.call("bash", { command: "ls" }, "s1" as SessionId);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("rule:ls");
    expect(b3.asks).toHaveLength(0); // deny 不问
    for (const d of b3.unload) await d();
  });

  it("模式档：plan 拒 write；full 放行未配 bash 段但仍拒硬拒线与 deny 规则", async () => {
    const plan = await bench(root, { mode: "plan" });
    expect((await plan.call("write", { path: "f.txt", content: "x" })).isError).toBe(true);
    for (const d of plan.unload) await d();

    const full = await bench(root, { mode: "full" });
    expect((await full.call("bash", { command: "ls whatever" })).content).toBe("ran"); // 未配段全过
    expect((await full.call("bash", { command: "sudo id" })).isError).toBe(true); // 硬拒底线仍在
    for (const d of full.unload) await d();
  });

  it("模式档 × 总括确立：full 装配 setUnrestricted，auto/plan 不确立", async () => {
    const full = await bench(root, { mode: "full" });
    const grants = full.ctx.use(permissionGrants);
    expect(grants.isUnrestricted(undefined)).toBe(true);
    expect(grants.extraRootsOf(undefined)).toEqual(["/"]);
    for (const d of full.unload) await d();

    const auto = await bench(root);
    expect(auto.ctx.use(permissionGrants).isUnrestricted(undefined)).toBe(false);
    for (const d of auto.unload) await d();

    const plan = await bench(root, { mode: "plan" });
    expect(plan.ctx.use(permissionGrants).isUnrestricted(undefined)).toBe(false);
    for (const d of plan.unload) await d();
  });

  it("full 档拒读表仍压过：.env 与家目录 ~/.ssh 读拒（deny 规则先于 full 短路）", async () => {
    const full = await bench(root, { mode: "full" });
    const env = await full.call("read", { path: ".env" });
    expect(env.isError).toBe(true);
    expect(env.content).toContain("rule:**/.env");
    const homeSsh = await full.call("read", { path: join(homedir(), ".ssh", "id_rsa") });
    expect(homeSsh.isError).toBe(true);
    expect(homeSsh.content).toContain("rule:~/.ssh/**"); // 拒因锚（与 .env 腿对称）
    for (const d of full.unload) await d();
  });

  it("sessionDisposed：会话终结逐出授权桶（session 插件真实事件链）", async () => {
    const ctx = createContext();
    const asks: { reason: string }[] = [];
    let at = 0;
    const broker: Plugin = {
      name: "test-broker",
      apply: (c) =>
        c.provide(permissionBroker, {
          ask: async (input) => {
            asks.push({ reason: input.reason });
            at += 1;
            return at <= 1 ? "allow" : "deny"; // 首批后耗尽
          },
        }),
    };
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createPermissionPlugin({ root }), broker]);
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "read", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    const created = await ctx.use(sessionStore).create();
    if (!created.ok) throw new Error("session create failed");
    const session = created.value.id;
    const first = await reg.dispatch({ callId: "c1", name: "read", args: { path: outsideFile }, signal: new AbortController().signal, session });
    expect(first.content).toBe("ran");
    await ctx.use(sessionStore).dispose(session);
    const second = await reg.dispatch({ callId: "c2", name: "read", args: { path: outsideFile }, signal: new AbortController().signal, session });
    expect(second.isError).toBe(true); // 逐出后重新 ask → deny
    for (const d of unload) await d();
  });

  it("permissionGrants 服务可达；write 工具面 .git 写拒（默认受保护集）", async () => {
    const b = await bench(root);
    expect(b.ctx.use(permissionGrants).extraRootsOf(undefined)).toEqual([]);
    const gitWrite = await b.call("write", { path: ".git/config", content: "x" });
    expect(gitWrite.isError).toBe(true);
    expect(gitWrite.content).toContain(".git");
    for (const d of b.unload) await d();
  });

  it("broker 抛错 → ask 退化 deny（fail-closed）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionPlugin({ root }),
      { name: "throwing-broker", apply: (c) => c.provide(permissionBroker, { ask: async () => { throw new Error("ui gone"); } }) },
    ]);
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "read", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    const out = await reg.dispatch({ callId: "c", name: "read", args: { path: "/etc/hosts" }, signal: new AbortController().signal });
    expect(out.isError).toBe(true);
    for (const d of unload) await d();
  });

  it("未知工具 → ask（保守，缺席 broker → deny）", async () => {
    const b = await bench(root);
    const out = await b.call("mystery", { x: 1 });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("unknown tool");
    for (const d of b.unload) await d();
  });
});
