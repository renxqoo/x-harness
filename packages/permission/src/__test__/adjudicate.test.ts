// 裁决管线矩阵（docs/EXEC-ENV.md §5/§7）：段序（deny 规则→硬拒→dynamic→重定向→allow→默认）/
// 三模式档 / needs_network 双路 / NEVER_MEMORIZE（allow 规则不可越过硬拒）/ fence 合成。

import { describe, expect, it } from "vitest";
import { adjudicateBash } from "../bash/adjudicate.ts";
import { decideFor } from "../decide.ts";
import { parseRule } from "../rules/parse.ts";

const ROOT = "/w/app";
const rules = (texts: readonly string[] = []) => texts.map((t) => parseRule(t, "user"));

describe("adjudicateBash（管线裁决序）", () => {
  it("plan 档：bash 全拒（deny 先于一切）", () => {
    expect(adjudicateBash({ command: "ls", rules: rules(["Bash(ls):allow"]), mode: "plan", root: ROOT, extraRoots: [] })).toEqual({
      verdict: "deny",
      reason: "plan mode disallows bash",
      resolvedBy: "mode:plan",
    });
  });

  it("auto 档：无规则段 → ask；有 allow 规则 → allow", () => {
    const ask = adjudicateBash({ command: "git status", rules: rules(), mode: "auto", root: ROOT, extraRoots: [] });
    expect(ask.verdict).toBe("ask");
    const allow = adjudicateBash({ command: "git status", rules: rules(["Bash(git status):allow"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(allow.verdict).toBe("allow");
  });

  it("复合命令逐段：任一段无规则 → ask；deny 规则压过 allow（deny-beats-allow）", () => {
    const ask = adjudicateBash({ command: "git status && npm test", rules: rules(["Bash(git status):allow"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(ask.verdict).toBe("ask"); // npm test 段未配
    const deny = adjudicateBash({ command: "git status && git push", rules: rules(["Bash(git status):allow", "Bash(git push):deny"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(deny.verdict).toBe("deny"); // deny 段存在即 deny
    const both = adjudicateBash({ command: "git push", rules: rules(["Bash(git push:*):allow", "Bash(git push):deny"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(both.verdict).toBe("deny"); // 同段 deny 压过 allow
  });

  it("NEVER_MEMORIZE：allow 万配规则不可越过硬拒/注入（恒 ask）", () => {
    const wide = rules(["Bash(*):allow"]);
    expect(adjudicateBash({ command: "sudo id", rules: wide, mode: "auto", root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "rm -rf /", rules: wide, mode: "auto", root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "echo $(whoami)", rules: wide, mode: "auto", root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "ls", rules: wide, mode: "auto", root: ROOT, extraRoots: [] }).verdict).toBe("allow");
  });

  it("full 档：全 allow 除 deny 规则与硬拒（dynamic 段也过——仍受围栏）", () => {
    const wide = rules(["Bash(*):allow"]);
    expect(adjudicateBash({ command: "ls -la $HOME", rules: wide, mode: "full", root: ROOT, extraRoots: [] }).verdict).toBe("allow");
    expect(adjudicateBash({ command: "npm test", rules: rules(), mode: "full", root: ROOT, extraRoots: [] }).verdict).toBe("allow");
    expect(adjudicateBash({ command: "sudo id", rules: wide, mode: "full", root: ROOT, extraRoots: [] }).verdict).toBe("ask"); // 硬拒底线恒 ask（NEVER_MEMORIZE）
    expect(adjudicateBash({ command: "git push --force", rules: rules(["Bash(git push:*):deny"]), mode: "full", root: ROOT, extraRoots: [] }).verdict).toBe("deny"); // deny 规则压过硬拒（确定性拒绝先于保守 ask）
  });

  it("重定向：界内 allow；越根/~/.. 归一后越根 → ask(redirect)；/dev/null 与 2>&1 不裁决", () => {
    const ok = adjudicateBash({ command: "echo hi > out.txt", rules: rules(["Bash(echo:*):allow"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(ok.verdict).toBe("allow");
    for (const target of ["../esc.txt", "/etc/passwd", "~/secret.txt"]) {
      const out = adjudicateBash({ command: `echo hi > ${target}`, rules: rules(["Bash(echo:*):allow"]), mode: "auto", root: ROOT, extraRoots: [] });
      expect(out.verdict).toBe("ask");
      expect(out.reason).toContain("redirect");
    }
    const devnull = adjudicateBash({ command: "cmd >/dev/null 2>&1", rules: rules(["Bash(cmd):allow"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(devnull.verdict).toBe("allow");
  });

  it("授权根（extraRoots）内的重定向放行", () => {
    const out = adjudicateBash({ command: "echo hi > /w/extra/f.txt", rules: rules(["Bash(echo:*):allow"]), mode: "auto", root: ROOT, extraRoots: ["/w/extra"] });
    expect(out.verdict).toBe("allow");
  });

  it("needs_network：声明 → ask network；未声明界内 → allow", () => {
    const base = { rules: rules(["Bash(curl:*):allow"]), mode: "auto" as const, root: ROOT, extraRoots: [] };
    expect(adjudicateBash({ ...base, command: "curl https://x", needsNetwork: true }).verdict).toBe("ask");
    expect(adjudicateBash({ ...base, command: "curl https://x" }).verdict).toBe("allow");
  });

  it("unparseable（未闭合引号）→ 保守 ask", () => {
    expect(adjudicateBash({ command: "echo 'oops", rules: rules(["Bash(*):allow"]), mode: "auto", root: ROOT, extraRoots: [] }).verdict).toBe("ask");
  });

  it("dynamic 段：auto → ask；full → 过", () => {
    expect(adjudicateBash({ command: "cat $F", rules: rules(["Bash(cat:*):allow"]), mode: "auto", root: ROOT, extraRoots: [] }).verdict).toBe("ask");
    expect(adjudicateBash({ command: "cat $F", rules: rules(["Bash(cat:*):allow"]), mode: "full", root: ROOT, extraRoots: [] }).verdict).toBe("allow");
  });

  it("decideFor 路径面：full 放行未配路径；plan 拒写放读；界外 ask 的 grant=目标父目录；未知工具 ask", () => {
    const base = { userRules: [], sessionRules: [] as ReturnType<typeof parseRule>[], root: ROOT, extraRoots: [] };
    expect(decideFor({ ...base, tool: "read", args: { path: "/etc/hosts" }, mode: "full" }).verdict).toBe("allow");
    expect(decideFor({ ...base, tool: "read", args: { path: "f.txt" }, mode: "plan" }).verdict).toBe("allow"); // plan 只拒写/exec
    const planWrite = decideFor({ ...base, tool: "write", args: { path: "f.txt", content: "x" }, mode: "plan" });
    expect(planWrite.verdict).toBe("deny");
    const outside = decideFor({ ...base, tool: "read", args: { path: "/w/app/../other/deep/f.txt" }, mode: "auto" });
    expect(outside.verdict).toBe("ask");
    expect(outside.grant).toEqual({ kind: "extraRoot", dir: "/w/other/deep" }); // .. 归一后的父目录
    expect(decideFor({ ...base, tool: "mystery", args: {}, mode: "auto" }).verdict).toBe("ask");
  });

  it("fence 在场 → resolvedBy auto:fence；缺席 → auto", () => {
    const withFence = adjudicateBash({ command: "ls", rules: rules(["Bash(ls):allow"]), mode: "auto", root: ROOT, extraRoots: [], fence: { writable: [ROOT], allowedDomains: [] } });
    expect(withFence.resolvedBy).toBe("auto:fence");
    const noFence = adjudicateBash({ command: "ls", rules: rules(["Bash(ls):allow"]), mode: "auto", root: ROOT, extraRoots: [] });
    expect(noFence.resolvedBy).toBe("auto");
  });
});
