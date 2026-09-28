// 轮次收敛 e2e 旅程（TURN-REDUCTION.md §2.3 e2e）：
// 旅程 A：单响应双 tool_use（不同 index）→ 两工具都派发、结果配对、meter 计量
//         toolUseCalls=2 / parallelSteps=1（lever B 全链验证：协议→调度→计量）。
// 旅程 B：真 read 工具 paths 批量 → 两文件块 + permission 放行（lever A 执行面）。

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Disposer } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { agentLoopPlugin } from "@x-harness/agent-loop";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { tokenMeterPlugin } from "@x-harness/token-meter";
import { tokenMeter } from "@x-harness/token-meter";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { scriptedAdapter, textScript } from "@x-harness/testkit";
import { Type } from "@sinclair/typebox";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createReadPlugin } from "@x-harness/tool-read";
import { createPermissionPlugin } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import { must } from "./check.ts";

/** 双 tool_use 单响应剧本（不同 index 聚积为两块——stream.ts 按 index 分桶） */
function parallelToolsScript(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId: "c1", name: "note", argumentsDelta: "{}" };
    yield { type: "tool-call-delta", index: 1, callId: "c2", name: "note", argumentsDelta: "{}" };
    yield { type: "finish", finish: { kind: "max-tokens" } }; // 工具轮收束形态（对齐 continuation.test 范例——finish 联合无 tool_use）
  })();
}

export async function turnReductionJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-turn-"));
  try {
    // 旅程 A：单响应双 tool_use → 派发 + 计量
    {
      const ctx = createContext();
      const scripts: Array<AsyncGenerator<LlmChunk>> = [];
      let notes = 0;
      const unload = await loadPlugins(ctx, [
        sessionPlugin,
        toolsPlugin,
        llmPlugin,
        systemPromptPlugin,
        agentLoopPlugin,
        tokenMeterPlugin,
      ]);
      ctx.use(llmRuntime).registerAdapter(scriptedAdapter({ scripts }));
      ctx.use(toolRegistry).register({
        name: "note",
        inputSchema: Type.Object({}),
        execute: async () => {
          notes += 1;
          return { content: `noted-${String(notes)}` };
        },
      });
      scripts.push(parallelToolsScript());
      scripts.push(textScript("done"));
      try {
      const made = await ctx.use(agentLoopServiceToken).create({ agent: { model: "fake-model", provider: "fake" } });
      must(made.ok, "旅程A：agent 创建");
      if (made.ok) {
        const agent = made.value.agent;
        agent.followup("two notes at once");
        await agent.whenIdle();
        must(notes === 2, `旅程A：两工具都派发（实际 ${String(notes)}）`);
        const types = agent.session.events().map((e) => e.type);
        must(types.filter((t) => t === "tool/result").length === 2, "旅程A：两结果配对");
        const usage = ctx.use(tokenMeter).usageOf(agent.session.id);
        must(usage !== undefined, "旅程A：meter 在场");
        must(usage?.toolUseCalls === 2, `旅程A：toolUseCalls=2（实际 ${String(usage?.toolUseCalls)}）`);
        must(usage?.parallelSteps === 1, `旅程A：parallelSteps=1（实际 ${String(usage?.parallelSteps)}）`);
        must(usage?.toolUseSteps === 1, `旅程A：toolUseSteps=1（单响应两块）`);
        await made.value.dispose();
      }
      } finally {
        // must 断言失败也回卷（对照 delegation-journey 审查 B#1 纪律）
        for (const d of unload as Disposer[]) await d();
        await ctx.dispose();
      }
      console.log("旅程A：单响应双 tool_use → 派发+配对+meter 计量 通过");
    }

    // 旅程 B：真 read 工具 paths 批量
    {
      const ctx = createContext();
      const scripts: Array<AsyncGenerator<LlmChunk>> = [];
      const readRoot = join(root, "b");
      await mkdir(readRoot, { recursive: true });
      await writeFile(join(readRoot, "one.ts"), "const one = 1;\n", "utf8");
      await writeFile(join(readRoot, "two.ts"), "const two = 2;\n", "utf8");
      const gate = new PathGate(readRoot);
      const observed = new ObservedRegistry();
      const unload = await loadPlugins(ctx, [
        sessionPlugin,
        toolsPlugin,
        llmPlugin,
        systemPromptPlugin,
        agentLoopPlugin,
        tokenMeterPlugin,
        // permission 真装配（fenceKit 同款序）：modes 在前（V4 模式注册表），插件在后
        // ——批量聚合裁决链全走（auto 档界内 allow；deny/ask 面由 B2 单测背书）
        createPermissionModesPlugin(),
        createPermissionPlugin({ root: readRoot }),
        createReadPlugin({ gate, observed, env: createLocalEnv(readRoot) }),
      ]);
      ctx.use(llmRuntime).registerAdapter(scriptedAdapter({ scripts, exhausted: "(no script)" }));
      scripts.push(
        (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "tool-call-delta", index: 0, callId: "r1", name: "read", argumentsDelta: JSON.stringify({ paths: ["one.ts", "two.ts"] }) };
          yield { type: "finish", finish: { kind: "max-tokens" } }; // 工具轮收束形态（对齐 continuation.test 范例——finish 联合无 tool_use）
        })(),
      );
      scripts.push(textScript("batch read done"));
      try {
        const made = await ctx.use(agentLoopServiceToken).create({ agent: { model: "fake-model", provider: "fake" } });
        must(made.ok, "旅程B：agent 创建");
        if (made.ok) {
          const agent = made.value.agent;
          agent.followup("read both");
          await agent.whenIdle();
          const result = agent.session.events().find((e) => e.type === "tool/result");
          const content = String((result?.data as { content?: unknown } | undefined)?.content ?? "");
          must(content.includes('<file path="one.ts">'), "旅程B：one.ts 块在场");
          must(content.includes("const one = 1;"), "旅程B：one.ts 内容");
          must(content.includes('<file path="two.ts">'), "旅程B：two.ts 块在场");
          must(content.includes("const two = 2;"), "旅程B：two.ts 内容");
          const usage = ctx.use(tokenMeter).usageOf(agent.session.id);
          must(usage?.toolUseCalls === 1, "旅程B：一次 read 批量 = 单 tool_use 计量");
          must(usage?.parallelSteps === 0, "旅程B：单块非并行步");
          await made.value.dispose();
        }
      } finally {
        for (const d of unload as Disposer[]) await d();
        await ctx.dispose();
      }
      console.log("旅程B：read paths 批量执行 → 双文件块+permission 聚合裁决放行 通过");
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
