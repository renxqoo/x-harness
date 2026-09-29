import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolOutcome } from "@x-harness/tools";
import type { SessionId } from "@x-harness/session";
import { createPermissionModesPlugin, knobDecideOf } from "@x-harness/permission-modes";
import { createPermissionPlugin, decideFor as __decideFor } from "../index.ts";
import type { Decision, PermissionProfile, PermissionRule, ProfileId } from "../index.ts";
import { permissionBroker, permissionDecided, permissionGrantStore, permissionGrantWritten } from "../index.ts";
import { resolveProfile } from "@x-harness/permission-modes";
import { parseRule } from "../index.ts";

const PROFILES = {
  plan: resolveProfile("plan")!,
  auto: resolveProfile("auto")!,
  editConfirm: resolveProfile("edit-confirm")!,
  full: resolveProfile("full")!,
  sandboxed: resolveProfile("sandboxed-auto")!,
};
const ROOT = "/w/app";

function decideFor(input: Parameters<typeof __decideFor>[0]): ReturnType<typeof __decideFor> {
  const faces = knobDecideOf(input.profile);
  const family = (["read","write","edit","grep","bash"] as const).includes(input.tool as never) ? ({ read: "Read", write: "Write", edit: "Write", grep: "Read", bash: "Danger" } as const)[input.tool as "read" | "write" | "edit" | "grep" | "bash"] : undefined;
  return __decideFor({ ...input, ...(input.kind === undefined && family !== undefined ? { kind: family } : {}), ...(input.modeDecide === undefined && faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(input.postureDecide === undefined && faces.posture !== undefined ? { postureDecide: faces.posture } : {}) });
}

function bash(command: string, profile: PermissionProfile, rules: readonly PermissionRule[] = []): Decision {
  return decideFor({ tool: "bash", args: { command }, userRules: rules, sessionRules: [], profile, root: ROOT, extraRoots: [] });
}

describe("执行矩阵（§4.2——f(裁决类, containment)）", () => {
  it("auto（none）：分类器 allow → direct；未分类 → ask 无指令", () => {
    expect(bash("git status", PROFILES.auto)).toMatchObject({ verdict: "allow", exec: "direct" });
    const ask = bash("mytool run", PROFILES.auto);
    expect(ask.verdict).toBe("ask");
    expect(ask.exec).toBeUndefined();
  });

  it("sandboxed-auto（fenced）：同裁决 allow → contained；未分类 → allow+contained（on-failure 围栏代问）", () => {
    expect(bash("git status", PROFILES.sandboxed)).toMatchObject({ verdict: "allow", exec: "contained" });
    expect(bash("mytool run", PROFILES.sandboxed)).toMatchObject({ verdict: "allow", exec: "contained", resolvedBy: "classifier:unclassified" });
    expect(bash("node -e 'x'", PROFILES.sandboxed)).toMatchObject({ verdict: "allow", exec: "contained" });
  });

  it("edit-confirm：界内合成写 ask（不越 root 问）；auto 档同命令 direct", () => {
    expect(bash("mkdir build", PROFILES.editConfirm)).toMatchObject({ verdict: "ask", memorizable: true });
    expect(bash("mkdir build", PROFILES.auto)).toMatchObject({ verdict: "allow", exec: "direct" });
  });

  it("症状回归：printf 纯输出动词曾在 edit-confirm 档被问（落无法预测桶）——只读白名单补齐免问；sort -o 写形态仍问", () => {
    expect(bash("printf 'x'", PROFILES.editConfirm)).toMatchObject({ verdict: "allow", resolvedBy: "classifier:readonly" });
    expect(bash("sort -o out.txt in.txt", PROFILES.editConfirm)).toMatchObject({ verdict: "ask", resolvedBy: "default:ask" });
  });

  it("U7 归因重写：full 短路下 handwritten allow 规则命中 → 归因规则（不再被 mode:full 吞）；习得 grant 不重写", () => {
    const allowRule = [parseRule("Write(src/**):allow", "user")];
    expect(bash("git status", PROFILES.full)).toMatchObject({ verdict: "allow", resolvedBy: "mode:full" });
    const write = decideFor({ tool: "write", args: { path: "src/a.ts", content: "x" }, userRules: allowRule, sessionRules: [], profile: PROFILES.full, root: ROOT, extraRoots: [] });
    expect(write).toMatchObject({ verdict: "allow", reason: "rule:src/**", resolvedBy: "rule:user", exec: "direct" });
    const learned = [{ ...parseRule("Write(src/**):allow", "session"), nature: "grant" as const }];
    const write2 = decideFor({ tool: "write", args: { path: "src/a.ts", content: "x" }, userRules: [], sessionRules: learned, profile: PROFILES.full, root: ROOT, extraRoots: [] });
    expect(write2).toMatchObject({ verdict: "allow", resolvedBy: "mode:full" });
  });

  it("full：短路现口径（sudo deny；injection/rm-rf-root 被 A① 最小 ask 钳制）；exec direct", () => {
    expect(bash("sudo id", PROFILES.full)).toMatchObject({ verdict: "deny", resolvedBy: "mode:full" });
    expect(bash("echo $(x)", PROFILES.full)).toMatchObject({ verdict: "ask", resolvedBy: "red-line:floor" });
    expect(bash("rm -rf /", PROFILES.full)).toMatchObject({ verdict: "ask", resolvedBy: "red-line:floor" });
    expect(bash("git status", PROFILES.full)).toMatchObject({ verdict: "allow", exec: "direct" });
  });

  it("plan bash 闸（V3 阶段二——严格缺省；富策略在 tool-plan 注册覆盖，宿主经真装配）：bash 全拒——allow/习得皆越不过；deny 规则核心先行（归因 rule）", () => {
    const wide = [parseRule("Danger(*):allow", "user")];
    const learned = [parseRule("Danger(*):allow", "session")].map((r) => ({ ...r, nature: "grant" as const }));
    expect(bash("git status", PROFILES.plan, wide)).toMatchObject({ verdict: "deny", reason: "plan mode disallows bash", resolvedBy: "mode:plan" });
    expect(bash("git push", PROFILES.plan, wide)).toMatchObject({ verdict: "deny", resolvedBy: "mode:plan" });
    expect(bash("git push", PROFILES.plan, learned)).toMatchObject({ verdict: "deny" });
    expect(bash("git log", PROFILES.plan, [parseRule("Danger(git log):deny", "user")])).toMatchObject({ verdict: "deny", resolvedBy: "rule:user" });
  });
});

describe("优先序与不变式（§9）", () => {
  it("不变式 2：deny 跨作用域压一切；显式 ask 压习得 allow", () => {
    const denyUser = [parseRule("Danger(mytool:*):deny", "user")];
    const learnedSession = [{ ...parseRule("Danger(mytool:*):allow", "session"), nature: "grant" as const }];
    expect(bash("mytool run", PROFILES.auto, [...learnedSession, ...denyUser]).verdict).toBe("deny");
    const askRule = [parseRule("Danger(mytool:*):ask", "user")];
    expect(bash("mytool run", PROFILES.auto, [...learnedSession, ...askRule])).toMatchObject({ verdict: "ask", resolvedBy: "ask-rule:user" });
  });

  it("不变式 1（习得不越防线）：习得 allow 不越 argv 敏感面；硬拒/结构失败无记忆选项", () => {
    const learnedCat = [{ ...parseRule("Danger(cat:*):allow", "session"), nature: "grant" as const }];
    expect(bash("cat README.md", PROFILES.auto, learnedCat)).toMatchObject({ verdict: "allow", resolvedBy: "grant:session" });
    expect(bash("cat ~/.ssh/id_rsa", PROFILES.auto, learnedCat)).toMatchObject({ verdict: "ask", resolvedBy: "argv-sensitive" });
    expect(bash("sudo id", PROFILES.auto).memorizable).toBeUndefined();
    expect(bash("cat $F", PROFILES.auto).memorizable).toBeUndefined();
    expect(bash("mytool run", PROFILES.auto, [parseRule("Danger(mytool:*):ask", "user")]).memorizable).toBeUndefined();
  });

  it("习得 allow：session 作用域命中（grant:session）；显式 allow 越过 opaque", () => {
    const learned = [{ ...parseRule("Danger(git status:*):allow", "session"), nature: "grant" as const }];
    expect(bash("git status -s", PROFILES.auto, learned)).toMatchObject({ verdict: "allow", resolvedBy: "grant:session" });
    expect(bash("bash x.sh", PROFILES.auto, [parseRule("Danger(bash:*):allow", "user")])).toMatchObject({ verdict: "allow", resolvedBy: "rule:user" });
  });
});

describe("插件级：结构化 ask 往返 + 记忆写入 + 审计 exec（§6.2/§6.4）", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-v2-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "f.txt"), "x", "utf8");
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_rsa"), "k", "utf8");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  interface Bench {
    readonly ctx: Context;
    readonly asks: { reason: string; options: string[]; suggestedRule?: string }[];
    readonly audits: { tool: string; verdict: string; exec?: string; resolvedBy: string }[];
    readonly grantsWritten: { scope: string; rule: string }[];
    readonly unload: readonly Disposer[];
    call(name: string, args: unknown, session?: SessionId): Promise<ToolOutcome>;
  }

  async function bench(options: {
    mode?: ProfileId;
    rules?: readonly PermissionRule[];
    protectedPaths?: readonly string[];
    replies?: { verdict: "allow" | "deny"; memory?: "session" | "project" | "user"; ruleOverride?: string }[];
  } = {}): Promise<Bench> {
    const ctx = createContext();
    const asks: Bench["asks"] = [];
    const audits: Bench["audits"] = [];
    const grantsWritten: Bench["grantsWritten"] = [];
    let at = 0;
    const broker: Plugin = {
      name: "test-broker",
      apply: (c) =>
        c.provide(permissionBroker, {
          ask: async (input) => {
            asks.push({ reason: input.reason, options: [...input.options], ...(input.suggestedRule !== undefined ? { suggestedRule: input.suggestedRule } : {}) });
            const reply = options.replies?.[at] ?? { verdict: "deny" as const };
            at += 1;
            return reply;
          },
        }),
    };
    const store: Plugin = {
      name: "test-grant-store",
      apply: (c) =>
        c.provide(permissionGrantStore, {
          write: async () => ({ ok: true }),
        }),
    };
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionModesPlugin(), createPermissionPlugin({
        root,
        mode: options.mode ?? "auto",
        ...(options.rules !== undefined ? { rules: options.rules } : {}),
        ...(options.protectedPaths !== undefined ? { protectedPaths: options.protectedPaths } : {}),
      }),
      broker,
      store,
    ]);
    ctx.on(permissionDecided, (a) => audits.push({ tool: a.tool, verdict: a.verdict, ...(a.exec !== undefined ? { exec: a.exec } : {}), resolvedBy: a.resolvedBy }));
    ctx.on(permissionGrantWritten, (g) => grantsWritten.push({ scope: g.scope, rule: g.rule }));
    const reg = ctx.use(toolRegistry);
    const disposers: Disposer[] = [];
    const registered = new Set<string>();
    const call = async (name: string, args: unknown, session?: SessionId): Promise<ToolOutcome> => {
      if (!registered.has(name)) {
        registered.add(name);
        const family = (["read","write","edit","grep","bash"] as const).includes(name as never) ? ({ read: "Read", write: "Write", edit: "Write", grep: "Read", bash: "Danger" } as const)[name as "read"|"write"|"edit"|"grep"|"bash"] : undefined;
        disposers.push(reg.register({ name, ...(family !== undefined ? { kind: family } : {}), inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) }));
      }
      return reg.dispatch({ callId: `c-${at}-${name}-${String(asks.length)}`, name, args, signal: new AbortController().signal, ...(session !== undefined ? { session } : {}) });
    };
    return { ctx, asks, audits, grantsWritten, unload: [...disposers, ...unload], call };
  }

  it("ask 四档选项 + 泛化建议；记忆 session → 授权桶即席生效（二次免问）", async () => {
    const b = await bench({ replies: [{ verdict: "allow", memory: "session" }] });
    const first = await b.call("bash", { command: "mytool deploy prod" }, "s1" as SessionId);
    expect(first.content).toBe("ran");
    expect(b.asks[0]).toMatchObject({ options: ["once", "session", "project", "user"], suggestedRule: "Danger(mytool deploy:*):allow" });
    expect(b.grantsWritten).toEqual([{ scope: "session", rule: "Danger(mytool deploy:*):allow" }]);
    const second = await b.call("bash", { command: "mytool deploy staging" }, "s1" as SessionId);
    expect(second.content).toBe("ran");
    expect(b.asks).toHaveLength(1);
    expect(b.audits.at(-1)).toMatchObject({ tool: "bash", verdict: "allow", exec: "direct", resolvedBy: "grant:session" });
    for (const d of b.unload) await d();
  });

  it("记忆 project → 持久面写入（grantStore）；ruleOverride 改写落账", async () => {
    const b = await bench({ replies: [{ verdict: "allow", memory: "project", ruleOverride: "Danger(mytool deploy:*):allow" }] });
    await b.call("bash", { command: "mytool deploy prod" }, "s1" as SessionId);
    expect(b.grantsWritten).toEqual([{ scope: "project", rule: "Danger(mytool deploy:*):allow" }]);
    for (const d of b.unload) await d();
  });

  it("拒记类只余 once（硬拒 ask 无记忆选项、无建议）", async () => {
    const b = await bench({ replies: [{ verdict: "deny" }] });
    await b.call("bash", { command: "sudo id" }, "s1" as SessionId);
    expect(b.asks[0]?.options).toEqual(["once"]);
    expect(b.asks[0]?.suggestedRule).toBeUndefined();
    for (const d of b.unload) await d();
  });

  it("敏感面 ask 精确记忆（不泛化——建议=精确全串）；批准后 direct 执行", async () => {
    const b = await bench({ replies: [{ verdict: "allow", memory: "session" }] });
    await b.call("bash", { command: "cat ~/.ssh/id_rsa" }, "s1" as SessionId);
    expect(b.asks[0]?.suggestedRule).toBe("Danger(cat ~/.ssh/id_rsa):allow");
    expect(b.grantsWritten).toEqual([{ scope: "session", rule: "Danger(cat ~/.ssh/id_rsa):allow" }]);
    await b.call("bash", { command: "cat ~/.ssh/known_hosts" }, "s1" as SessionId);
    expect(b.asks).toHaveLength(2);
    for (const d of b.unload) await d();
  });

  it("sandboxed-auto：未分类 direct 免问；escalatable 资格在 contained+on-failure（经 audit exec 面锚）", async () => {
    const b = await bench({ mode: "sandboxed-auto" });
    await b.call("bash", { command: "mytool run" }, "s1" as SessionId);
    expect(b.asks).toHaveLength(0);
    expect(b.audits[0]).toMatchObject({ tool: "bash", verdict: "allow", exec: "contained" });
    for (const d of b.unload) await d();
  });

  it("会话隔离：A 会话习得 B 会话不借用（授权桶会话键控）", async () => {
    const b = await bench({ replies: [{ verdict: "allow", memory: "session" }, { verdict: "deny" }] });
    await b.call("bash", { command: "mytool deploy prod" }, "s1" as SessionId);
    await b.call("bash", { command: "mytool deploy staging" }, "s2" as SessionId);
    expect(b.asks).toHaveLength(2);
    for (const d of b.unload) await d();
  });

  it("症状回归：full 档 edit 工具调用弹确认（ask 计数非 0）——现零 ask 直跑", async () => {
    const b = await bench({ mode: "full" });
    const out = await b.call("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] });
    expect(out.content).toBe("ran");
    expect(b.asks).toHaveLength(0);
    expect(b.audits[0]).toMatchObject({ tool: "edit", verdict: "allow", exec: "direct", resolvedBy: "mode:full" });
    for (const d of b.unload) await d();
  });

  it("settings 保护路径（U13）：Write 工具面 deny settings 文件", async () => {
    const settingsPath = join(root, ".x-harness", "hub-settings.json");
    const b = await bench({ rules: [], protectedPaths: [settingsPath] });
    const denied = await b.call("write", { path: settingsPath });
    expect(denied.isError).toBe(true);
    expect(b.audits[0]?.verdict).toBe("deny");
    for (const d of b.unload) await d();
  });
});

describe("通用 Tool 规则面（P2——任意工具名通配）", () => {
  it("Tool(web*):allow 放行未知工具；deny 压过 allow；无规则保守 ask", () => {
    const input = (rules: readonly PermissionRule[]) => decideFor({ tool: "webfetch", args: {}, userRules: rules, sessionRules: [], profile: PROFILES.auto, root: ROOT, extraRoots: [] });
    expect(input([parseRule("Tool(web*):allow", "user")])).toMatchObject({ verdict: "allow", resolvedBy: "rule:user" });
    expect(input([parseRule("Tool(web*):allow", "user"), parseRule("Tool(webfetch):deny", "user")])).toMatchObject({ verdict: "deny" });
    expect(input([])).toMatchObject({ verdict: "ask", resolvedBy: "default:ask", memorizable: true });
  });

  it("症状回归：无专属面工具曾在 full 档弹确认（保守 ask 不看档）——现直通；Tool deny 仍压过", () => {
    const input = (rules: readonly PermissionRule[]) => decideFor({ tool: "webfetch", args: {}, userRules: rules, sessionRules: [], profile: PROFILES.full, root: ROOT, extraRoots: [] });
    expect(input([])).toMatchObject({ verdict: "allow", exec: "direct", resolvedBy: "mode:full" });
    expect(input([parseRule("Tool(web*):deny", "user")])).toMatchObject({ verdict: "deny" });
  });
});

describe("edit 裁决面（写族——kind 声明面）", () => {
  const edit = (args: unknown, profile: PermissionProfile, rules: readonly PermissionRule[] = []): Decision =>
    decideFor({ tool: "edit", args, userRules: rules, sessionRules: [], profile, root: ROOT, extraRoots: [] });

  it("症状回归：edit 曾在 full 档弹确认（落未知工具保守 ask）——现写族 full 短路 direct", () => {
    expect(edit({ path: "src/a.ts" }, PROFILES.full)).toMatchObject({ verdict: "allow", exec: "direct", resolvedBy: "mode:full" });
  });

  it("症状回归：edit 曾绕过写族防线（plan 硬闸可被批准落盘/.git 写拒与 Write deny 规则不生效）", () => {
    expect(edit({ path: "src/a.ts" }, PROFILES.plan)).toMatchObject({ verdict: "deny", resolvedBy: "mode:plan" });
    expect(edit({ path: ".git/hooks/pre-commit" }, PROFILES.full)).toMatchObject({ verdict: "deny" });
    expect(edit({ path: "src/a.ts" }, PROFILES.full, [parseRule("Write(src/**):deny", "user")])).toMatchObject({ verdict: "deny", resolvedBy: "rule:user" });
  });

  it("与 write 同构：edit-confirm 界内 ask；auto 界内 direct；界外 ask 带 extraRoot grant", () => {
    expect(edit({ path: "src/a.ts" }, PROFILES.editConfirm)).toMatchObject({ verdict: "ask", resolvedBy: "edit-confirm", memorizable: true });
    expect(edit({ path: "src/a.ts" }, PROFILES.auto)).toMatchObject({ verdict: "allow", exec: "direct" });
    expect(edit({ path: "/elsewhere/b.ts" }, PROFILES.auto)).toMatchObject({ verdict: "ask", resolvedBy: "outside-root", grant: { kind: "extraRoot", dir: "/elsewhere" }, memorizable: true });
  });
});

describe("敏感面家目录展开（防词面逃逸）", () => {
  it("绝对路径形态命中 ~/.ssh 表（glob 对绝对路径）", () => {
    const decision = bash(`cat ${join(homedir(), ".ssh", "config")}`, PROFILES.auto);
    expect(decision).toMatchObject({ verdict: "ask", resolvedBy: "argv-sensitive" });
  });
});
