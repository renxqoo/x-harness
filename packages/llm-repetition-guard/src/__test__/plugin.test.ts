// 流包装与插件装配面（docs/LLM-REPETITION-GUARD.md §1）：pass-through 零扣留（正常流
// 帧序不变）、命中截流尾随 error finish、text/thinking 通道分域互不串扰、toolcall/usage
// 直通、插件挂 llm/stream waterfall 全链。症状命名：模型行内复读致文案前缀重复。

import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { describe, expect, it } from "vitest";
import { createRepetitionGuardPlugin, repetitionGuardStream } from "../index.ts";

const text = (t: string): { type: "text-delta"; text: string } => ({ type: "text-delta", text: t });
const think = (t: string): { type: "thinking-delta"; text: string } => ({ type: "thinking-delta", text: t });
const finishStop = { type: "finish", finish: { kind: "stop" } } as const;

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function script(chunks: readonly LlmChunk[]): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    for (const chunk of chunks) yield chunk;
  })();
}

describe("repetitionGuardStream 流包装", () => {
  it("正常流帧序逐帧不变（pass-through 零扣留——UI 打字机与看门狗无感）", async () => {
    const chunks = [text("正常输出"), think("思考"), { type: "usage", usage: { input: 10, output: 5 } }, finishStop] as const;
    const out = await collect(repetitionGuardStream(script(chunks)));
    expect(out).toEqual([...chunks]);
  });

  it("症状：text 通道复读截流——重复帧后收 error finish{code:repetition}，后续帧不再放行", async () => {
    const out = await collect(
      repetitionGuardStream(script([text("开场白。"), text("cleaner".repeat(6)), text("这段永远不该出现")])),
    );
    const last = out[out.length - 1];
    expect(last?.type).toBe("finish");
    if (last?.type === "finish" && last.finish.kind === "error") {
      expect(last.finish.code).toBe("repetition");
      expect(last.finish.message).toContain("cleaner");
    } else {
      expect.unreachable("复读截流必须以 error finish 收尾");
    }
    expect(out.some((chunk) => chunk.type === "text-delta" && chunk.text.includes("这段永远不该出现"))).toBe(false);
  });

  it("thinking 通道独立分域：thinking 干净 text 复读只杀 text（通道边界不串扰）", async () => {
    const out = await collect(
      repetitionGuardStream(script([think("Docs updated."), text("Docs".repeat(40)), finishStop])),
    );
    expect(out[0]).toEqual(think("Docs updated.")); // 干净 thinking 已放行
    expect(out[out.length - 1]?.type).toBe("finish");
  });

  it("toolcall 与 usage 帧直通：检测器只作用于 text/thinking", async () => {
    const toolChunk = { type: "tool-call-delta", index: 0, callId: "c1", name: "bash", argumentsDelta: "{\"command\":\"ls\"}" } as const;
    const out = await collect(repetitionGuardStream(script([toolChunk, { type: "usage", usage: { input: 1, output: 1 } }, finishStop])));
    expect(out).toEqual([toolChunk, { type: "usage", usage: { input: 1, output: 1 } }, finishStop]);
  });

  it("hit 饱和不重复报：一次流内恰一个 error finish", async () => {
    const out = await collect(repetitionGuardStream(script([text("cleaner".repeat(20))])));
    expect(out.filter((chunk) => chunk.type === "finish")).toHaveLength(1);
  });

  it("消费者提前 break（return 路径）：关死上游不再拉帧，无泄漏无漏帧", async () => {
    let pulled = 0;
    const upstream = (async function* (): AsyncGenerator<LlmChunk> {
      for (const chunk of [text("a"), text("b"), text("c")]) {
        pulled += 1;
        yield chunk;
      }
    })();
    const wrapped = repetitionGuardStream(upstream)[Symbol.asyncIterator]();
    expect((await wrapped.next()).value).toEqual(text("a"));
    await wrapped.return?.(undefined as never); // 提前退出：seal 后上游不再被拉取
    const after = await wrapped.next(); // sealed：恒 done
    expect(after.done).toBe(true);
    expect(pulled).toBe(1); // 上游只被拉到首个帧（b/c 未被消费）
  });
});

describe("插件装配（llm/stream waterfall）", () => {
  it("症状：全链路——复读流经插件后以 error{code:repetition} 终态，llm-retry 词表可接管", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [
      llmPlugin,
      createRepetitionGuardPlugin(),
      {
        name: "test-adapter",
        inject: ["llm"],
        apply: (c) => c.use(llmRuntime).registerAdapter({
          name: "fake",
          stream: () => script([text("cleaner".repeat(8)), finishStop]),
        }),
      },
    ]);
    const out: LlmChunk[] = [];
    for await (const chunk of ctx.use(llmRuntime).stream({ model: "m", tools: [], messages: [], signal: new AbortController().signal })) {
      out.push(chunk);
    }
    const last = out[out.length - 1];
    expect(last?.type).toBe("finish");
    if (last?.type === "finish" && last.finish.kind === "error") expect(last.finish.code).toBe("repetition");
    else expect.unreachable("插件全链必须以 error{code:repetition} 收尾");
  });

  it("disabled 直通：关闭后原流帧序不变", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [
      llmPlugin,
      createRepetitionGuardPlugin({ disabled: true }),
      {
        name: "test-adapter",
        inject: ["llm"],
        apply: (c) => c.use(llmRuntime).registerAdapter({
          name: "fake",
          stream: () => script([text("cleaner".repeat(8)), finishStop]),
        }),
      },
    ]);
    const out: LlmChunk[] = [];
    for await (const chunk of ctx.use(llmRuntime).stream({ model: "m", tools: [], messages: [], signal: new AbortController().signal })) {
      out.push(chunk);
    }
    expect(out).toEqual([text("cleaner".repeat(8)), finishStop]);
  });
});
