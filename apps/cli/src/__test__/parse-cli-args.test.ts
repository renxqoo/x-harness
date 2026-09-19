// parseCliArgs 表驱动（docs/CLI.md §2.1）：flag 生效/缺省/别名/=形式/互斥全错例/未知 flag/
// `--` 分流/@ 前缀/枚举闭集/可选值 flag。

import { describe, expect, it } from "vitest";
import { parseCliArgs, usageText } from "../parse-cli-args.ts";

function ok(argv: string[]) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) throw new Error(`expected success, got: ${parsed.reason}`);
  return parsed.value;
}

function fail(argv: string[]) {
  const parsed = parseCliArgs(argv);
  if (parsed.ok) throw new Error("expected failure");
  return parsed.reason;
}

describe("flag 生效与缺省", () => {
  it("空 argv → 全缺省形态", () => {
    const args = ok([]);
    expect(args).toMatchObject({
      print: false, mode: "text", continueRecent: false, resume: false, noSession: false,
      noTools: false, listModels: false, version: false, help: false,
      appendSystemPrompts: [], messages: [], fileArgs: [],
    });
  });

  it("短项别名 = 长项（-p/-c/-r/-t/-xt/-nt/-v/-h）", () => {
    expect(ok(["-p"]).print).toBe(true);
    expect(ok(["--print"]).print).toBe(true);
    expect(ok(["-c"]).continueRecent).toBe(true);
    expect(ok(["-r"]).resume).toBe(true);
    expect(ok(["-nt"]).noTools).toBe(true);
    expect(ok(["-v"]).version).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
    expect(ok(["-t", "read,write"]).tools).toEqual(["read", "write"]);
    expect(ok(["-xt", "bash"]).excludeTools).toEqual(["bash"]);
  });

  it("--flag=value 与 --flag value 等价；重复单值 flag 末次胜出", () => {
    expect(ok(["--model=glm"]).model).toBe("glm");
    expect(ok(["--model", "glm"]).model).toBe("glm");
    expect(ok(["--mode", "json"]).mode).toBe("json");
    expect(ok(["--model", "a", "--model", "b"]).model).toBe("b");
  });

  it("--append-system-prompt 可重复累积", () => {
    expect(ok(["--append-system-prompt", "x", "--append-system-prompt=y"]).appendSystemPrompts).toEqual(["x", "y"]);
  });

  it("--list-models 可选值：裸 flag / 附带 search / = 形式 / 邻接非 flag 值", () => {
    expect(ok(["--list-models"]).listModels).toBe(true);
    expect(ok(["--list-models"]).listModelsSearch).toBeUndefined();
    expect(ok(["--list-models", "glm"]).listModelsSearch).toBe("glm");
    expect(ok(["--list-models=flash"]).listModelsSearch).toBe("flash");
  });

  it("--list-models 邻接 - 开头 token 不是 search（留给后续 flag）", () => {
    const args = ok(["--list-models", "--version"]);
    expect(args.listModels).toBe(true);
    expect(args.listModelsSearch).toBeUndefined();
    expect(args.version).toBe(true);
  });

  it("值 flag 缺值报错", () => {
    expect(fail(["--model"])).toContain("requires a value");
    expect(fail(["--mode"])).toContain("requires a value");
  });

  it("工具列表按逗号切分并 trim 空项", () => {
    expect(ok(["--tools", " read , write ,, bash "]).tools).toEqual(["read", "write", "bash"]);
  });
});

describe("位置参数与 --", () => {
  it("@ 前缀进 fileArgs，其余进 messages", () => {
    const args = ok(["hello", "@/tmp/a.txt", "world"]);
    expect(args.messages).toEqual(["hello", "world"]);
    expect(args.fileArgs).toEqual(["/tmp/a.txt"]);
  });

  it("-- 之后全部按位置参数（@ 仍进 fileArgs）", () => {
    const args = ok(["--", "-p", "@x", "--model"]);
    expect(args.print).toBe(false);
    expect(args.messages).toEqual(["-p", "--model"]);
    expect(args.fileArgs).toEqual(["x"]);
  });

  it("单破折号 - 按位置参数处理", () => {
    expect(ok(["-"]).messages).toEqual(["-"]);
  });
});

describe("枚举闭集", () => {
  it("--mode 只收 text|json", () => {
    expect(fail(["--mode", "rpc"])).toContain("expected text | json");
    expect(ok(["--mode", "text"]).mode).toBe("text");
  });

  it("--thinking 只收四级闭集", () => {
    expect(fail(["--thinking", "xhigh"])).toContain("expected off | low | medium | high");
    expect(ok(["--thinking", "high"]).thinking).toBe("high");
  });
});

describe("互斥（表驱动，docs/CLI.md §2.1）", () => {
  const cases: readonly { readonly name: string; readonly argv: string[]; readonly reasonIncludes: string }[] = [
    { name: "-r 与 -p", argv: ["-r", "-p"], reasonIncludes: "-r/--resume needs an interactive terminal" },
    { name: "--no-session 与 -c", argv: ["--no-session", "-c"], reasonIncludes: "--no-session cannot be combined with -c" },
    { name: "--no-session 与 -r", argv: ["--no-session", "-r"], reasonIncludes: "--no-session cannot be combined with -r" },
    { name: "--no-session 与 --session", argv: ["--no-session", "--session", "abc"], reasonIncludes: "--no-session cannot be combined with --session" },
    { name: "--session 与 -c", argv: ["--session", "abc", "-c"], reasonIncludes: "--session cannot be combined with -c" },
    { name: "--session 与 -r", argv: ["--session", "abc", "-r"], reasonIncludes: "--session cannot be combined with -r" },
    { name: "--no-tools 与 --tools", argv: ["--no-tools", "--tools", "read"], reasonIncludes: "--no-tools cannot be combined with --tools" },
    { name: "--no-tools 与 --exclude-tools", argv: ["-nt", "-xt", "bash"], reasonIncludes: "--no-tools cannot be combined with --exclude-tools" },
    { name: "--system-prompt 与 --append-system-prompt", argv: ["--system-prompt", "x", "--append-system-prompt", "y"], reasonIncludes: "--system-prompt cannot be combined with --append-system-prompt" },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → 报错`, () => {
      expect(fail(testCase.argv)).toContain(testCase.reasonIncludes);
    });
  }

  it("合法组合：-p 与 -c / -p 与 --session 放行（方案 §2.1）", () => {
    expect(ok(["-p", "-c"]).print).toBe(true);
    expect(ok(["-p", "--session", "abc"]).session).toBe("abc");
  });
});

describe("未知 flag", () => {
  it("未知长项/短项/带值形式都报 unknown option", () => {
    expect(fail(["--nope"])).toContain("unknown option: --nope");
    expect(fail(["--nope=1"])).toContain("unknown option: --nope");
    expect(fail(["-z"])).toContain("unknown option: -z");
  });
});

describe("usageText", () => {
  it("帮助文本含 bin 名、config 位置与退出码约定", () => {
    const text = usageText("x-harness");
    expect(text).toContain("usage: x-harness");
    expect(text).toContain("providers.json");
    expect(text).toContain("exit codes");
  });
});
