// 包装器/解释器/payload 政策矩阵（docs/EXEC-ENV.md §14.2 边界 3/4、§14.5-2/3）：
// 剥离全家族 × sudo → ask；未知旗 fail-closed；剥后残渣；解释器 -c 再解析与传染；
// xargs/find -exec payload 良性放行/危险拦；恒 ask 表 it.each 全词。

import { describe, expect, it } from "vitest";
import { adjudicateBash } from "../bash/adjudicate.ts";
import { parseBash } from "../bash/ast.ts";
import { parseRule } from "../rules/parse.ts";

const ROOT = "/w/app";
const FENCE = { writable: [ROOT], allowedDomains: [] };
const WIDE = [parseRule("Bash(*):allow", "user")];
const wide = { rules: WIDE, mode: "auto" as const, root: ROOT, extraRoots: [], fence: FENCE };
const fenced = { rules: [] as ReturnType<typeof parseRule>[], mode: "auto" as const, root: ROOT, extraRoots: [], fence: FENCE };

describe("剥离家族 × sudo（WIDE harness——硬拒不可被 allow 越过）", () => {
  it.each([
    ["nohup sudo id", "nohup"],
    ["setsid sudo id", "setsid"],
    ["exec sudo id", "exec"],
    ["command sudo id", "command"],
    ["builtin sudo id", "builtin"],
    ["time sudo id", "time"],
    ["time -p sudo id", "time"],
    ["timeout 5 sudo id", "timeout"],
    ["timeout --signal=KILL 5 sudo id", "timeout"],
    ["timeout -k 5 10 sudo id", "timeout"],
    ["nice -n 5 sudo id", "nice"],
    ["nice -5 sudo id", "nice"],
    ["nice --adjustment=5 sudo id", "nice"],
    ["stdbuf -oL sudo id", "stdbuf"],
    ["stdbuf --error=1m sudo id", "stdbuf"],
    ["watch -n 5 sudo id", "watch"],
    ["watch --no-title sudo id", "watch"],
    ["env -i sudo id", "env"],
    ["env -u USER sudo id", "env"],
    ["env -- sudo id", "env"],
    ["env X=1 Y=2 sudo id", "env"],
    ["xargs timeout 5 sudo id", "xargs"], // 嵌套包装器：payload 再过政策
  ])("%s → 剥离后硬拒（wrapper 家族先于 allow）", (command) => {
    const out = adjudicateBash({ ...wide, command });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("hard-deny:sudo");
  });
  it("良性剥离不误伤：env -i git status 界内 allow（fence 无规则）", () => {
    expect(adjudicateBash({ ...fenced, command: "env -i git status" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "timeout 5 git status" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "nohup git status" }).verdict).toBe("allow");
  });
});

describe("未知旗 fail-closed（§14.2 边界 3——结构失败类，WIDE 也拦）", () => {
  it.each([
    ["timeout -q 5 sudo id", "wrapper:timeout"],
    ["nice --weird sudo id", "wrapper:nice"],
    ["stdbuf -z 1 sudo id", "wrapper:stdbuf"],
    ["watch -dn 5 sudo id", "wrapper:watch"],
    ["env -C / sudo id", "wrapper:env"],
    ["xargs -Z sudo id", "wrapper:xargs"],
  ])("%s → ask（不可被 allow 越过）", (command, reason) => {
    const out = adjudicateBash({ ...wide, command });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe(reason);
  });
  it("剥后结构残渣：`time { sudo id; }` 解析形 argv=[time,{,sudo,id] → wrapper:time", () => {
    const out = adjudicateBash({ ...wide, command: "time { sudo id; }" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("wrapper:time");
  });
  it("剥后空 argv：裸 `nohup` → wrapper:nohup", () => {
    const out = adjudicateBash({ ...wide, command: "nohup" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("wrapper:nohup");
  });
});

describe("解释器 -c 载荷（§14.2 边界 4）", () => {
  it("bash -c 'sudo id'：字面量再解析——内层硬拒兜住", () => {
    const out = adjudicateBash({ ...wide, command: "bash -c 'sudo id'" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("hard-deny:sudo");
  });
  it("bash -c 'git status'：良性载荷界内 allow（放宽——旧恒 ask）", () => {
    expect(adjudicateBash({ ...fenced, command: "bash -c 'git status'" }).verdict).toBe("allow");
  });
  it("bash -c \"$x\" 动态载荷 / `bash -c` 空载荷 → ask", () => {
    const dynamic = adjudicateBash({ ...fenced, command: 'bash -c "$x"' });
    expect(dynamic.verdict).toBe("ask");
    expect(dynamic.reason).toBe("opaque-code:bash");
    const empty = adjudicateBash({ ...fenced, command: "bash -c" });
    expect(empty.verdict).toBe("ask");
    expect(empty.reason).toBe("opaque-code:bash");
  });
  it("载荷再解析 unparseable 传染外层：`bash -c 'if x then y fi'` → ask", () => {
    const out = adjudicateBash({ ...fenced, command: "bash -c 'if x then y fi'" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("unparseable command");
  });
  it("bash -x script.sh：非代码旗后文件操作数仍落 opaque", () => {
    const out = adjudicateBash({ ...fenced, command: "bash -x script.sh" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("opaque-code:bash");
  });
});

describe("eval/trap 载荷（§14.2 边界 8）", () => {
  it("eval 'sudo id'：再解析内层硬拒；eval 动态载荷 → injection:eval", () => {
    const literal = adjudicateBash({ ...wide, command: "eval 'sudo id'" });
    expect(literal.verdict).toBe("ask");
    expect(literal.reason).toBe("hard-deny:sudo");
    const dynamic = adjudicateBash({ ...wide, command: "eval '$CMD'" });
    expect(dynamic.verdict).toBe("ask");
    expect(dynamic.reason).toBe("injection:eval");
  });
  it("eval 'git status' 良性界内 allow（放宽）；裸 eval 空转放行", () => {
    expect(adjudicateBash({ ...fenced, command: "eval 'git status'" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "eval" }).verdict).toBe("allow");
  });
  it("trap 'sudo id' EXIT：再解析内层硬拒；trap 动态载荷 → opaque", () => {
    const literal = adjudicateBash({ ...wide, command: "trap 'sudo id' EXIT" });
    expect(literal.verdict).toBe("ask");
    expect(literal.reason).toBe("hard-deny:sudo");
    const dynamic = adjudicateBash({ ...fenced, command: "trap '$CMD' EXIT" });
    expect(dynamic.verdict).toBe("ask");
    expect(dynamic.reason).toBe("injection:eval"); // 延迟执行代码不可见——与 eval 同类不可被 allow 越
  });
});

describe("payload 提取（xargs/find -exec/parallel——§14.2 边界 3）", () => {
  it("危险 payload：xargs sudo rm / find -exec sudo id / parallel sudo → ask", () => {
    for (const command of ["ls | xargs sudo rm", "find . -exec sudo id \\;", "parallel sudo id", "find . -execdir sudo id \\;"]) {
      const out = adjudicateBash({ ...wide, command });
      expect(out.verdict).toBe("ask");
      expect(out.reason).toBe("hard-deny:sudo");
    }
  });
  it("良性 payload 界内 allow（放宽——旧 injection 恒 ask）", () => {
    expect(adjudicateBash({ ...fenced, command: "ls | xargs grep foo" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "find . -name x -exec grep foo {} \\;" }).verdict).toBe("allow");
  });
  it("空载荷注入：裸 `xargs` / `ls | xargs` → injection:xargs-shell（压过 full）", () => {
    const out = adjudicateBash({ ...wide, command: "ls | xargs" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("injection:xargs-shell");
    const full = adjudicateBash({ ...wide, command: "ls | xargs", mode: "full" });
    expect(full.verdict).toBe("ask");
  });
  it("find -exec 空 payload：`find . -exec \\;` → injection:find-exec", () => {
    const out = adjudicateBash({ ...wide, command: "find . -exec \\;" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("injection:find-exec");
  });
  it("xargs 旗面矩阵：附着/分离形正常跳参（-I{} / -n 2 / --arg-file=f）", () => {
    expect(adjudicateBash({ ...wide, command: "ls | xargs -I{} sudo rm {}" }).reason).toBe("hard-deny:sudo");
    expect(adjudicateBash({ ...wide, command: "ls | xargs -n 2 sudo rm" }).reason).toBe("hard-deny:sudo");
    expect(adjudicateBash({ ...fenced, command: "xargs --arg-file=list.txt grep foo" }).verdict).toBe("allow");
  });
});

describe("恒 ask 表 it.each 全词（不透明信任类——fence 无规则 harness）", () => {
  it.each([
    "source /tmp/evil.sh",
    ". /tmp/evil.sh",
    "ssh host sudo id",
    "docker run x",
    "podman run x",
    "kubectl delete all",
    "osascript -e 'tell app x'",
    "script -q /dev/null sudo id",
    "coproc sudo id",
    "strace sudo id",
    "ltrace sudo id",
    "valgrind sudo id",
  ])("%s → opaque ask", (command) => {
    const out = adjudicateBash({ ...fenced, command });
    expect(out.verdict).toBe("ask");
    expect(out.resolvedBy).toBe("opaque");
  });
});

describe("裸解释器与裸 awk（无操作数无代码旗——同现行放行）", () => {
  it("bash / awk 无实参界内 allow", () => {
    expect(adjudicateBash({ ...fenced, command: "bash" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "awk" }).verdict).toBe("allow");
  });
});

describe("词面重构快照（argv 剥离后的真实形状）", () => {
  it("env -i 前缀与 timeout 时长剥离后 argv 即载荷", () => {
    const env = parseBash("env -i git status");
    expect(env.ok && env.commands[0]?.argv).toEqual(["git", "status"]);
    const timeout = parseBash("timeout 5 git push");
    expect(timeout.ok && timeout.commands[0]?.argv).toEqual(["git", "push"]);
  });
});

describe("旗面变体补测（覆盖预算——各剥离器变体分支）", () => {
  it.each([
    ["timeout --foreground 5 sudo id"],
    ["timeout -h 5 sudo id"],
    ["stdbuf -o 1m sudo id"],
    ["stdbuf -i 0 sudo id"],
    ["watch -d sudo id"],
  ])("%s → 剥离后硬拒", (command) => {
    const out = adjudicateBash({ ...wide, command });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("hard-deny:sudo");
  });
  it("解释器 -- 分隔：`bash -- script.sh` 操作数 → opaque", () => {
    const out = adjudicateBash({ ...fenced, command: "bash -- script.sh" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("opaque-code:bash");
  });
  it("载体 -- 与长旗：`xargs -- grep foo` / `xargs --no-run-if-empty grep foo` 良性放行", () => {
    expect(adjudicateBash({ ...fenced, command: "xargs -- grep foo" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "xargs --no-run-if-empty grep foo" }).verdict).toBe("allow");
  });
  it("管道喂解释器：`echo x | bash` / `cat f | python3` → opaque ask（stdin 内容不可见）", () => {
    const bash = adjudicateBash({ ...fenced, command: "echo x | bash" });
    expect(bash.verdict).toBe("ask");
    expect(bash.reason).toBe("opaque-code:bash");
    expect(adjudicateBash({ ...fenced, command: "cat f | python3" }).reason).toBe("opaque-code:python3");
  });
});

describe("旗面变体补测二（payload/载体尾路径）", () => {
  it("xargs 裸短旗形 `-` 开头非载体旗 → fail 保守", () => {
    const out = adjudicateBash({ ...wide, command: "ls | xargs -Z grep foo" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("wrapper:xargs");
  });
  it("find 无 -exec 族词照常命令裁决；无终止符 payload 取余词（保守过判）", () => {
    expect(adjudicateBash({ ...fenced, command: "find . -name x" }).verdict).toBe("allow");
    const unterminated = adjudicateBash({ ...wide, command: "find . -exec sudo id" }); // 无 \; —— 余词全当 payload
    expect(unterminated.reason).toBe("hard-deny:sudo");
  });
});
