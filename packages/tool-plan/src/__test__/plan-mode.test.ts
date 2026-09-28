// plan 模式富策略规格（V3 阶段二迁移自 permission/adjudicate.test + audit-v3-security
// 的富矩阵——C-spec 迁移矩阵：档位策略规格随模式插件）。两面：
// ① 纯函数面：bashFactsOf 产事实 → planMode.decide 判决（与旧 planBash 行为映射，
//   差异仅 deny 规则归因由核心先行改 rule:<origin>——U7 同族有意变更）；
// ② 集成面：真装配（permission + tool-plan）经 modeRegistry 后注册覆盖——plan 富策略
//   生效（readonly 放行/写拒），严格缺省被覆盖。

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { Type } from "@sinclair/typebox";
import { bashFactsOf, createPermissionPlugin } from "@x-harness/permission";
import { resolveProfile } from "@x-harness/permission-modes";
import { baselineDenyRules } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import { planMode } from "../plan-mode.ts";
import { createPlanSubmitPlugin } from "../plugin.ts";

const PLAN = resolveProfile("plan")!;
const ROOT = "/w/app";

const decideOf = planMode.decide ?? (() => undefined);
const decide = (command: string, profile = PLAN) => decideOf(bashFactsOf({ command, rules: [], profile, root: ROOT, extraRoots: [], denyRules: baselineDenyRules() }));

const roots: string[] = [];

/** stub bash 工具（集成世界只测裁决面——不装真 tool-bash） */
const stubBash: import("@x-harness/core").Plugin = {
  name: "stub-bash",
  inject: ["tools"],
  apply: (c) => c.use(toolRegistry).register({
    name: "bash",
    kind: "Danger",
    description: "stub",
    inputSchema: Type.Object({ command: Type.Optional(Type.String()) }),
    execute: async () => ({ content: "ran" }),
  } as never),
};

describe("plan 富策略·纯函数面（bashFactsOf → planMode.decide）", () => {
  it("readonly 放行（研究通道）；写类/未分类拒", () => {
    expect(decide("ls -la src")).toEqual({ verdict: "allow", reason: "classifier:readonly (plan)", resolvedBy: "classifier:readonly" });
    expect(decide("git log --oneline -10")?.verdict).toBe("allow");
    expect(decide("grep -rn TODO packages")?.verdict).toBe("allow");
    expect(decide("find . -name x")?.verdict).toBe("allow");
    expect(decide("mkdir d")).toMatchObject({ verdict: "deny", reason: "plan mode disallows bash write" });
    expect(decide("git push")).toMatchObject({ verdict: "deny", reason: "plan mode: command not read-only classified" });
    expect(decide("curl https://a.com")).toMatchObject({ verdict: "deny", reason: "plan mode: command not read-only classified" });
  });
  it("段旗面拒：注入/结构失格/opaque/dynamic（B-bug-5 细分钉）", () => {
    expect(decide("cat $(echo x)")?.reason).toBe("plan mode: injection form denied");
    expect(decide("cat $F")?.reason).toBe("plan mode: dynamic (shell-expanded) segment denied");
    expect(decide("bash x.sh")?.reason).toContain("opaque segment");
  });
  it("读保护基线（B-bug-1 细分钉）：敏感面/输入重定向拒读表 → deny", () => {
    expect(decide("cat ~/.ssh/id_rsa")?.reason).toContain("sensitive path");
    expect(decide("cat < ~/.ssh/id_rsa")?.reason).toBe("redirect-read:~/.ssh/**");
    expect(decide("cat .env")?.verdict).toBe("deny");
  });
  it("提权拒；输出重定向拒（/dev/null 除外）；解析失败拒", () => {
    expect(decide("sudo ls")?.reason).toBe("plan mode: elevation denied");
    expect(decide("echo hi > out.txt")?.reason).toBe("plan mode: output redirect denied");
    expect(decide("ls > /dev/null")?.verdict).toBe("allow");
    expect(decide("echo 'oops")?.reason).toBe("plan mode: command not parseable");
  });
  it("path 面：Write 拒（planWriteGate 迁移）；Read/Grep 让位 fallback（undefined）", () => {
    expect(decideOf({ face: "path", tool: "write", kind: "Write", path: "/w/a", inRoot: true })).toMatchObject({ verdict: "deny", reason: "plan mode disallows write" });
    expect(decideOf({ face: "path", tool: "read", kind: "Read", path: "/w/a", inRoot: true })).toBeUndefined();
    expect(decideOf({ face: "tool", tool: "mystery" })).toBeUndefined();
  });
});

describe("plan 富策略·集成面（modeRegistry 后注册覆盖严格缺省）", () => {
  it("真装配：readonly bash 放行（富策略生效）；write 工具拒（缺省同语义）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-planmode-"));
    roots.push(root);
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [toolsPlugin, stubBash, createPermissionModesPlugin(), createPermissionPlugin({ root, mode: "plan" }), createPlanSubmitPlugin({ liftTo: "auto" })]);
    const registry = ctx.use(toolRegistry);
    try {
      const research = await registry.dispatch({ callId: "pm-1", name: "bash", args: { command: "git log --oneline -5" }, signal: new AbortController().signal });
      expect(research.isError).toBeUndefined(); // 富策略：研究通道（严格缺省会拒）
      const write = await registry.dispatch({ callId: "pm-2", name: "bash", args: { command: "echo hi > new.txt" }, signal: new AbortController().signal });
      expect(write.isError).toBe(true);
      expect(write.content).toContain("plan mode: output redirect denied");
    } finally {
      for (const d of unload) await d();
      await ctx.dispose();
    }
  });
  it("不装 tool-plan 的世界：严格缺省——readonly bash 也拒", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-plandef-"));
    roots.push(root);
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [toolsPlugin, stubBash, createPermissionModesPlugin(), createPermissionPlugin({ root, mode: "plan" })]);
    try {
      const out = await ctx.use(toolRegistry).dispatch({ callId: "pd-1", name: "bash", args: { command: "git log --oneline -5" }, signal: new AbortController().signal });
      expect(out.isError).toBe(true);
      expect(out.content).toContain("plan mode disallows bash");
    } finally {
      for (const d of unload) await d();
      await ctx.dispose();
    }
  });
  it("静态锚：planMode id 与词表一致（U2 五档名保留）", () => {
    expect(planMode.id).toBe("plan");
  });
});

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});
