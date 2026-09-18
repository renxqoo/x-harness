// 契约对账（docs/AGENT-DELEGATION.md §2.3——修订B 逐字口径）：五段工具 description 与规格
// 源文档逐字符一致（重同步纪律的机械锚）；参数面与规格参数表一致（形状/必填/pattern/上限）。

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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

const propsOf = (name: string): Record<string, { description?: string; pattern?: string; maxLength?: number; minimum?: number; maximum?: number }> =>
  ((tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, never> }).properties ?? {}) as never;

describe("描述逐字对账（修订B——与规格源文档逐字符一致）", () => {
  it("五段 description 与 spec blockquote 原文逐字符相等", async () => {
    const spec = await readFile("/Users/wrr/work/claude-tool/agent-and-background-tasks.md", "utf8");
    const runs: string[] = [];
    let cur: string[] = [];
    for (const line of spec.split("\n")) {
      if (line.startsWith(">")) cur.push(line.replace(/^> ?/, ""));
      else if (cur.length > 0) {
        runs.push(cur.join("\n"));
        cur = [];
      }
    }
    if (cur.length > 0) runs.push(cur.join("\n"));
    const block = (prefix: string): string => {
      const hit = runs.filter((r) => r.startsWith(prefix));
      expect(hit.length, `spec 原文块唯一：${prefix}`).toBe(1);
      return hit[0] as string;
    };
    expect(AGENT_SPAWN_DESCRIPTION).toBe(block("Launch a new agent"));
    expect(AGENT_MESSAGE_DESCRIPTION).toBe(block("# SendMessage"));
    expect(AGENT_OUTPUT_DESCRIPTION).toBe(block("DEPRECATED: Background tasks"));
    expect(AGENT_STOP_DESCRIPTION).toBe(block("Stops a running background task"));
    expect(LIST_AGENTS_DESCRIPTION).toBe(block("Lists agents you can SendMessage"));
  });
});

describe("参数面对账（与规格参数表一致）", () => {
  it("agent_spawn ↔ Agent：description/prompt 必填，subagent_type/model/isolation 可选，isolation 枚举 worktree|remote", () => {
    const spawn = tools.find((t) => t.name === "agent_spawn")?.inputSchema as unknown as { required?: string[]; properties: Record<string, unknown> };
    expect(spawn.required ?? []).toEqual(["description", "prompt"]);
    expect(Object.keys(spawn.properties).sort()).toEqual(["description", "isolation", "model", "prompt", "subagent_type"]);
    const spawnProps = propsOf("agent_spawn");
    expect(spawnProps["isolation"]?.description).toContain("worktree");
    expect(spawnProps["isolation"]?.description).toContain("remote");
  });

  it("agent_message ↔ SendMessage：to/message 必填带 pattern；summary ≤200；notify_when_idle 布尔", () => {
    const message = tools.find((t) => t.name === "agent_message")?.inputSchema as unknown as { required?: string[]; properties: Record<string, never> };
    expect((message.required ?? []) as string[]).toEqual(["to", "message"]);
    const p = propsOf("agent_message");
    expect(p["to"]?.pattern).toBe("^[^\\n\\r]*$");
    expect(p["message"]?.pattern).toBe("^[\\s\\S]{0,300}$");
    expect(p["summary"]?.maxLength).toBe(200);
    expect(p["summary"]?.description).toContain("not transmitted");
    expect(p["notify_when_idle"]?.description).toContain("ONE notice");
  });

  it("agent_output ↔ TaskOutput：task_id 必填；block/timeout 带缺省语义与 0-600000 限", () => {
    const output = tools.find((t) => t.name === "agent_output")?.inputSchema as unknown as { required?: string[]; properties: Record<string, never> };
    expect((output.required ?? []) as string[]).toEqual(["task_id"]);
    const p = propsOf("agent_output");
    expect(p["block"]?.description).toContain("Whether to wait for completion");
    expect(p["timeout"]?.minimum).toBe(0);
    expect(p["timeout"]?.maximum).toBe(600000);
  });

  it("agent_stop ↔ TaskStop：task_id 必填；list_agents 无参数", () => {
    const stop = tools.find((t) => t.name === "agent_stop")?.inputSchema as unknown as { required?: string[]; properties: Record<string, never> };
    expect((stop.required ?? []) as string[]).toEqual(["task_id"]);
    expect(Object.keys(propsOf("list_agents"))).toEqual([]);
  });

  it("参数描述非空且词边界覆盖字段名或其语义（防漏述）", () => {
    for (const tool of tools) {
      for (const [field, schema] of Object.entries(propsOf(tool.name))) {
        const described = (schema.description?.length ?? 0) > 0 || wordIn(descriptions[tool.name] ?? "", field);
        expect(described, `${tool.name}.${field} 需有参数描述或工具描述提及`).toBe(true);
      }
    }
  });
});
