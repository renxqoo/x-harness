// slash 命令（docs/CLI.md §2.3 词表封闭 + 表驱动）：闭集 = /help 列出集；每命令行为
// 用假 deps 驱动；未知命令提示；非 slash 行 not-slash。

import { describe, expect, it } from "vitest";
import type { SessionHeader } from "@x-harness/session";
import { parseProvidersConfig } from "../providers-file.ts";
import { runSlashCommand, SLASH_COMMANDS } from "../slash-commands.ts";
import type { SlashDeps, SlashDial } from "../slash-commands.ts";

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [
      { name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["glm-4.7", "glm-4.7-flash"] },
      { name: "ovt", protocol: "openai", baseUrl: "https://b", apiKey: "k", models: ["qwen3"] },
    ],
    default: { provider: "glm", model: "glm-4.7" },
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  return parsed.value;
})();

interface Recorder {
  readonly lines: string[];
  readonly reopens: { sessionId?: string; newSession?: boolean; dial?: SlashDial }[];
  readonly compacts: (string | undefined)[];
  readonly exports: string[];
  questions: string[];
  answers: string[];
  inMemory: boolean;
  dial: SlashDial;
}

function makeDemos(over: Partial<Recorder> = {}): { recorder: Recorder; deps: SlashDeps } {
  const recorder: Recorder = {
    lines: [], reopens: [], compacts: [], exports: [], questions: [], answers: [], inMemory: false, dial: { provider: "glm", model: "glm-4.7" },
    ...over,
  };
  const deps: SlashDeps = {
    write: (line) => recorder.lines.push(line),
    question: (prompt) => {
      recorder.questions.push(prompt);
      return Promise.resolve(recorder.answers.shift());
    },
    config: CONFIG,
    current: () => ({ dial: recorder.dial, inMemory: recorder.inMemory }),
    usageSummary: () => "tokens: none yet",
    sessionFacts: () => "session s1 · 10 events · glm/glm-4.7",
    reopen: async (request) => {
      recorder.reopens.push(request);
      return "REOPEN-OK";
    },
    listMainSessions: async () => [{ id: "sess-1", createdAt: 1 }, { id: "sess-2", createdAt: 2 }] as SessionHeader[],
    compact: async (instructions) => {
      recorder.compacts.push(instructions);
      return "COMPACT-OK";
    },
    exportTo: async (path) => {
      recorder.exports.push(path);
      return "EXPORT-OK";
    },
  };
  return { recorder, deps };
}

describe("词表封闭", () => {
  it("命令表 = /help 列出集（闭集十命令）", async () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help", "quit", "new", "model", "thinking", "session", "compact", "export", "resume", "clear",
    ]);
    const { recorder, deps } = makeDemos();
    await runSlashCommand("/help", deps);
    const text = recorder.lines.join("\n");
    for (const command of SLASH_COMMANDS) {
      expect(text).toContain(command.usage);
    }
  });

  it("未知命令 → 提示不崩；非 slash 行 → not-slash", async () => {
    const { recorder, deps } = makeDemos();
    expect(await runSlashCommand("/nope", deps)).toBe("unknown");
    expect(recorder.lines[0]).toContain("unknown command");
    expect(await runSlashCommand("plain text", deps)).toBe("not-slash");
  });

  it("每条表内命令分派可达（不含 quit）", async () => {
    for (const command of SLASH_COMMANDS) {
      if (command.name === "quit") continue;
      const { deps } = makeDemos({ answers: ["1"] });
      const outcome = await runSlashCommand(`/${command.name}${command.name === "export" ? " /tmp/x.jsonl" : ""}`, deps);
      expect(outcome).toBe("handled");
    }
  });
});

describe("分派行为", () => {
  it("/quit → quit outcome，不写输出", async () => {
    const { recorder, deps } = makeDemos();
    expect(await runSlashCommand("/quit", deps)).toBe("quit");
    expect(recorder.lines).toEqual([]);
  });

  it("/new → reopen(newSession)", async () => {
    const { recorder, deps } = makeDemos();
    await runSlashCommand("/new", deps);
    expect(recorder.reopens).toEqual([{ newSession: true }]);
  });

  it("/model pattern 唯一命中 → reopen(dial)；零命中提示；歧义走编号选择", async () => {
    const unique = makeDemos();
    await runSlashCommand("/model qwen3", unique.deps);
    expect(unique.recorder.reopens[0]).toEqual({ dial: { provider: "ovt", model: "qwen3" } });

    const miss = makeDemos();
    await runSlashCommand("/model nope", miss.deps);
    expect(miss.recorder.reopens).toEqual([]);
    expect(miss.recorder.lines[0]).toContain("no model matches");

    const ambiguous = makeDemos({ answers: ["2"] });
    await runSlashCommand("/model glm", ambiguous.deps);
    expect(ambiguous.recorder.reopens[0]).toEqual({ dial: { provider: "glm", model: "glm-4.7-flash" } });
  });

  it("/model 无参 → 列全部模型并编号选择；内存会话拒绝切换", async () => {
    const list = makeDemos({ answers: ["3"] });
    await runSlashCommand("/model", list.deps);
    expect(list.recorder.lines[0]).toContain("qwen3");
    expect(list.recorder.reopens[0]).toEqual({ dial: { provider: "ovt", model: "qwen3" } });

    const memory = makeDemos({ inMemory: true });
    await runSlashCommand("/model qwen3", memory.deps);
    expect(memory.recorder.reopens).toEqual([]);
    expect(memory.recorder.lines[0]).toContain("in-memory");
  });

  it("/thinking：合法等级 → reopen；非法 → 词表提示；无参 → 显示当前", async () => {
    const ok = makeDemos();
    await runSlashCommand("/thinking high", ok.deps);
    expect(ok.recorder.reopens[0]).toEqual({ dial: { thinking: "high" } });

    const max = makeDemos();
    await runSlashCommand("/thinking max", max.deps);
    expect(max.recorder.reopens[0]).toEqual({ dial: { thinking: "max" } }); // max 档合法（五级闭集）

    const bad = makeDemos();
    await runSlashCommand("/thinking ultra", bad.deps);
    expect(bad.recorder.reopens).toEqual([]);
    expect(bad.recorder.lines[0]).toContain("off | low | medium | high | max");

    const show = makeDemos();
    await runSlashCommand("/thinking", show.deps);
    expect(show.recorder.lines[0]).toBe("thinking: off");
  });

  it("/session → facts + usage（一次写出，两行内容）", async () => {
    const { recorder, deps } = makeDemos();
    await runSlashCommand("/session", deps);
    expect(recorder.lines[0]).toContain("session s1");
    expect(recorder.lines[0]).toContain("tokens:");
  });

  it("/compact 带参透传 instructions；/export 缺参 → usage 提示", async () => {
    const compact = makeDemos();
    await runSlashCommand("/compact focus on api", compact.deps);
    expect(compact.recorder.compacts).toEqual(["focus on api"]);

    const missing = makeDemos();
    await runSlashCommand("/export", missing.deps);
    expect(missing.recorder.exports).toEqual([]);
    expect(missing.recorder.lines[0]).toContain("usage: /export");
  });

  it("/resume → 列表 + 编号选择 reopen(sessionId)；内存会话拒绝", async () => {
    const resume = makeDemos({ answers: ["2"] });
    await runSlashCommand("/resume", resume.deps);
    expect(resume.recorder.lines[0]).toContain("sess-2"); // 倒序：2 号位是 createdAt 较新的
    expect(resume.recorder.reopens[0]).toEqual({ sessionId: "sess-2" });

    const memory = makeDemos({ inMemory: true });
    await runSlashCommand("/resume", memory.deps);
    expect(memory.recorder.reopens).toEqual([]);
    expect(memory.recorder.lines[0]).toContain("in-memory");
  });

  it("/clear → ANSI 清屏序列", async () => {
    const { recorder, deps } = makeDemos();
    await runSlashCommand("/clear", deps);
    expect(recorder.lines[0]).toBe("\x1b[2J\x1b[H");
  });
});
