import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../slash-commands.ts";

describe("slash 表一致性：SLASH_COMMANDS ↔ /help", () => {
  it("/help 输出含全部命令（生成面单源）", () => {
    const help = SLASH_COMMANDS.map((command) => `${command.usage.padEnd(28)}${command.help}`).join("\n");
    for (const command of SLASH_COMMANDS) expect(help).toContain(`/${command.name}`);
  });
});
