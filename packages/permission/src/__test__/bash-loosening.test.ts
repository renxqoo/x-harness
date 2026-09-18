// 放宽回归锚（docs/EXEC-ENV.md §14.4/§14.5-4）：每条有意放宽钉死——将来退回假阳性/恒 ask
// 必红。harness：fence 在场（auto 档界内合成面）；dynamic 类另钉 auto ask / full allow 双态。

import { describe, expect, it } from "vitest";
import { adjudicateBash } from "../bash/adjudicate.ts";
import { parseRule } from "../rules/parse.ts";

const ROOT = "/w/app";
const FENCE = { writable: [ROOT], allowedDomains: [] };
const WIDE = [parseRule("Bash(*):allow", "user")];
const fenced = { rules: [] as ReturnType<typeof parseRule>[], mode: "auto" as const, root: ROOT, extraRoots: [], fence: FENCE };

describe("放宽锚（防退回假阳性）", () => {
  it("算术展开 $((1+2))：非注入——auto 界内 ask（dynamic 词）、full allow（旧两档恒 ask）", () => {
    expect(adjudicateBash({ ...fenced, command: "echo $((1+2))" }).verdict).toBe("ask");
    expect(adjudicateBash({ ...fenced, command: "echo $((1+2))", mode: "full" }).verdict).toBe("allow");
  });
  it("单引号内 $( )：shell 本就不展开——界内 allow（旧恒 ask 假阳性）", () => {
    expect(adjudicateBash({ ...fenced, command: "echo '$(x)'" }).verdict).toBe("allow");
  });
  it("注释内 $( )：不执行——界内 allow", () => {
    expect(adjudicateBash({ ...fenced, command: "# $(sudo id)" }).verdict).toBe("allow");
  });
  it("引号定界 heredoc 体：纯字面——界内 allow（体含 sudo 行也不假阳性）", () => {
    expect(adjudicateBash({ ...fenced, command: "cat <<'EOF'\nsudo id\nEOF" }).verdict).toBe("allow");
  });
  it("引号内 >：不误作重定向目标（界内 allow，真目标 f 在界内）", () => {
    expect(adjudicateBash({ ...fenced, command: 'echo "a > /etc/passwd" > f' }).verdict).toBe("allow");
  });
  it("glob：未引用通配 auto ask（现行收紧面不放宽）、引号内通允许、full 放", () => {
    expect(adjudicateBash({ ...fenced, command: "cat *.log" }).verdict).toBe("ask");
    expect(adjudicateBash({ ...fenced, command: 'echo "*"' }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "cat *.log", mode: "full" }).verdict).toBe("allow");
  });
  it("赋值前缀不拖 dynamic：FOO=$X git status 界内 allow（旧 dynamic ask）", () => {
    expect(adjudicateBash({ ...fenced, command: "FOO=$X git status" }).verdict).toBe("allow");
  });
  it("转义字面 echo \\$HOME：不误标 dynamic——界内 allow", () => {
    expect(adjudicateBash({ ...fenced, command: "echo \\$HOME" }).verdict).toBe("allow");
  });
  it("xargs/find -exec/eval/bash -c 良性形界内 allow（旧 injection 恒 ask）", () => {
    expect(adjudicateBash({ ...fenced, command: "ls | xargs grep foo" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "find . -name x -exec grep foo {} \\;" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "eval 'git status'" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "bash -c 'git status'" }).verdict).toBe("allow");
  });
});

describe("reason 快照（§14.5-6——防实现期 reason 词漂移）", () => {
  it("全 reason 词表逐条钉死", () => {
    const pin = (command: string, mode: "auto" | "full" | "plan", rules: readonly ReturnType<typeof parseRule>[] = []): readonly string[] => {
      const out = adjudicateBash({ ...fenced, rules, command, mode });
      return [out.verdict, out.reason, out.resolvedBy];
    };
    expect(pin("git push", "plan")).toEqual(["deny", "plan mode disallows bash", "mode:plan"]);
    const noFence = adjudicateBash({ ...fenced, fence: undefined, command: "git push" });
    expect([noFence.verdict, noFence.reason, noFence.resolvedBy]).toEqual(["ask", "no rule matches segment", "default:ask"]);
    expect(pin("sudo id", "auto")).toEqual(["ask", "hard-deny:sudo", "hard-deny"]);
    expect(pin("echo $(x)", "auto")).toEqual(["ask", "injection:command-substitution", "injection"]);
    expect(pin("echo $(x)", "full")).toEqual(["allow", "full mode", "mode:full"]); // 裁决⑤：注入在 full 不拦
    expect(pin("rm -rf /", "full")).toEqual(["allow", "full mode", "mode:full"]); // 硬拒其余形态 full 不拦（围栏承载）
    expect(pin("sudo id", "full")).toEqual(["deny", "hard-deny:sudo", "mode:full"]); // 唯提权直接拦截
    expect(pin("echo 'oops", "full")).toEqual(["allow", "full mode", "mode:full"]); // 畸形 full 不保守 ask
    expect(pin("cat $F", "auto")).toEqual(["ask", "dynamic-segment (expansion/glob)", "static"]);
    expect(pin("echo x > /etc/passwd", "auto")).toEqual(["ask", "redirect:/etc/passwd", "redirect"]);
    expect(pin("cmd < ~/.ssh/id_rsa", "auto")).toEqual(["deny", "redirect-read:~/.ssh/**", "redirect-read"]);
    expect(pin("echo 'oops", "auto")).toEqual(["ask", "unparseable command", "parse"]);
    expect(pin("nohup", "auto")).toEqual(["ask", "wrapper:nohup", "wrapper"]);
    expect(pin("bash x.sh", "auto")).toEqual(["ask", "opaque-code:bash", "opaque"]); // 无规则 harness——opaque 可被 allow 越过是独立语义
    expect(pin("git status", "auto")).toEqual(["allow", "in-fence", "auto:fence"]);
    expect(pin("ls", "auto", WIDE)).toEqual(["allow", "in-fence", "auto:fence"]);
  });
  it("deny 规则压过注入（裁决序重排锚——§14.4：确定性拒绝先于保守 ask）", () => {
    const rules = [parseRule("Bash(echo:*):deny", "user"), parseRule("Bash(*):allow", "user")];
    const out = adjudicateBash({ ...fenced, rules, command: "echo $(whoami)" });
    expect(out).toEqual({ verdict: "deny", reason: "rule:echo:*", resolvedBy: "rule:user" });
  });
});

describe("输入面双向钉（§14.2 边界 2 / §14.5-7）", () => {
  it.each(["~/.ssh/id_rsa", "~/.aws/credentials", "~/.gcp/key.json", "sub/.env"])("拒读表全表项：cmd < %s → deny", (target) => {
    const out = adjudicateBash({ ...fenced, command: `cmd < ${target}` });
    expect(out.verdict).toBe("deny");
    expect(out.reason).toMatch(/^redirect-read:/);
  });
  it("反向钉：`cmd < /etc/passwd` 不 deny 不 ask（不做越根 ask——将来补越根必红）", () => {
    expect(adjudicateBash({ ...fenced, command: "cmd < /etc/passwd" }).verdict).toBe("allow");
  });
});
