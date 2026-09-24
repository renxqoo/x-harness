// 契约对账（docs/AGENT-DELEGATION.md §2.3——修订B 逐字口径 + docs/DELEGATION-LONG-CONTENT.md
// 件15 批1）：本包三段工具 description 与规格源文档逐字符一致（重同步纪律的机械锚）；
// 参数面 = 形状/必填/上限对账——message maxLength 按注入 reportCap 插值（D1/D6 恒等单旋钮），
// summary 无 schema 上限（D7——description 承诺截断语义由 verb 层 SUMMARY_CAP 兑现）。
// task_stop 的跨源口径归 @x-harness/task-tools（件14）——对账在其包内。

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { delegationTools } from "../tools.ts";
import {
  AGENT_MESSAGE_DESCRIPTION,
  AGENT_SPAWN_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
} from "../descriptions.ts";

const tools = delegationTools({
  spawn: async () => ({ ok: false as const, reason: "unused" }),
  message: async () => ({ ok: false as const, reason: "unused" }),
  list: async () => [],
  reportCap: 34_000,
});

const toolsSmallCap = delegationTools({
  spawn: async () => ({ ok: false as const, reason: "unused" }),
  message: async () => ({ ok: false as const, reason: "unused" }),
  list: async () => [],
  reportCap: 1_000,
});

const descriptions: Record<string, string> = {
  agent_spawn: AGENT_SPAWN_DESCRIPTION,
  agent_message: AGENT_MESSAGE_DESCRIPTION,
  list_agents: LIST_AGENTS_DESCRIPTION,
};

const wordIn = (text: string, word: string): boolean => new RegExp(`\\b${word}\\b`).test(text);

const propsOf = (name: string, from: typeof tools = tools): Record<string, { description?: string; pattern?: string; maxLength?: number; minimum?: number; maximum?: number }> => {
  const schema = from.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, never> } | undefined;
  return (schema?.properties ?? {}) as never;
};

describe("描述逐字对账（修订B——与规格源文档逐字符一致）", () => {
  it("三段 description 与 spec blockquote 原文逐字符相等", async () => {
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
    expect(LIST_AGENTS_DESCRIPTION).toBe(block("Lists agents you can SendMessage"));
  });
});

describe("参数面对账（形状/必填/上限——件15 载体双裁决）", () => {
  it("agent_spawn ↔ Agent：description/prompt 必填，subagent_type/model/isolation 可选，isolation 枚举 worktree|remote", () => {
    const spawn = tools.find((t) => t.name === "agent_spawn")?.inputSchema as unknown as { required?: string[]; properties: Record<string, unknown> };
    expect(spawn.required ?? []).toEqual(["description", "prompt"]);
    expect(Object.keys(spawn.properties).sort()).toEqual(["description", "isolation", "model", "prompt", "subagent_type"]);
    const spawnProps = propsOf("agent_spawn");
    expect(spawnProps["isolation"]?.description).toContain("worktree");
    expect(spawnProps["isolation"]?.description).toContain("remote");
  });

  it("agent_message ↔ SendMessage：to/message 必填；message maxLength = 注入 reportCap（D1/D6 恒等——缺省 34000 + 自定义 1000 双断言）", () => {
    const message = tools.find((t) => t.name === "agent_message")?.inputSchema as unknown as { required?: string[]; properties: Record<string, never> };
    expect((message.required ?? []) as string[]).toEqual(["to", "message"]);
    const p = propsOf("agent_message");
    expect(p["to"]?.pattern).toBe("^[^\\n\\r]*$");
    expect(p["message"]?.maxLength).toBe(34_000);
    expect(p["message"]?.pattern).toBeUndefined(); // 载体已弃 pattern（D6）
    expect(propsOf("agent_message", toolsSmallCap)["message"]?.maxLength).toBe(1_000);
  });

  it("summary 无 schema 上限（D7）+ 截断承诺锚词（钉 description prose 与 verb 层 SUMMARY_CAP 数字同步）", () => {
    const p = propsOf("agent_message");
    expect(p["summary"]?.maxLength).toBeUndefined();
    expect(p["summary"]?.description).toContain("not transmitted");
    expect(p["summary"]?.description).toContain("Truncated to 500");
    expect(p["notify_when_idle"]?.description).toContain("ONE notice");
  });

  it("list_agents 无参数；工具面只有本包三工具（task_stop 归 task-tools）", () => {
    expect(Object.keys(propsOf("list_agents"))).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual(["agent_message", "agent_spawn", "list_agents"]);
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
