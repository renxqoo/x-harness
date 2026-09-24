// shell 词法封装表驱动：sh 真执行回读断言（不经 mock——词法正确性由真实 shell 裁决）。

import { describe, expect, it } from "vitest";
import { commandOf, shellQuoteWord } from "../shell-quote.ts";

describe("shellQuoteWord", () => {
  it.each([
    ["plain", "'plain'"],
    ["", "''"],
    ["with space", "'with space'"],
    ["it's", "'it'\\''s'"],
    ["a'b'c", "'a'\\''b'\\''c'"],
    ["$(rm -rf /)", `'$(rm -rf /)'`],
    ["back`tick`", "'back`tick`'"],
    ["换行\n注入", `'换行\n注入'`],
    ["emoji🔐", "'emoji🔐'"],
  ])("%s → %s", (word, quoted) => {
    expect(shellQuoteWord(word)).toBe(quoted);
  });
});

describe("commandOf", () => {
  it("exec 前缀 + 逐词封装", () => {
    expect(commandOf(["/bin/sh", "-c", "echo hi"])).toBe(`exec '/bin/sh' '-c' 'echo hi'`);
  });

  it("空 argv → 空串（调用方降级 spawn 失败）", () => {
    expect(commandOf([])).toBe("");
  });

  it("词法往返：真 sh 下 exec 还原原 argv（$HOME/`x` 单引号内不展开——注入中和是词法的安全语义）", async () => {
    const argv = ["echo", "a b", "it's", "$HOME", "`x`", "ok词"];
    const proc = Bun.spawn(["/bin/sh", "-c", commandOf(argv)]);
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(out.trimEnd()).toBe("a b it's $HOME `x` ok词");
  });
});
