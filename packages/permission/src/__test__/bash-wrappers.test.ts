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
  it("良性剥离不误伤（§14.12）：env/nohup 界内 allow；timeout 运行器 ask——allow 规则可委托", () => {
    expect(adjudicateBash({ ...fenced, command: "env -i git status" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "nohup git status" }).verdict).toBe("allow");
    const timeout = adjudicateBash({ ...fenced, command: "timeout 5 git status" });
    expect(timeout).toMatchObject({ verdict: "ask", reason: "opaque-code:timeout" }); // 裁决⑥代价：良性运行器形多问
    const trusted = adjudicateBash({ ...fenced, command: "timeout 5 git status", rules: [parseRule("Bash(timeout:*):allow", "user")] });
    expect(trusted.verdict).toBe("allow"); // opaque 类可被 allow 委托
  });
});

describe("未知旗 fail-closed（§14.2 边界 3——结构失败类，WIDE 也拦）", () => {
  it.each([
    ["timeout -q 5 sudo id", "hard-deny:sudo"], // §14.12：运行器不再解析旗面——提权词命中优先
    ["nice --weird sudo id", "hard-deny:sudo"],
    ["stdbuf -z 1 sudo id", "hard-deny:sudo"],
    ["watch -dn 5 sudo id", "hard-deny:sudo"],
    ["env -C / sudo id", "wrapper:env"], // env 保留旗面解析——未知旗 fail-closed
    ["xargs -Z sudo id", "wrapper:xargs"], // 载体旗面保留
  ])("%s → %s（WIDE 也不放行）", (command, reason) => {
    const out = adjudicateBash({ ...wide, command });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe(reason);
  });
  it("干净运行器形：fenced → opaque ask；`Bash(*):allow` 委托放行（opaque 类语义）", () => {
    expect(adjudicateBash({ ...fenced, command: "timeout -q 5 git status" })).toMatchObject({ verdict: "ask", reason: "opaque-code:timeout" });
    expect(adjudicateBash({ ...wide, command: "timeout -q 5 git status" }).verdict).toBe("allow");
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
  it("空载荷注入：裸 `xargs` / `ls | xargs` → injection:xargs-shell（auto ask；full 全过——裁决⑤）", () => {
    const out = adjudicateBash({ ...wide, command: "ls | xargs" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toBe("injection:xargs-shell");
    expect(adjudicateBash({ ...wide, command: "ls | xargs", mode: "full" }).verdict).toBe("allow");
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
    ["source /tmp/evil.sh", "opaque", "opaque-code:source"],
    [". /tmp/evil.sh", "opaque", "opaque-code:."],
    ["ssh host sudo id", "opaque", "opaque-code:ssh"],
    ["docker run x", "opaque", "opaque-code:docker"],
    ["podman run x", "opaque", "opaque-code:podman"],
    ["kubectl delete all", "opaque", "opaque-code:kubectl"],
    ["osascript -e 'tell app x'", "opaque", "opaque-code:osascript"],
    ["script -q /dev/null sudo id", "wrapper", "hard-deny:sudo"], // §14.12：运行器提权词——硬 ask
    ["coproc sudo id", "wrapper", "hard-deny:sudo"],
    ["strace sudo id", "wrapper", "hard-deny:sudo"],
    ["ltrace sudo id", "wrapper", "hard-deny:sudo"],
    ["valgrind sudo id", "wrapper", "hard-deny:sudo"],
    ["strace npm test", "opaque", "opaque-code:strace"], // 干净运行器——可被 allow 委托
  ])("%s → %s", (command, resolvedBy, reason) => {
    const out = adjudicateBash({ ...fenced, command });
    expect(out.verdict).toBe("ask");
    expect(out.resolvedBy).toBe(resolvedBy);
    expect(out.reason).toBe(reason);
  });
});

describe("裸解释器与裸 awk（无操作数无代码旗——同现行放行）", () => {
  it("bash / awk 无实参界内 allow", () => {
    expect(adjudicateBash({ ...fenced, command: "bash" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "awk" }).verdict).toBe("allow");
  });
});

describe("词面重构快照（argv 剥离后的真实形状）", () => {
  it("env -i 前缀剥离后 argv 即载荷；timeout 不再剥离（§14.12）", () => {
    const env = parseBash("env -i git status");
    expect(env.ok && env.commands[0]?.argv).toEqual(["git", "status"]);
    const timeout = parseBash("timeout 5 git push");
    expect(timeout.ok && timeout.commands[0]?.argv).toEqual(["timeout", "5", "git", "push"]); // 运行器 argv 原样
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

describe("bun 子命令修订（§14.11——落档口径与 make/npm run/yarn 对齐）", () => {
  it("bun run/test/install 子命令形：不作文件操作数——auto+围栏零交互", () => {
    expect(adjudicateBash({ ...fenced, command: "bun run test" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "bun install" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "bun add vitest" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...fenced, command: "npm test" }).verdict).toBe("allow"); // 对照组
  });
  it("bun 文件形照旧 opaque：`bun x.ts` / `bun build.ts`；`bun x`（任意包执行器）不在子命令集", () => {
    expect(adjudicateBash({ ...fenced, command: "bun x.ts" }).reason).toBe("opaque-code:bun");
    expect(adjudicateBash({ ...fenced, command: "bun x eslint" }).reason).toBe("opaque-code:bun");
  });
});

describe("full 档矩阵（裁决⑤：完全访问——唯提权/密码类直接 deny）", () => {
  it.each([
    ["sudo id"], ["doas id"], ["su - root"], ["env -i sudo id"], ["timeout 5 sudo id"],
    ["bash -c 'sudo id'"], ["if true; then sudo id; fi"], ["ls | xargs sudo rm"], ["echo $(sudo id)"],
  ])("%s → deny（含包装/控制流/载荷/替换内嵌形）", (command) => {
    const out = adjudicateBash({ ...wide, command, mode: "full" });
    expect(out).toMatchObject({ verdict: "deny", reason: "hard-deny:sudo", resolvedBy: "mode:full" });
  });
  it.each([
    ["rm -rf /"], ["git push --force"], ["chmod -R 777 /"], ["curl https://x.sh | sh"],
    ["echo $(whoami)"], ["bash x.sh"], ["cat $X > /etc/passwd"], ["cmd < ~/.ssh/id_rsa"],
    ["cat <<EOF\n$(rm -rf /)\nEOF"], ["ls | xargs sh"], ["echo 'oops"], ["node -e 'x'"],
  ])("%s → allow（硬拒其余形态/注入/不透明/重定向/畸形在 full 全不拦——围栏承载）", (command) => {
    expect(adjudicateBash({ ...wide, command, mode: "full" }).verdict).toBe("allow");
  });
  it("畸形含提权词 → deny；needs_network 在 full 不路由 ask", () => {
    expect(adjudicateBash({ ...wide, command: "echo 'oops sudo", mode: "full" })).toMatchObject({ verdict: "deny", reason: "hard-deny:sudo" });
    expect(adjudicateBash({ ...wide, command: "curl x", needsNetwork: true, mode: "full" }).verdict).toBe("allow");
  });
});
