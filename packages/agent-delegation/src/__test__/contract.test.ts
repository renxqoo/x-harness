// 契约对账（docs/AGENT-DELEGATION.md §2.3/§11.2——P0 假绿硬检查项）：
// ① 正向：schema 每字段名以词边界正则出现在该工具 description 中；
// ② 反向：description 引用的参数词 ⊆ schema 字段（词边界锚写死在本用例）；
// ③ 能力漏述防线：已实现能力关键词必须在描述中出现（防「能力在、描述缺席」）。

import { describe, expect, it } from "vitest";
import { delegationTools } from "../tools.ts";
import {
  AGENT_MESSAGE_DESCRIPTION,
  AGENT_OUTPUT_DESCRIPTION,
  AGENT_SPAWN_DESCRIPTION,
  AGENT_STOP_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
} from "../descriptions.ts";

const tools = delegationTools({
  spawn: async () => ({ ok: false as const, reason: "unused" }),
  message: async () => ({ ok: false as const, reason: "unused" }),
  output: async () => ({ ok: false as const, reason: "unused" }),
  stop: async () => ({ ok: false as const, reason: "unused" }),
  list: async () => [],
});

const descriptions: Record<string, string> = {
  agent_spawn: AGENT_SPAWN_DESCRIPTION,
  agent_message: AGENT_MESSAGE_DESCRIPTION,
  agent_output: AGENT_OUTPUT_DESCRIPTION,
  agent_stop: AGENT_STOP_DESCRIPTION,
  list_agents: LIST_AGENTS_DESCRIPTION,
};

const wordIn = (text: string, word: string): boolean => new RegExp(`\\b${word}\\b`).test(text);

/** 反向锚：各工具 description 中出现的「参数形」词（含引用他工具参数的说明——归并全集） */
const PARAM_WORDS_BY_TOOL: Record<string, readonly string[]> = {
  agent_spawn: ["description", "prompt", "subagent_type", "model", "name", "isolation"],
  agent_message: ["to", "message", "summary", "notify_when_idle"],
  agent_output: ["task_id", "block", "timeout"],
  agent_stop: ["task_id"],
  list_agents: [],
};

describe("描述-schema 双向对账（§2.3/§11.2——P0 硬检查）", () => {
  it("正向：schema 每字段名以词边界出现在该工具 description", () => {
    for (const tool of tools) {
      const desc = descriptions[tool.name] ?? "";
      expect(desc.length, `${tool.name} description 非空`).toBeGreaterThan(0);
      for (const field of Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) {
        expect(wordIn(desc, field), `${tool.name} description 应提及字段 ${field}`).toBe(true);
      }
    }
  });

  it("反向：description 引用的参数词 ⊆ schema 字段（词边界锚）", () => {
    for (const tool of tools) {
      const fields = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const word of PARAM_WORDS_BY_TOOL[tool.name] ?? []) {
        expect(fields, `${tool.name} 引用的参数词 ${word} 应是 schema 字段`).toContain(word);
      }
    }
  });

  it("能力漏述防线：已实现能力的关键词必须在描述中出现", () => {
    expect(AGENT_SPAWN_DESCRIPTION).toContain("isolation \"worktree\"");
    expect(AGENT_MESSAGE_DESCRIPTION).toContain("notify_when_idle");
    expect(AGENT_MESSAGE_DESCRIPTION).toContain("summary");
    expect(AGENT_MESSAGE_DESCRIPTION).toContain("local session");
    expect(AGENT_MESSAGE_DESCRIPTION).toContain("resumes it with its context intact");
    expect(AGENT_OUTPUT_DESCRIPTION).toContain("block=true");
    expect(AGENT_OUTPUT_DESCRIPTION).toContain("timeout");
    expect(AGENT_STOP_DESCRIPTION).toContain("Idempotent");
    expect(LIST_AGENTS_DESCRIPTION).toContain("kind=local-session");
    expect(LIST_AGENTS_DESCRIPTION).toContain("[ref]");
  });
});
