// 泛化建议器边界（§5.2）：字面 argv0+子命令才泛化；wrapper/解释器字符串载荷/opaque/
// 多段管线一律不泛化（返回 undefined——记忆退化精确全串）。

import { describe, expect, it } from "vitest";
import { exactRule, suggestRule } from "../suggest.ts";
import { parseBash } from "../bash/ast.ts";

function suggestOf(source: string): string | undefined {
  const parsed = parseBash(source);
  if (!parsed.ok) throw new Error(`unparseable: ${source}`);
  return suggestRule(parsed);
}

describe("suggestRule（泛化边界）", () => {
  it("字面形态泛化：argv0+字面子命令 → `Bash(v sub:*)`；裸 argv0 → `Bash(v:*)`", () => {
    expect(suggestOf("npm install lodash")).toBe("Bash(npm install:*):allow");
    expect(suggestOf("git status")).toBe("Bash(git status:*):allow");
    expect(suggestOf("make")).toBe("Bash(make:*):allow");
  });

  it("不泛化面：wrapper/解释器/带路径 argv0/多段管线/动态", () => {
    expect(suggestOf("bash -c 'npm install'")).toBeUndefined();
    expect(suggestOf("node -e 'code'")).toBeUndefined();
    // env VAR=1 make：wrappers 已剥离成裸 make——泛化 Bash(make:*) 合法（透明载体）
    expect(suggestOf("/usr/local/bin/mytool run")).toBeUndefined();
    expect(suggestOf("npm install && npm test")).toBeUndefined();
    expect(suggestOf("cat $FILE")).toBeUndefined();
  });

  it("精确兜底：不泛化形态的落账串为全命令原文", () => {
    expect(exactRule("node -e 'code'")).toBe("Bash(node -e 'code'):allow");
  });
});
