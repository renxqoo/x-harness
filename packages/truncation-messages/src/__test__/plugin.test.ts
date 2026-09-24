// 截断配对文案插件（docs/WORK-ERROR-RECOVERY.md C3）三用例：替换生效（真装配全链）/
// 无插件世界内核短事实保底 / content-note 并存优先级（替换优先于追加）。

import { createContext, loadPlugins } from "@x-harness/core";
import { agentLoopPlugin, agentTruncatedTool, agentLoopServiceToken, TRUNCATED_TOOL_MESSAGE } from "@x-harness/agent-loop";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { createDefaultTruncationMessages, TRUNCATED_TOOL_FULL_MESSAGE } from "../index.ts";
import { afterEach, describe, expect, it } from "vitest";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
  cleanups = [];
});

/** 真装配世界（含 agent-loop）：半截 tool-call 脚本走内核 pairTruncatedCalls 全链 */
async function makeWorld(extra: Parameters<typeof loadPlugins>[1] = []) {
  const ctx = createContext();
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin, ...extra]);
  ctx.effect(() => { for (const off of unload) off(); });
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: () => scripts.shift() ?? (async function* (): AsyncGenerator<LlmChunk> { yield { type: "finish", finish: { kind: "stop" } }; })(),
  });
  ctx.effect(off);
  const made = await ctx.use(agentLoopServiceToken).create({ agent: { model: "m", provider: "fake" } });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  cleanups.push(async () => {
    await made.value.dispose();
    await ctx.dispose();
  });
  return { ctx, scripts, agent: made.value.agent };
}

function truncatedToolScript(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId: "c1", name: "write", argumentsDelta: '{"path":"a.txt","content":"' };
    yield { type: "finish", finish: { kind: "max-tokens" } };
  })();
}

describe("createDefaultTruncationMessages（WER C3 文案外提）", () => {
  it("替换生效：插件在场 → 配对 result 文案 = 完整行为指令（内核短事实被替换）", async () => {
    const { agent, scripts } = await makeWorld([createDefaultTruncationMessages()]);
    scripts.push(truncatedToolScript());
    agent.followup("hi");
    await agent.whenIdle();
    const paired = agent.session.events().find((e) => e.type === "tool/result");
    expect(paired?.data).toMatchObject({ isError: true, synthetic: true });
    expect(String(paired?.data.content)).toBe(TRUNCATED_TOOL_FULL_MESSAGE);
    expect(String(paired?.data.content)).not.toContain(TRUNCATED_TOOL_MESSAGE);
  });

  it("短事实保底：无插件世界 → 配对 result 文案 = 内核协议短事实（非死代码钉死）", async () => {
    const { agent, scripts } = await makeWorld();
    scripts.push(truncatedToolScript());
    agent.followup("hi");
    await agent.whenIdle();
    const paired = agent.session.events().find((e) => e.type === "tool/result");
    expect(String(paired?.data.content)).toBe(TRUNCATED_TOOL_MESSAGE);
  });

  it("content-note 并存优先级：同答一对象 content 生效、note 丢弃（替换优先于追加）", async () => {
    const both: Parameters<typeof loadPlugins>[1][number] = {
      name: "both-shapes",
      apply: (ctx) => ctx.on(agentTruncatedTool, async (payload, next) => {
        const downstream = await next(payload);
        if (downstream !== undefined) return downstream;
        return { content: TRUNCATED_TOOL_FULL_MESSAGE, note: "note must be dropped" } as never;
      }),
    };
    const { agent, scripts } = await makeWorld([both]);
    scripts.push(truncatedToolScript());
    agent.followup("hi");
    await agent.whenIdle();
    const paired = agent.session.events().find((e) => e.type === "tool/result");
    expect(String(paired?.data.content)).toBe(TRUNCATED_TOOL_FULL_MESSAGE);
    expect(String(paired?.data.content)).not.toContain("note must be dropped");
  });

  it("链序裁决：抢救件先装（外层）、文案件后装（内层）→ content 生效（装配契约：truncation-messages 后于 rescue 件）", async () => {
    const rescue: Parameters<typeof loadPlugins>[1][number] = {
      name: "fake-rescue",
      apply: (ctx) => ctx.on(agentTruncatedTool, async (payload, next) => {
        const downstream = await next(payload);
        return downstream !== undefined ? downstream : { note: "rescue note must lose" };
      }),
    };
    const { agent, scripts } = await makeWorld([rescue, createDefaultTruncationMessages()]);
    scripts.push(truncatedToolScript());
    agent.followup("hi");
    await agent.whenIdle();
    const paired = agent.session.events().find((e) => e.type === "tool/result");
    expect(String(paired?.data.content)).toBe(TRUNCATED_TOOL_FULL_MESSAGE);
    expect(String(paired?.data.content)).not.toContain("rescue note must lose");
  });
});
