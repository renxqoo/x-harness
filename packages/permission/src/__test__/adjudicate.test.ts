// 裁决管线矩阵（docs/EXEC-ENV.md §5/§7）：段序（deny 规则→硬拒→dynamic→重定向→allow→默认）/
// 三模式档 / NEVER_MEMORIZE（allow 规则不可越过硬拒）/ fence 合成。

import { describe, expect, it } from "vitest";
import { adjudicateBash as __adjudicateBash } from "../bash/adjudicate.ts";
import { knobDecideOf } from "@x-harness/permission-modes";
function adjudicateBash(input: Parameters<typeof __adjudicateBash>[0]): ReturnType<typeof __adjudicateBash> {
  const faces = knobDecideOf(input.profile);
  return __adjudicateBash({ ...input, ...(input.modeDecide === undefined && faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(input.postureDecide === undefined && faces.posture !== undefined ? { postureDecide: faces.posture } : {}) });
}
import { decideFor as __decideFor } from "../decide.ts";
function decideFor(input: Parameters<typeof __decideFor>[0]): ReturnType<typeof __decideFor> {
  const faces = knobDecideOf(input.profile);
  const family = (["read","write","edit","grep","bash"] as const).includes(input.tool as never) ? ({ read: "Read", write: "Write", edit: "Write", grep: "Read", bash: "Danger" } as const)[input.tool as "read" | "write" | "edit" | "grep" | "bash"] : undefined; // 测试注入：模拟 dispatch 从 ToolDefinition.kind 穿引
  return __decideFor({ ...input, ...(input.kind === undefined && family !== undefined ? { kind: family } : {}), ...(input.modeDecide === undefined && faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(input.postureDecide === undefined && faces.posture !== undefined ? { postureDecide: faces.posture } : {}) });
}
import { parseRule } from "../rules/parse.ts";
import { resolveProfile } from "@x-harness/permission-modes";
const PLAN_PROFILE = resolveProfile("plan")!;
const AUTO_PROFILE = resolveProfile("auto")!;
const FULL_PROFILE = resolveProfile("full")!;

const ROOT = "/w/app";
const rules = (texts: readonly string[] = []) => texts.map((t) => parseRule(t, "user"));

describe("adjudicateBash（管线裁决序）", () => {
  it("plan 档（V3 阶段二——纯直调=严格缺省）：bash 全拒（富策略规格在 tool-plan/plan-mode.test）；deny 规则核心先行归因 rule", () => {
    const PLAN = PLAN_PROFILE;
    expect(adjudicateBash({ command: "ls -la src", rules: rules(["Danger(ls):allow"]), profile: PLAN, root: ROOT, extraRoots: [] })).toEqual({
      verdict: "deny",
      reason: "plan mode disallows bash",
      resolvedBy: "mode:plan",
    });
    expect(adjudicateBash({ command: "git log --oneline -10", rules: rules(), profile: PLAN, root: ROOT, extraRoots: [] }).reason).toBe("plan mode disallows bash");
    expect(adjudicateBash({ command: "mkdir d", rules: rules(), profile: PLAN, root: ROOT, extraRoots: [] }).reason).toBe("plan mode disallows bash");
    expect(adjudicateBash({ command: "sudo ls", rules: rules(), profile: PLAN, root: ROOT, extraRoots: [] }).reason).toBe("plan mode: elevation denied");
    expect(adjudicateBash({ command: "cat $(echo x)", rules: rules(), profile: PLAN, root: ROOT, extraRoots: [] }).reason).toBe("plan mode disallows bash"); // 严格缺省不细分注入面（富策略细分）
    expect(adjudicateBash({ command: "git log", rules: rules(["Danger(git log):deny"]), profile: PLAN, root: ROOT, extraRoots: [] })).toMatchObject({ verdict: "deny", reason: "rule:git log", resolvedBy: "rule:user" }); // 红线 1
  });

  it("auto 档：未分类动词无规则 → ask；分类器零交互；有 allow 规则 → allow（PERMISSION-V2 §3）", () => {
    const ask = adjudicateBash({ command: "mytool run", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(ask.verdict).toBe("ask"); // 未分类动词缺省问（on-opaque）
    const zeroTouch = adjudicateBash({ command: "git status", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(zeroTouch).toMatchObject({ verdict: "allow", resolvedBy: "classifier:readonly" }); // 分类器零交互（U4）
    const allow = adjudicateBash({ command: "git status", rules: rules(["Danger(git status):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(allow.verdict).toBe("allow");
  });

  it("复合命令逐段：未分类段拖累全管线 ask；deny 规则压过 allow（deny-beats-allow）", () => {
    const ask = adjudicateBash({ command: "git status && mytool run", rules: rules(["Danger(git status):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(ask.verdict).toBe("ask"); // mytool 段未分类未配
    const deny = adjudicateBash({ command: "git status && git push", rules: rules(["Danger(git status):allow", "Danger(git push):deny"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(deny.verdict).toBe("deny"); // deny 段存在即 deny
    const both = adjudicateBash({ command: "git push", rules: rules(["Danger(git push:*):allow", "Danger(git push):deny"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(both.verdict).toBe("deny"); // 同段 deny 压过 allow
  });

  it("NEVER_MEMORIZE：allow 万配规则不可越过硬拒/注入（恒 ask）", () => {
    const wide = rules(["Danger(*):allow"]);
    expect(adjudicateBash({ command: "sudo id", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "rm -rf /", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "echo $(whoami)", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "ls", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("allow");
  });

  it("full 档（裁决⑤完全访问）：全过——唯提权/密码类直接 deny；用户 deny 规则仍最高", () => {
    const wide = rules(["Danger(*):allow"]);
    expect(adjudicateBash({ command: "ls -la $HOME", rules: wide, profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("allow");
    expect(adjudicateBash({ command: "npm test", rules: rules(), profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("allow");
    expect(adjudicateBash({ command: "sudo id", rules: wide, profile: FULL_PROFILE, root: ROOT, extraRoots: [] })).toEqual({ verdict: "deny", reason: "hard-deny:sudo", resolvedBy: "mode:full" }); // 提权直接拦截（裁决⑤）
    expect(adjudicateBash({ command: "doas id", rules: wide, profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("deny");
    expect(adjudicateBash({ command: "su -c id", rules: wide, profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("deny"); // 密码类
    expect(adjudicateBash({ command: "git push --force", rules: rules(["Danger(git push:*):deny"]), profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("deny"); // 用户 deny 规则仍最高
    expect(adjudicateBash({ command: "git push --force", rules: rules(), profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask"); // A①（2026-09-28）：force-push 硬拒面在 full 被最小 ask 钳制
  });

  it("重定向：界内 allow；越根/~/.. 归一后越根 → ask(redirect)；/dev/null 与 2>&1 不裁决", () => {
    const ok = adjudicateBash({ command: "echo hi > out.txt", rules: rules(["Danger(echo:*):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(ok.verdict).toBe("allow");
    for (const target of ["../esc.txt", "/etc/passwd", "~/secret.txt"]) {
      const out = adjudicateBash({ command: `echo hi > ${target}`, rules: rules(["Danger(echo:*):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
      expect(out.verdict).toBe("ask");
      expect(out.reason).toContain("redirect");
    }
    const devnull = adjudicateBash({ command: "cmd >/dev/null 2>&1", rules: rules(["Danger(cmd):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(devnull.verdict).toBe("allow");
  });

  it("授权根（extraRoots）内的重定向放行", () => {
    const out = adjudicateBash({ command: "echo hi > /w/extra/f.txt", rules: rules(["Danger(echo:*):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: ["/w/extra"] });
    expect(out.verdict).toBe("allow");
  });

  it("unparseable（未闭合引号）→ 保守 ask", () => {
    expect(adjudicateBash({ command: "echo 'oops", rules: rules(["Danger(*):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
  });

  it("dynamic 段：auto → ask；full → 过", () => {
    expect(adjudicateBash({ command: "cat $F", rules: rules(["Danger(cat:*):allow"]), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "cat $F", rules: rules(["Danger(cat:*):allow"]), profile: FULL_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("allow");
  });

  it("decideFor 路径面：full 放行未配路径；plan 拒写放读；界外 ask 的 grant=目标父目录；未知工具 ask", () => {
    const base = { userRules: [], sessionRules: [] as ReturnType<typeof parseRule>[], root: ROOT, extraRoots: [] };
    expect(decideFor({ ...base, tool: "read", args: { path: "/etc/hosts" }, profile: FULL_PROFILE }).verdict).toBe("allow");
    expect(decideFor({ ...base, tool: "read", args: { path: "f.txt" }, profile: PLAN_PROFILE }).verdict).toBe("allow"); // plan 只拒写/exec
    const planWrite = decideFor({ ...base, tool: "write", args: { path: "f.txt", content: "x" }, profile: PLAN_PROFILE });
    expect(planWrite.verdict).toBe("deny");
    const outside = decideFor({ ...base, tool: "read", args: { path: "/w/app/../other/deep/f.txt" }, profile: AUTO_PROFILE });
    expect(outside.verdict).toBe("ask");
    expect(outside.grant).toBeUndefined(); // P-bug-4b：读族不挂 root grant（读授权不扩成写授权）
    const outsideWrite = decideFor({ ...base, tool: "write", args: { path: "/w/app/../other/deep/f.txt", content: "x" }, profile: AUTO_PROFILE });
    expect(outsideWrite.verdict).toBe("ask");
    expect(outsideWrite.grant).toEqual({ kind: "extraRoot", dir: "/w/other/deep" }); // 写族：.. 归一后的父目录
    const topLevel = decideFor({ ...base, tool: "write", args: { path: "/top.txt", content: "x" }, profile: AUTO_PROFILE });
    expect(topLevel.grant).toBeUndefined(); // P-bug-3：父目录为 / 不挂 grant（一次批准≠会话 unrestricted）
    expect(decideFor({ ...base, tool: "mystery", args: {}, profile: AUTO_PROFILE }).verdict).toBe("ask");
  });

  it("决策 fence 无关性（PERMISSION-V2 U15——执行指令归档位，裁决不再依赖围栏在场）", () => {
    const withFence = adjudicateBash({ command: "ls", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [], fence: { writable: [ROOT] } });
    expect(withFence.resolvedBy).toBe("classifier:readonly");
    const noFence = adjudicateBash({ command: "ls", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(noFence.resolvedBy).toBe("classifier:readonly"); // 同裁决——包裹去留是执行面的事
  });

  it("分类器接管界内合成（PERMISSION-V2 §4.4——U5 直通姿势）：有围栏无围栏同裁决零交互", () => {
    const fenced = adjudicateBash({ command: "git status && npm test", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [], fence: { writable: [ROOT] } });
    expect(fenced).toMatchObject({ verdict: "allow", resolvedBy: "classifier:in-root-write" });
    const bare = adjudicateBash({ command: "git status && npm test", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(bare).toMatchObject({ verdict: "allow", resolvedBy: "classifier:in-root-write" }); // 无围栏同裁决（直通档）
    const fencedDynamic = adjudicateBash({ command: "cat $F", rules: rules(), profile: AUTO_PROFILE, root: ROOT, extraRoots: [], fence: { writable: [ROOT] } });
    expect(fencedDynamic.verdict).toBe("ask"); // 动态段即便围栏在场也 ask
  });

  it("env -i 逃脱（审查 F11）：env 前缀 flag 词剥离后硬拒仍中", () => {
    const wide = rules(["Danger(env:*):allow", "Danger(*):allow"]);
    expect(adjudicateBash({ command: "env -i sudo id", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "env -u USER sudo rm -rf /", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "env -i git status", rules: wide, profile: AUTO_PROFILE, root: ROOT, extraRoots: [], fence: { writable: [ROOT] } }).verdict).toBe("allow"); // 良性 env 用法不误伤
  });
});
