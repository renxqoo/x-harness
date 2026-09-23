// 分类器（§4.4——P1 交付物）：三分类词面矩阵 + fail-closed 对抗锚（未知动词/破坏形态
// 不得入只读类——U12 防线的前置件）。传输动词段在多段管线中跳过（载荷承载语义）。

import { describe, expect, it } from "vitest";
import { classifyPipeline } from "../classifier.ts";
import { parseBash } from "../bash/ast.ts";
import type { ParsedCommand } from "../bash/ast.ts";

function commandsOf(source: string): ParsedCommand[] {
  const parsed = parseBash(source);
  if (!parsed.ok) throw new Error(`unparseable: ${source}`);
  return [...parsed.commands];
}

const classify = (source: string): string => {
  const commands = commandsOf(source);
  const hasOutputRedirect = commands.some((cmd) => cmd.redirects.some((r) => r.face === "output" && r.target !== undefined && r.target !== "/dev/null"));
  return classifyPipeline(commands, hasOutputRedirect);
};

describe("classifyPipeline（三分类）", () => {
  it("只读类：观察动词与 git 只读子命令", () => {
    expect(classify("ls -la")).toBe("readonly");
    expect(classify("git status")).toBe("readonly");
    expect(classify("git diff --stat")).toBe("readonly");
    expect(classify("cat README.md | wc -l")).toBe("readonly");
    expect(classify("curl https://example.com")).toBe("unclassified"); // curl 逐出只读表（对抗审查 #2——缺省落盘/上传面）
  });

  it("写类：界内合成写动词与家族子命令", () => {
    expect(classify("mkdir build")).toBe("write");
    expect(classify("git add -A && git commit -m x")).toBe("write");
    expect(classify("npm install")).toBe("write");
    expect(classify("cargo build")).toBe("write");
    expect(classify("echo hi > out.txt")).toBe("write"); // hasOutputRedirect 路径
  });

  it("未分类：未知动词与破坏形态（fail-closed——只读混未知即未知）", () => {
    expect(classify("mytool run")).toBe("unclassified");
    expect(classify("dd if=/dev/zero of=/dev/disk0")).toBe("unclassified");
    expect(classify("rm -rf build")).toBe("unclassified");
    expect(classify("tar -xzf pkg.tgz")).toBe("unclassified");
    expect(classify("find . -delete")).toBe("unclassified"); // -delete 逐出只读
    expect(classify("curl -o payload https://x.test")).toBe("unclassified"); // 落盘旗逐出只读且非写安全 → 问
    expect(classify("git push")).toBe("unclassified"); // git push 非只读子命令非写安全
    expect(classify("ls && mytool run")).toBe("unclassified"); // 只读混未知 = 未知
  });

  it("传输动词：多段管线中载体段跳过（载荷承载语义）；裸载体只读径", () => {
    expect(classify("bash -c 'git status'")).toBe("readonly"); // 载荷段 git status
    expect(classify("timeout 5 npm test")).toBe("write"); // 载荷 npm test
    expect(classify("env VAR=1 ls")).toBe("readonly"); // wrappers 剥离后 argv[0]=ls
    expect(classify("xargs -- grep foo")).toBe("readonly");
    expect(classify("bash")).toBe("readonly"); // 裸载体（无操作数，stdin 即闭）
    expect(classify("env")).toBe("readonly"); // 裸剥离器
    expect(classify("git --version")).toBe("readonly"); // git 旗标形态（无子命令）
    expect(classify("timeout --foreground 5 cargo build")).toBe("write"); // 长旗 + 时长后载荷
    expect(classify("nohup npm run build")).toBe("write");
    expect(classify("env -i git status")).toBe("readonly"); // 旗后载荷
    expect(classify("sh -c 'npm install'")).toBe("write"); // 载荷段写类
  });
});
