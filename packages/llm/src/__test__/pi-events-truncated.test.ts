// 截断 tool_use 原文出口（docs/TRUNCATED-TOOL-RESCUE.md 层 1 前置·批 1a）：toolcall_delta
// 原文按块缓冲、toolcall_end 暂存、全终态 flush（done/error/throw/break）——缓冲原文
// JSON.parse 失败的块发原文（未经 pi 修补），成功的照旧 stringify；正常流帧形状逐字节不变。

import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { piChunks } from "../pi-events.ts";
import type { LlmChunk } from "../types.ts";

const idleSignal = (): AbortSignal => new AbortController().signal;
const noFailure = (): { status?: number; retryAfterMs?: number } => ({});

function assistantEvent(fields: Record<string, unknown>): AssistantMessageEvent {
  return {
    partial: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 },
    ...fields,
  } as never;
}

function doneEvent(reason: "stop" | "length" | "toolUse" = "stop"): AssistantMessageEvent {
  return assistantEvent({ type: "done", reason, message: { usage: { input: 0, output: 9, cacheRead: 0, cacheWrite: 0 } } }) as never;
}

function errorEvent(rawStopReason?: string): AssistantMessageEvent {
  return assistantEvent({
    type: "error",
    reason: "error",
    error: { errorMessage: rawStopReason === undefined ? "boom" : `Provider finish_reason: ${rawStopReason}`, ...(rawStopReason !== undefined ? { rawStopReason } : {}) },
  }) as never;
}

function toolStart(contentIndex: number, id?: string, name?: string): AssistantMessageEvent {
  const content: unknown[] = [];
  if (id !== undefined) content[contentIndex] = { type: "toolCall", id, name: name ?? "write" };
  return assistantEvent({ type: "toolcall_start", contentIndex, partial: { content } });
}

function toolDelta(contentIndex: number, delta: string): AssistantMessageEvent {
  return assistantEvent({ type: "toolcall_delta", contentIndex, delta });
}

function toolEnd(contentIndex: number, toolCall: { id: string; name: string; arguments: unknown }): AssistantMessageEvent {
  return assistantEvent({ type: "toolcall_end", contentIndex, toolCall: { type: "toolCall", ...toolCall } });
}

async function collect(
  events: readonly AssistantMessageEvent[],
  options?: { signal?: AbortSignal; breakAfter?: number },
): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  const iterable = {
    [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> => {
      let i = 0;
      return { next: async () => (i < events.length ? { done: false, value: events[i++] as AssistantMessageEvent } : { done: true as const, value: undefined }) };
    },
  };
  for await (const chunk of piChunks(iterable, { signal: options?.signal ?? idleSignal(), failureInfo: noFailure })) {
    out.push(chunk);
    if (options?.breakAfter !== undefined && out.length >= options.breakAfter) break; // 消费者提前 break（abort 模拟）
  }
  return out;
}

describe("原文缓冲与暂存（docs/TRUNCATED-TOOL-RESCUE.md 层 1 前置 1）", () => {
  it("多分片按 contentIndex 拼接、多块不串扰；两次 piChunks 调用隔离（generator 局部状态）", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, '{"path":"a.txt"'),
      toolDelta(0, ',"content":"x"}'),
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt", content: "x" } }),
      toolStart(1, "t2", "edit"),
      toolDelta(1, '{"path":"b.txt"}'),
      toolEnd(1, { id: "t2", name: "edit", arguments: { path: "b.txt" } }),
      doneEvent(),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"x"}' },
      { type: "tool-call-delta", index: 1, callId: "t2", name: "edit", argumentsDelta: '{"path":"b.txt"}' },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
    // 隔离：第二次调用（新流新实例）——同 index 不受前次缓冲污染
    const again = await collect([
      toolStart(0, "u1", "write"),
      toolDelta(0, '{"ok":1}'),
      toolEnd(0, { id: "u1", name: "write", arguments: { ok: 1 } }),
      doneEvent(),
    ]);
    expect(again).toEqual([
      { type: "tool-call-delta", index: 0, callId: "u1", name: "write", argumentsDelta: '{"ok":1}' },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("块序：end 即放行保持到达序（合成/兜底路径才按 contentIndex 升序补齐）", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "a"),
      toolDelta(0, '{"a":1}'),
      toolStart(1, "t2", "b"),
      toolDelta(1, '{"b":2}'),
      toolEnd(1, { id: "t2", name: "b", arguments: { b: 2 } }), // end 即发——到达序即帧序
      toolEnd(0, { id: "t1", name: "a", arguments: { a: 1 } }),
      doneEvent(),
    ]);
    expect(chunks.filter((chunk) => chunk.type === "tool-call-delta").map((chunk) => (chunk as { index: number }).index)).toEqual([1, 0]);
  });
});

describe("终态感知出口（层 1 前置 2：done 路径裁决）", () => {
  it("done{length}：半截块发缓冲原文（模式 2a——真半截 JSON 到达下游）；完整块照旧 stringify", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, '{"path":"a.txt","content":"写一半'), // 半截：引号未闭
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt", content: "写一半" } }), // pi 修补品（闭合引号）——不得透传
      doneEvent("length"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"写一半' },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
    // 完整块：原文 parse 成功 → stringify（与旧出口逐字节同形）
    const full = await collect([
      toolStart(0, "t2", "write"),
      toolDelta(0, '{"path":"a.txt","content":"完整"}'),
      toolEnd(0, { id: "t2", name: "write", arguments: { path: "a.txt", content: "完整" } }),
      doneEvent("length"),
    ]);
    expect(full).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t2", name: "write", argumentsDelta: '{"path":"a.txt","content":"完整"}' },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
  });

  it("done{length} 混合 case：完整块不受牵连、半截块发原文（各按各的判据）", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "grep"),
      toolDelta(0, '{"q":"x"}'),
      toolEnd(0, { id: "t1", name: "grep", arguments: { q: "x" } }),
      toolStart(1, "t2", "write"),
      toolDelta(1, '{"path":"out.md","content":"半'),
      toolEnd(1, { id: "t2", name: "write", arguments: { path: "out.md", content: "半" } }),
      doneEvent("length"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "grep", argumentsDelta: '{"q":"x"}' },
      { type: "tool-call-delta", index: 1, callId: "t2", name: "write", argumentsDelta: '{"path":"out.md","content":"半' },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
  });

  it("done{stop/toolUse}：全部照旧 stringify（正常流帧形状逐字节回归——无 delta 的块同样 stringify(end.arguments)）", async () => {
    for (const reason of ["stop", "toolUse"] as const) {
      const chunks = await collect([
        toolStart(0, "t1", "write"),
        toolDelta(0, '{"path":"a"'),
        toolDelta(0, ',"content":"b"}'),
        toolEnd(0, { id: "t1", name: "write", arguments: { path: "a", content: "b" } }),
        doneEvent(reason),
      ]);
      expect(chunks).toEqual([
        { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a","content":"b"}' },
        { type: "usage", usage: { input: 0, output: 9 } },
        { type: "finish", finish: { kind: "stop" } },
      ]);
    }
    // 无任何 delta 分片的 end（anthropic 空参调用）：原文缓冲缺席 → stringify(normalized)
    const noDelta = await collect([toolEnd(0, { id: "t9", name: "list", arguments: {} }), doneEvent()]);
    expect(noDelta).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t9", name: "list", argumentsDelta: "{}" },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("模式 2b：裸控制字符原文照发（修补版会丢键——原文保真）", async () => {
    const raw = '{"path":"a.txt","content":"line1\n\tunclosed'; // \n\t 裸控制字符 + 半截
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, raw),
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt" } }), // pi 修补丢 content 键
      doneEvent("length"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: raw },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
  });
});

describe("全终态 flush 义务（层 1 前置 3——暂存帧不蒸发）", () => {
  it("消费者提前 break（abort 模拟——generator.return 注入）：finally 的 flush 帧经 return() 恢复送达（不蒸发）", async () => {
    const iterable = {
      [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> => {
        const events: readonly AssistantMessageEvent[] = [
          toolStart(0, "t1", "write"),
          toolDelta(0, '{"path":"a.txt","content":"半'),
          toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt", content: "半" } }),
          doneEvent("length"),
        ];
        let i = 0;
        return { next: async () => (i < events.length ? { done: false, value: events[i++] as AssistantMessageEvent } : { done: true as const, value: undefined }) };
      },
    };
    const iterator = piChunks(iterable, { signal: idleSignal(), failureInfo: noFailure })[Symbol.asyncIterator]();
    const out: LlmChunk[] = [];
    out.push((await iterator.next()).value as LlmChunk); // 拉到 end 即发的 tool-call-delta 即 break——帧已在手，abort 窗口零丢失
    expect(out).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"半' },
    ]);
  });

  it("done 事件未拉取即 break：已暂存帧由 finally flush 恢复送达（判定不依赖 done reason）", async () => {
    const events: readonly AssistantMessageEvent[] = [
      toolStart(1, "t1", "write"),
      toolDelta(1, '{"path":"a.txt","content":"半'),
      toolEnd(1, { id: "t1", name: "write", arguments: { path: "a.txt", content: "半" } }),
      assistantEvent({ type: "text_delta", contentIndex: 2, delta: "后文" }), // 暂存之后再产一帧 text
      doneEvent("length"),
    ];
    const iterable = {
      [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> => {
        let i = 0;
        return { next: async () => (i < events.length ? { done: false, value: events[i++] as AssistantMessageEvent } : { done: true as const, value: undefined }) };
      },
    };
    const iterator = piChunks(iterable, { signal: idleSignal(), failureInfo: noFailure })[Symbol.asyncIterator]();
    const out: LlmChunk[] = [];
    out.push((await iterator.next()).value as LlmChunk); // 首帧即 end 放行的 tool-call-delta——终态前已到手
    expect(out).toEqual([
      { type: "tool-call-delta", index: 1, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"半' },
    ]);
  });

  it("error 事件（非救回）：暂存帧先于 error finish 放行", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, '{"path":"a.txt","content":"半'),
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt", content: "半" } }),
      errorEvent(),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"半' },
      { type: "finish", finish: { kind: "error", message: "boom", code: "network" } },
    ]);
  });

  it("流耗尽（防御层）：暂存帧先于兜底 error finish 放行", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, '{"path":"a.txt"'),
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt" } }),
      // 无终态事件——事件流自然耗尽
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt"' },
      { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } },
    ]);
  });

  it("上游 throw：catch flush 后 rethrow（unwinding 路径 finally 的 yield 不可达）", async () => {
    const events: readonly AssistantMessageEvent[] = [
      toolStart(0, "t1", "write"),
      toolDelta(0, '{"path":"a.txt","content":"半'),
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt", content: "半" } }),
    ];
    const iterable = {
      [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> => {
        let i = 0;
        return {
          next: async () => {
            if (i < events.length) return { done: false, value: events[i++] as AssistantMessageEvent };
            throw new Error("wire-boom");
          },
        };
      },
    };
    const out: LlmChunk[] = [];
    await expect(async () => {
      for await (const chunk of piChunks(iterable, { signal: idleSignal(), failureInfo: noFailure })) out.push(chunk);
    }).rejects.toThrow("wire-boom");
    expect(out).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"半' },
    ]);
  });

  it("flush 幂等：done 已放行后正常 return 不再发（finally 二次 flush 空转）", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "grep"),
      toolDelta(0, '{"q":"x"}'),
      toolEnd(0, { id: "t1", name: "grep", arguments: { q: "x" } }),
      doneEvent(),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "grep", argumentsDelta: '{"q":"x"}' },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "stop" } },
    ]); // 恰三帧——无重复 tool-call-delta
  });
});

describe("error 救回分方言（层 1 前置 3——OUTPUT_LIMIT_RAW_REASONS 路径）", () => {
  it("openai 方言：toolcall_end 已在事件流 → 暂存帧按 flush 判据放行（半截发原文）先于 max-tokens 终态", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"), // openai 方言 start 无身份（首块缺 id）——身份由 end 兜底
      toolDelta(0, '{"path":"a.txt","content":"半'),
      toolEnd(0, { id: "t1", name: "write", arguments: { path: "a.txt", content: "半" } }),
      errorEvent("max_tokens"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"半' },
      { type: "finish", finish: { kind: "max-tokens", rawReason: "max_tokens" } },
    ]);
    // 同方言完整块：照旧 stringify
    const full = await collect([
      toolStart(0, "t2", "write"),
      toolDelta(0, '{"path":"a.txt","content":"完整"}'),
      toolEnd(0, { id: "t2", name: "write", arguments: { path: "a.txt", content: "完整" } }),
      errorEvent("max_output_tokens"),
    ]);
    expect(full).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t2", name: "write", argumentsDelta: '{"path":"a.txt","content":"完整"}' },
      { type: "finish", finish: { kind: "max-tokens", rawReason: "max_output_tokens" } },
    ]);
  });

  it("anthropic 方言：截断块无 toolcall_end——从 start 身份 + 原文缓冲合成帧（完整性同判据）", async () => {
    const chunks = await collect([
      toolStart(0, "toolu_1", "write"), // 身份在 content_block_start 已定（partial.content 累积块）
      toolDelta(0, '{"path":"a.txt","content":"写一半'),
      // 无 toolcall_end（content_block_stop 未到即 throw）——直接 error
      errorEvent("max_tokens"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "toolu_1", name: "write", argumentsDelta: '{"path":"a.txt","content":"写一半' },
      { type: "finish", finish: { kind: "max-tokens", rawReason: "max_tokens" } },
    ]);
    // 原文完整（parse 成功）→ 合成帧发 stringify（无 end 修补对象——合成时以原文 parse 产物归一）
    const fullRaw = await collect([
      toolStart(0, "toolu_2", "grep"),
      toolDelta(0, '{"q":"完整"}'),
      errorEvent("max_tokens"),
    ]);
    expect(fullRaw).toEqual([
      { type: "tool-call-delta", index: 0, callId: "toolu_2", name: "grep", argumentsDelta: '{"q":"完整"}' },
      { type: "finish", finish: { kind: "max-tokens", rawReason: "max_tokens" } },
    ]);
  });

  it("anthropic 方言合成负例：无身份（start 缺 id）或零字符原文不合成——不造无主帧", async () => {
    const noIdentity = await collect([
      toolStart(0), // openai 式 start：partial.content 该位无 toolCall 块
      toolDelta(0, '{"path":"a"'),
      errorEvent("max_tokens"),
    ]);
    // 无主原文不造帧 → 零内容 → context-overflow（零内容不救回契约）
    expect(noIdentity).toEqual([{ type: "finish", finish: { kind: "error", message: "Provider finish_reason: max_tokens", code: "context-overflow" } }]);
    const noRaw = await collect([
      toolStart(0, "toolu_3", "write"),
      toolDelta(0, ""), // 零字符原文——不合成（无字节可交付）
      errorEvent("max_tokens"),
    ]);
    // 零内容输出上限词 → context-overflow（零内容不救回契约，docs/OUTPUT-TOKEN-CONTINUATION.md）
    expect(noRaw).toEqual([{ type: "finish", finish: { kind: "error", message: "Provider finish_reason: max_tokens", code: "context-overflow" } }]);
  });

  it("anthropic 方言混合：已 end 块照 flush、in-flight 块合成——块序 contentIndex 升序", async () => {
    const chunks = await collect([
      toolStart(0, "toolu_a", "grep"),
      toolDelta(0, '{"q":"x"}'),
      toolEnd(0, { id: "toolu_a", name: "grep", arguments: { q: "x" } }),
      toolStart(1, "toolu_b", "write"),
      toolDelta(1, '{"path":"b.txt","content":"半'),
      errorEvent("model_context_window_exceeded"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "toolu_a", name: "grep", argumentsDelta: '{"q":"x"}' },
      { type: "tool-call-delta", index: 1, callId: "toolu_b", name: "write", argumentsDelta: '{"path":"b.txt","content":"半' },
      { type: "finish", finish: { kind: "max-tokens", rawReason: "model_context_window_exceeded" } },
    ]);
  });
});

describe("done 路径合成帧次序（违约流防御层——无 end 块不得晚于 finish）", () => {
  it("done{length} 且块无 toolcall_end：合成帧先于 finish（头注「done/error 后停发」不被 finally 补发打破）", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, '{"path":"a.txt","content":"半'),
      doneEvent("length"),
    ]);
    const kinds = chunks.map((c) => c.type);
    const frameAt = kinds.indexOf("tool-call-delta");
    const finishAt = kinds.indexOf("finish");
    expect(frameAt).toBeGreaterThan(-1);
    expect(frameAt).toBeLessThan(finishAt);
    expect(chunks[frameAt]).toMatchObject({ argumentsDelta: '{"path":"a.txt","content":"半' });
  });

  it("零字符截断原样出口：raw 空串发空串（不折 \"{}\"——下游谓词命中截断分支）", async () => {
    const chunks = await collect([
      toolStart(0, "t1", "write"),
      toolDelta(0, ""),
      toolEnd(0, { id: "t1", name: "write", arguments: {} }),
      doneEvent("length"),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: "" },
      { type: "usage", usage: { input: 0, output: 9 } },
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
  });
});
