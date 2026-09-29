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
import { createPermissionPlugin, permissionBroker, permissionDecided, permissionGrants, permissionMode } from "../index.ts";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import { parseRules } from "../index.ts";

interface Bench {
  readonly ctx: Context;
  readonly audits: { tool: string; verdict: string }[];
  readonly asks: { tool: string; reason: string }[];
  readonly unload: readonly Disposer[];
  call(name: string, args: unknown, session?: SessionId): Promise<ToolOutcome>;
}

async function bench(root: string, options: { rules?: readonly string[]; mode?: import("../types.ts").ProfileId; brokerScript?: readonly ("allow" | "deny")[]; controlTools?: readonly string[]; customProfiles?: readonly import("../types.ts").PermissionProfile[] } = {}): Promise<Bench> {
  const ctx = createContext();
  const audits: { tool: string; verdict: string; resolvedBy?: string }[] = [];
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
          return { verdict };
        },
      }),
  };
  const unload = await loadPlugins(ctx, [
    createPermissionModesPlugin(),
    toolsPlugin,
    createPermissionPlugin({ root, ...(options.rules !== undefined ? { rules: parseRules(options.rules, "user") } : {}), ...(options.mode !== undefined ? { mode: options.mode } : {}), ...(options.customProfiles !== undefined ? { customProfiles: options.customProfiles } : {}) }),
    broker,
  ]);
  ctx.on(permissionDecided, (audit) => audits.push({ tool: audit.tool, verdict: audit.verdict, resolvedBy: audit.resolvedBy }));
  const reg = ctx.use(toolRegistry);
  const disposers: Disposer[] = [];
  const toolNames = new Set<string>();
  for (const name of options.controlTools ?? []) {
    toolNames.add(name);
    disposers.push(reg.register({ name, inputSchema: Type.Object({}), isControlTool: true, execute: async () => ({ content: "ran" }) }));
  }
  const call = async (name: string, args: unknown, session?: SessionId): Promise<ToolOutcome> => {
    if (!toolNames.has(name)) {
      toolNames.add(name);
      const family = (["read","write","edit","grep","bash"] as const).includes(name as never) ? ({ read: "Read", write: "Write", edit: "Write", grep: "Read", bash: "Danger" } as const)[name as "read"|"write"|"edit"|"grep"|"bash"] : undefined;
      disposers.push(reg.register({ name, ...(family !== undefined ? { kind: family } : {}), inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) }));
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

  it("拼错规则 fail-closed 拒启（解析边沿 throw——规则串解析归宿主边）", () => {
    expect(() => parseRules(["Danger(broken"], "user")).toThrow(/unparseable/);
  });

  const readVerdictsOf = (audits: readonly { tool: string; verdict: string }[]): string[] => {
    const verdicts: string[] = [];
    for (const a of audits) if (a.tool === "read") verdicts.push(a.verdict);
    return verdicts;
  };

  describe("read paths 批量聚合裁决（TURN-REDUCTION.md P1——批量不得绕过任何裁决面）", () => {
    it("批量混入根集外 .env → 整体 deny（.env 底线对根集外每条目完整生效）；根集内 .env 是项目本地配置放行", async () => {
      const b = await bench(root);
      const r = await b.call("read", { paths: ["f.txt", join(root, "..", "xh-outside", ".env")] });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("rule:/**/.env");
      expect(b.asks).toHaveLength(0);
      const local = await b.call("read", { paths: ["f.txt", ".env"] });
      expect(local.isError).not.toBe(true);
    });

    it("批量含界外条目 → 整体 ask（grant 落账界外父目录；批量不吞界外语义）", async () => {
      const b = await bench(root);
      await b.call("read", { paths: ["f.txt", outsideFile] });
      expect(b.asks.length).toBe(1);
      const ask = b.asks[0];
      if (ask === undefined) throw new Error("no ask");
      expect(ask.reason).toContain("outside-root:");
      expect(ask.reason).toContain("xh-outside");
    });

    it("批量全界内正常文件 → allow 直通（batch in-root；零 ask 零 deny）", async () => {
      const b = await bench(root);
      const r = await b.call("read", { paths: ["f.txt", join("sub", "..", "f.txt")] });
      expect(r.isError).toBeUndefined();
      expect(b.asks).toHaveLength(0);
      expect(readVerdictsOf(b.audits).includes("allow")).toBe(true);
    });
  });

  it("拒读底线分层（2026-09-28 裁决）：根集内 .env 可读（项目配置）；根集外 .env 与家目录 ~/.ssh 恒拒；不触发 ask", async () => {
    const b = await bench(root);
    const localEnv = await b.call("read", { path: ".env" });
    expect(localEnv.isError).not.toBe(true);
    const outsideEnv = await b.call("read", { path: join(root, "..", "xh-outside", ".env") });
    expect(outsideEnv.isError).toBe(true);
    expect(outsideEnv.content).toContain("rule:/**/.env");
    const homeSsh = await b.call("read", { path: join(homedir(), ".ssh", "id_rsa") });
    expect(homeSsh.isError).toBe(true);
    expect(b.asks).toHaveLength(0);
    for (const d of b.unload) await d();
  });

  it("界内 read → 零交互 allow；审计恰好一条", async () => {
    const b = await bench(root);
    const out = await b.call("read", { path: "f.txt" }, "s1" as SessionId);
    expect(out.content).toBe("ran");
    expect(out.isError).toBeUndefined();
    expect(b.audits).toEqual([{ tool: "read", verdict: "allow", resolvedBy: "auto" }]);
    for (const d of b.unload) await d();
  });

  it("界外 read：broker 缺席 → deny；批 → allow；读不落 root（P-bug-4——二次再问，读授权不扩写面）；异会话不借用", async () => {
    const absent = await bench(root);
    const denied = await absent.call("read", { path: outsideFile }, "sA" as SessionId);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("outside-root");
    expect(absent.asks).toHaveLength(1);
    for (const d of absent.unload) await d();

    const b = await bench(root, { brokerScript: ["allow", "allow"] });
    const first = await b.call("read", { path: outsideFile }, "sA" as SessionId);
    expect(first.content).toBe("ran");
    const second = await b.call("read", { path: outsideFile }, "sA" as SessionId);
    expect(second.content).toBe("ran");
    expect(b.asks).toHaveLength(2);
    const stranger = await b.call("read", { path: outsideFile }, "sB" as SessionId);
    expect(stranger.isError).toBe(true);
    for (const d of b.unload) await d();
  });

  it("bash：auto 档无规则 → ask→批→allow；allow 规则 → 零交互；deny 规则直接 deny", async () => {
    const b = await bench(root, { brokerScript: ["allow"] });
    const asked = await b.call("bash", { command: "mytool run" }, "s1" as SessionId);
    expect(asked.content).toBe("ran");
    expect(b.asks).toHaveLength(1);
    const zeroTouch = await b.call("bash", { command: "git status" }, "s1" as SessionId);
    expect(zeroTouch.content).toBe("ran");
    expect(b.asks).toHaveLength(1);
    for (const d of b.unload) await d();

    const b2 = await bench(root, { rules: ["Danger(git status):allow"], brokerScript: [] });
    const zero = await b2.call("bash", { command: "git status" }, "s1" as SessionId);
    expect(zero.content).toBe("ran");
    expect(b2.asks).toHaveLength(0);
    for (const d of b2.unload) await d();

    const b3 = await bench(root, { rules: ["Danger(ls):deny"] });
    const denied = await b3.call("bash", { command: "ls" }, "s1" as SessionId);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("rule:ls");
    expect(b3.asks).toHaveLength(0);
    for (const d of b3.unload) await d();
  });

  it("模式档：plan 拒 write；full 放行未配 bash 段但仍拒硬拒线与 deny 规则", async () => {
    const plan = await bench(root, { mode: "plan" });
    expect((await plan.call("write", { path: "f.txt", content: "x" })).isError).toBe(true);
    for (const d of plan.unload) await d();

    const full = await bench(root, { mode: "full" });
    expect((await full.call("bash", { command: "ls whatever" })).content).toBe("ran");
    expect((await full.call("bash", { command: "sudo id" })).isError).toBe(true);
    for (const d of full.unload) await d();
  });

  it("full 插件执行面（2026-09-28 裁决）：注入/灾难形态/解析失败/.git 写零 ask 直接执行；提权与根集外拒读仍拦（零 ask 拒绝）", async () => {
    const b = await bench(root, { mode: "full", brokerScript: [] });
    expect((await b.call("bash", { command: "echo $(whoami)" })).content).toBe("ran");
    expect(b.asks).toHaveLength(0);
    expect((await b.call("bash", { command: "rm -rf /" })).content).toBe("ran");
    expect((await b.call("bash", { command: "echo x > .git/config" })).content).toBe("ran");
    expect((await b.call("bash", { command: "cat .env" })).content).toBe("ran");
    expect((await b.call("read", { path: join(root, ".env") })).content).toBe("ran");
    expect((await b.call("bash", { command: `cat ${join(homedir(), ".ssh", "id_rsa")}` })).isError).toBe(true);
    expect(b.asks).toHaveLength(0);
    for (const d of b.unload) await d();
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

  it("控制面工具（isControlTool）直通：auto 档下未知工具零 ask、审计标 control（delegation 动词不撞保守墙）", async () => {
    const b = await bench(root, { brokerScript: [], controlTools: ["agent_spawn"] });
    const outcome = await b.call("agent_spawn", {});
    expect(outcome.content).toBe("ran");
    expect(b.asks).toHaveLength(0);
    expect(b.audits).toContainEqual({ tool: "agent_spawn", verdict: "allow", resolvedBy: "control" });
    for (const d of b.unload) await d();
  });

  it("permissionMode 服务：运行期切档原子同步 decide 面与授权面（进入 full 即授、离开即撤）", async () => {
    const b = await bench(root, { brokerScript: [] });
    const svc = b.ctx.use(permissionMode);
    expect(svc.get()).toBe("auto");
    expect(b.ctx.use(permissionGrants).isUnrestricted(undefined)).toBe(false);

    svc.set("plan");
    expect(svc.get()).toBe("plan");
    expect((await b.call("write", { path: "f.txt", content: "x" })).isError).toBe(true);
    expect(b.ctx.use(permissionGrants).isUnrestricted(undefined)).toBe(false);

    svc.set("full");
    expect(b.ctx.use(permissionGrants).isUnrestricted(undefined)).toBe(true);
    expect(b.ctx.use(permissionGrants).extraRootsOf(undefined)).toEqual(["/"]);
    expect((await b.call("bash", { command: "ls whatever" })).content).toBe("ran");

    svc.set("auto");
    expect(b.ctx.use(permissionGrants).isUnrestricted(undefined)).toBe(false);
    expect(b.ctx.use(permissionGrants).extraRootsOf(undefined)).toEqual([]);
    for (const d of b.unload) await d();
  });

  it("症状回归：自定义档 set 曾被预滤为 undefined 静默降级 auto——set 原串经 customProfiles 解析真生效", async () => {
    const b = await bench(root, { customProfiles: [{ id: "strict", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" }] });
    const svc = b.ctx.use(permissionMode);
    svc.set("strict");
    expect(svc.get()).toBe("strict");
    expect((await b.call("write", { path: "f.txt", content: "x" })).isError).toBe(true);
    for (const d of b.unload) await d();
  });

  it("full 档恒拒面：家目录 ~/.ssh 读拒（凭据目录任意位置）；.env 族随总括根集放行（full 授权根=[/]——条件拒止天然满躬，项目本地 .env 同放行）", async () => {
    const full = await bench(root, { mode: "full" });
    const homeSsh = await full.call("read", { path: join(homedir(), ".ssh", "id_rsa") });
    expect(homeSsh.isError).toBe(true);
    expect(homeSsh.content).toContain("rule:~/.ssh/**");
    const localEnv = await full.call("read", { path: ".env" });
    expect(localEnv.isError).not.toBe(true);
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
            return { verdict: at <= 1 ? "allow" : "deny" };
          },
        }),
    };
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createPermissionPlugin({ root }), broker]);
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "read", kind: "Read", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    const created = await ctx.use(sessionStore).create();
    if (!created.ok) throw new Error("session create failed");
    const session = created.value.id;
    const first = await reg.dispatch({ callId: "c1", name: "read", args: { path: outsideFile }, signal: new AbortController().signal, session });
    expect(first.content).toBe("ran");
    await ctx.use(sessionStore).dispose(session);
    const second = await reg.dispatch({ callId: "c2", name: "read", args: { path: outsideFile }, signal: new AbortController().signal, session });
    expect(second.isError).toBe(true);
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
    reg.register({ name: "read", kind: "Read", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
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
