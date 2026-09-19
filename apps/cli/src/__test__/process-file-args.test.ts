// @file 展开（docs/CLI.md §2.1）：wrap 块形态、BOM 剥离、~ 展开、空文件跳过、
// 缺席/二进制错误、相对路径解析。read 注入（不落盘）。

import { describe, expect, it } from "vitest";
import { expandHome, processFileArgs, wrapFileBlock } from "../process-file-args.ts";
import type { Result } from "@x-harness/core";

function fakeRead(files: Record<string, string>): (path: string) => Promise<string> {
  return (path) => {
    const content = files[path];
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    }
    return Promise.resolve(content);
  };
}

function text(result: Promise<Result<{ text: string }>>): Promise<string> {
  return result.then((parsed) => {
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.value.text;
  });
}

describe("wrapFileBlock", () => {
  it("<file name> 包裹 + BOM 剥离", () => {
    expect(wrapFileBlock("a.ts", "hi")).toBe('<file name="a.ts">\nhi\n</file>\n');
    expect(wrapFileBlock("b.ts", "\uFEFFbody")).toBe('<file name="b.ts">\nbody\n</file>\n');
  });
});

describe("expandHome", () => {
  it("~ 与 ~/rest 展开；其余原样", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/x/y", "/home/u")).toBe("/home/u/x/y");
    expect(expandHome("/tmp/x", "/home/u")).toBe("/tmp/x");
    expect(expandHome("~other", "/home/u")).toBe("~other");
  });
});

describe("processFileArgs", () => {
  it("多文件依序拼接", async () => {
    const joined = await text(processFileArgs(["/a.txt", "/b.txt"], fakeRead({ "/a.txt": "A", "/b.txt": "B" }) as never));
    expect(joined).toBe('<file name="/a.txt">\nA\n</file>\n<file name="/b.txt">\nB\n</file>\n');
  });

  it("空文件跳过；全空 → 空串", async () => {
    expect(await text(processFileArgs(["/empty", "/blank"], fakeRead({ "/empty": "", "/blank": "  \n" }) as never))).toBe("");
  });

  it("缺席 → no such file（exit 2 语义）", async () => {
    const parsed = await processFileArgs(["/gone"], fakeRead({}) as never);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("no such file: /gone");
  });

  it("含 NUL → 二进制拒绝", async () => {
    const parsed = await processFileArgs(["/bin"], fakeRead({ "/bin": "a\u0000b" }) as never);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("binary");
  });

  it("相对路径按 cwd 解析后读", async () => {
    const seen: string[] = [];
    const read = (path: string) => {
      seen.push(path);
      return Promise.resolve("R");
    };
    await processFileArgs(["rel.txt"], read as never);
    expect(seen[0]).toBe(`${process.cwd()}/rel.txt`);
  });
});
