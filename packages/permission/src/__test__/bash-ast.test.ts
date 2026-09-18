// AST 底座单元矩阵（docs/EXEC-ENV.md §14.2/§14.5-5）：分类闭集穷尽性三锁（真读语法包
// node-types.json——supertype 过滤 + 计数哨兵 + 恰归一类，grammar 升级加 kind 必红）、
// 装载失败真接缝、常驻装载冒烟锚、heredoc 双形、赋值/declaration 合成单元、裸重定向宿主。

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { classifyKind, parseBash, parseBashWith } from "../bash/ast.ts";

const req = createRequire(import.meta.url);

describe("分类闭集穷尽性（三锁——防 grammar 漂移 + 防空集恒真）", () => {
  const nodeTypes = req("tree-sitter-bash/src/node-types.json") as { type: string; named: boolean }[];
  const visible = nodeTypes.filter((n) => n.named && !n.type.startsWith("_")).map((n) => n.type);

  it("锁一：createRequire 解析真实 node-types.json——可见 named kind 非空且计数哨兵=59", () => {
    expect(visible.length).toBe(59); // 计数哨兵：路径错/JSON 形变 → 0 ≠ 59 红（防空集 every 恒真）
  });
  it("锁二：每个可见 kind 恰归一类（未知=undefined 即红）", () => {
    const unclassified = visible.filter((kind) => classifyKind(kind) === undefined);
    expect(unclassified).toEqual([]);
  });
  it("锁三：合成 kind 与 supertype 不在闭集（未知 → unparseable fail-closed）", () => {
    expect(classifyKind("wibble")).toBeUndefined();
    expect(classifyKind("_statement")).toBeUndefined(); // supertype 运行期不物化——不归类
    expect(classifyKind("ERROR")).toBeUndefined(); // 内置错误节点由 hasError 前置拦截
  });
});

describe("装载与畸形（fail-closed 底座）", () => {
  it("常驻装载冒烟锚：真 parser 可用（bun.lock 拉坏 prebuild 时的定位性红）", () => {
    const parsed = parseBash("echo hi");
    expect(parsed.ok).toBe(true);
  });
  it("parser-unavailable：装载器抛错 → 全量降级 ask 的底座（真接缝非 mock）", () => {
    const fail: () => never = () => {
      throw new Error("prebuild missing");
    };
    expect(parseBashWith("sudo id", fail)).toEqual({ ok: false, kind: "parser-unavailable" });
  });
  it("深嵌套（2 万层 $( $( … ) )）：遍历 RangeError 被兜 → unparseable 不崩", () => {
    const deep = `${"$( ".repeat(20_000)}id${" )".repeat(20_000)}`;
    expect(parseBash(deep)).toEqual({ ok: false, kind: "unparseable" });
  });
});

describe("heredoc 双形（§14.2 边界 1）", () => {
  it("非引号定界：整命令 dynamic + 体内 $( ) 递归成命令 + 注入标记", () => {
    const parsed = parseBash("cat <<EOF\n$(sudo id)\nEOF");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cat = parsed.commands.find((c) => c.argv[0] === "cat");
    expect(cat?.dynamic).toBe(true); // 体会展开——uniform dynamic（含 <<- 盲区）
    expect(cat?.injection).toBe("command-substitution"); // 体内替换压过 full
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(true); // 内层命令入裁决
  });
  it("引号定界：纯字面——体不裁决不标记（放宽回归锚）", () => {
    const parsed = parseBash("cat <<'EOF'\nsudo id\nEOF");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cat = parsed.commands.find((c) => c.argv[0] === "cat");
    expect(cat?.dynamic).toBe(false);
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(false); // 体行不再是命令
  });
  it("<<- tab 形：AST 体节点为空的盲区——注入由节点全文兜底扫描补（内层命令不可收集，执法=注入标记）", () => {
    const parsed = parseBash("cat <<-EOF\n\t$(sudo id)\nEOF");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cat = parsed.commands.find((c) => c.argv[0] === "cat");
    expect(cat?.dynamic).toBe(true);
    expect(cat?.injection).toBe("command-substitution"); // full 档也被压制——盲区不得放行
  });
});

describe("赋值与 declaration 合成单元（§14.2 边界 5）", () => {
  it("语句位 FOO=$(cmd)：合成单元保注入压制（full 档不丢）+ 内层命令入裁决", () => {
    const parsed = parseBash("X=$(sudo id)");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands.some((c) => c.injection === "command-substitution")).toBe(true);
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(true);
  });
  it("语句位 FOO=bar 纯字面：不产合成单元（空转无执法面）", () => {
    const parsed = parseBash("FOO=bar");
    expect(parsed.ok && parsed.commands).toEqual([]);
  });
  it("declare -a 'a=($(sudo id))'：引号数组实参 bash 真执行——原文兜底扫描标注入（审查 B-P0-2）", () => {
    const parsed = parseBash("declare -a 'a=($(sudo id))'");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands.some((c) => c.injection === "command-substitution")).toBe(true);
  });
  it("export FOO=$(cmd)：declaration 同构——注入压制不丢", () => {
    const parsed = parseBash("export FOO=$(sudo id)");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands.some((c) => c.injection === "command-substitution")).toBe(true);
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(true);
  });
});

describe("纯重定向宿主与 fd 边界（§14.2 边界 2）", () => {
  it("无命令纯重定向：argv=[] 携 redirects 入裁决（A-P0-1——越根 truncate 不得放行）", () => {
    const parsed = parseBash("> /etc/passwd");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]?.argv).toEqual([]);
    expect(parsed.commands[0]?.redirects).toEqual([{ face: "output", op: ">", target: "/etc/passwd" }]);
  });
  it("fd 复制/关闭无裁决面；/dev/null 许可字面照提取", () => {
    const parsed = parseBash("cmd 2>&1 >&- >/dev/null");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0]?.redirects).toEqual([{ face: "output", op: ">", target: "/dev/null" }]);
  });
});

describe("词面与动态标记补充", () => {
  it("ansi_c_string（$'\\x73udo'）：bash 解码执行——恒 dynamic 不解码（边界 6）", () => {
    const parsed = parseBash("$'\\x73udo' id");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0]?.dynamic).toBe(true);
  });
  it("注释与空输入：零命令（放行面=无）", () => {
    const comment = parseBash("# $(sudo id)");
    expect(comment.ok ? comment.commands : "unparseable").toEqual([]);
    const empty = parseBash("");
    expect(empty.ok ? empty.commands : "unparseable").toEqual([]);
  });
  it("进程替换在参数位：外层标注入 + 内层命令入裁决", () => {
    const parsed = parseBash("cat <(sudo id)");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cat = parsed.commands.find((c) => c.argv[0] === "cat");
    expect(cat?.injection).toBe("command-substitution");
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(true);
  });
  it("sud$((1))o：argv0 含算术展开 → dynamic（边界 9——拼接逃逸不可低估）", () => {
    const parsed = parseBash("sud$((1))o id");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0]?.dynamic).toBe(true);
  });
});
describe("覆盖补测（§14.6 覆盖率预算——真实形态补齐未达分支）", () => {
  it("管道喂解释器 stdin：`echo \"sudo id\" | bash` → opaque（内容静态不可见）", () => {
    const parsed = parseBash('echo "sudo id" | bash');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const bash = parsed.commands.find((c) => c.argv[0] === "bash");
    expect(bash?.opaque).toBe("opaque-code:bash");
  });
  it("复合体重定向归属：`{ ls; } > out.txt` 重定向挂到体内叶命令", () => {
    const parsed = parseBash("{ ls; } > out.txt");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0]?.redirects).toEqual([{ face: "output", op: ">", target: "out.txt" }]);
  });
  it("here-string：`cmd <<< word` 无文件目标；`cmd <<< \"$(sudo id)\"` 展开标记 + 递归", () => {
    const plain = parseBash("cmd <<< word");
    expect(plain.ok && plain.commands[0]?.redirects).toEqual([{ face: "input", op: "<<<", target: undefined }]); // stdin 判定面记录（无目标不裁决）
    const expand = parseBash('cmd <<< "$(sudo id)"');
    expect(expand.ok).toBe(true);
    if (!expand.ok) return;
    const cmd = expand.commands.find((c) => c.argv[0] === "cmd"); // 内层命令先入列
    expect(cmd?.dynamic).toBe(true);
    expect(cmd?.injection).toBe("command-substitution");
    expect(expand.commands.some((c) => c.argv[0] === "sudo")).toBe(true);
  });
  it("替换目标重定向 `> >(sudo id)`：递归收集内层命令、不裁目标", () => {
    const parsed = parseBash("cmd > >(sudo id)");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(true);
  });
  it("declaration 值为双引号串：`export X=\"$(sudo id)\"` 展开经 scanExpansions 串分支", () => {
    const parsed = parseBash('export X="$(sudo id)"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands.some((c) => c.injection === "command-substitution")).toBe(true);
    expect(parsed.commands.some((c) => c.argv[0] === "sudo")).toBe(true);
  });
  it("防御位：宿主节点出现在语句位（语法不可达形）——子件仍遍历不崩（结构化假树经真接缝）", () => {
    const mk = (type: string, text: string, children: readonly FakeNode[] = []): FakeNode => ({
      type,
      isNamed: true,
      text,
      hasError: false,
      children,
      namedChildren: children.filter((c) => c.isNamed),
    });
    const anon = (type: string, text: string): FakeNode => ({ type, isNamed: false, text, hasError: false, children: [], namedChildren: [] });
    const root = mk("program", "> f", [mk("file_redirect", "> f", [anon(">", ">"), mk("process_substitution", "$(id)", [mk("command", "id", [mk("command_name", "id", [mk("word", "id")])])])])]);
    const fakeParser = class {
      setLanguage(_lang: unknown): void {}
      parse(_src: string): { rootNode: FakeNode } {
        return { rootNode: root };
      }
    };
    const parsed = parseBashWith("> f", () => ({ Parser: fakeParser, Bash: {} }));
    expect(parsed.ok ? parsed.commands.map((c) => c.argv) : [["FAIL"]]).toEqual([["id"], []]); // procsub 内层命令 + 语句位替换合成单元——删防御分支即红
  });
});

interface FakeNode {
  readonly type: string;
  readonly isNamed: boolean;
  readonly text: string;
  readonly hasError: boolean;
  readonly children: readonly FakeNode[];
  readonly namedChildren: readonly FakeNode[];
}

describe("覆盖补测二（分支余量——裸重定向管道与 payload 尾路径）", () => {
  it("裸重定向管道：`> a | > b` 无 argv 命令的 pipeline——不标注入不崩", () => {
    const parsed = parseBash("> a | > b");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands.every((c) => c.argv.length === 0)).toBe(true); // 两个纯重定向宿主
    expect(parsed.commands.every((c) => c.injection === undefined)).toBe(true);
  });
});
