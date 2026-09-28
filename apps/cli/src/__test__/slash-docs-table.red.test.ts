// 红测（对抗审查——b85e043 宿主面）：slash 表一致性。
// docs/CLI.md §2.3「slash 命令表（闭集）」与 SLASH_COMMANDS 逐条对齐断言。
// 现状：SLASH_COMMANDS 十二条（含 /workflow——ef9df23 引入），docs 表只列十一条——
// /workflow 整体缺席（docs/CLI.md 全文 grep "workflow" 零命中）。b85e043 提交自述
// 「CLI.md 命令表同步」但只补了 /plan。/help 输出由 SLASH_COMMANDS 生成（helpText），
// 故 /help 与 docs 表不一致——用户在 /help 看到 /workflow、在文档闭集表里找不到。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../slash-commands.ts";

const DOC_PATH = fileURLToPath(new URL("../../../../docs/CLI.md", import.meta.url));

/** §2.3 slash 命令表块：从「slash 命令表」标记行起到下一个 - ** 条目止 */
function slashTableBlock(doc: string): string {
  const marker = doc.indexOf("slash 命令表");
  expect(marker).toBeGreaterThan(-1);
  const next = doc.indexOf("\n- **", marker);
  return doc.slice(marker, next === -1 ? undefined : next);
}

describe("slash 表一致性：SLASH_COMMANDS ↔ docs/CLI.md 命令表 ↔ /help", () => {
  it("/help 输出含全部命令（生成面单源——现状为绿）", () => {
    const help = SLASH_COMMANDS.map((command) => `${command.usage.padEnd(28)}${command.help}`).join("\n");
    for (const command of SLASH_COMMANDS) expect(help).toContain(`/${command.name}`);
  });

  it("docs/CLI.md 命令表（闭集）应列出 SLASH_COMMANDS 全部十二条（红——/workflow 缺席）", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const block = slashTableBlock(doc);
    const missing = SLASH_COMMANDS.filter((command) => !block.includes(`/${command.name}`)).map((command) => `/${command.name}`);
    expect(missing).toEqual([]); // 现状：missing = ["/workflow"]
  });
});
