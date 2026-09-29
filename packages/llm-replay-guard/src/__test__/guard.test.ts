import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayGuard, createReplayGuardPlugin, guardStream } from "../index.ts";

const OPTS = { gapMs: 1_000, confirmChars: 8, minEmitted: 4 } as const;
const FAST = { gapMs: 10, confirmChars: 8, minEmitted: 4 } as const;
const text = (t: string): { type: "text-delta"; text: string } => ({ type: "text-delta", text: t });
const KEEP = [text("")] as const;

async function collect(stream: AsyncIterable<LlmChunk>): Promise<string> {
  let out = "";
  for await (const chunk of stream) if (chunk.type === "text-delta") out += chunk.text;
  return out;
}

function script(chunks: readonly LlmChunk[], delays: readonly number[]): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) break;
      const delay = delays[index] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
      yield chunk;
    }
  })();
}

describe("ReplayGuard 三态机（纯函数面）", () => {
  it("正常流直通：无间隔不进入比对，帧原样放行", () => {
    const guard = new ReplayGuard(OPTS);
    expect(guard.push(text("你好"), 0)).toEqual([text("你好")]);
    expect(guard.push(text("世界"), 100)).toEqual([text("世界")]);
    expect(guard.close()).toEqual([]);
  });

  it("整文重发吞并（症状：kvhh03 式回复精确重复拼接）：停顿后完整重发 → 下游单份", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("abcd"), 2_000)).toEqual(KEEP);
    expect(guard.push(text("efgh"), 2_010)).toEqual(KEEP);
    const tail = guard.push(text("ijk"), 2_020);
    expect(tail).toEqual([text("ijk")]);
    expect(guard.close()).toEqual([]);
  });

  it("片段重放重同步（症状：pmv4b1 前缀片段+全文重发）：已放行片段为重发前缀，尾段放行成干净全文", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("frag"), 0);
    expect(guard.push(text("frag123456789"), 2_000)).toEqual([text("123456789")]);
    expect(guard.push(text("tail"), 2_050)).toEqual([text("tail")]);
    expect(guard.close()).toEqual([]);
  });

  it("发散补放行（零丢失）：停顿后是合法续写（不匹配已放行头部）→ 扣留部分原样补发", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("zzz"), 2_000)).toEqual([{ type: "text-delta", text: "zzz" }]);
    expect(guard.push(text("yyy"), 2_010)).toEqual([text("yyy")]);
    expect(guard.close()).toEqual([]);
  });

  it("确认窗内发散：部分匹配后分叉 → 合并补放行全部扣留", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("abc"), 2_000)).toEqual(KEEP);
    expect(guard.push(text("XYZ"), 2_010)).toEqual([{ type: "text-delta", text: "abcXYZ" }]);
    expect(guard.close()).toEqual([]);
  });

  it("流终未决：达确认阈丢弃（纯重放）；未达保守补放行", () => {
    const a = new ReplayGuard(OPTS);
    a.push(text("abcdefgh"), 0);
    expect(a.push(text("abcdefgh"), 2_000)).toEqual(KEEP);
    expect(a.close()).toEqual([]);
    const b = new ReplayGuard(OPTS);
    b.push(text("abcdefgh"), 0);
    expect(b.push(text("abc"), 2_000)).toEqual(KEEP);
    expect(b.close()).toEqual([{ type: "text-delta", text: "abc" }]);
  });

  it("非 text 帧直通；HOLD 未决时非 text 帧触发达阈裁决/未达补发+透传；usage 双计费照落不纠", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("abcdefgh"), 2_000)).toEqual(KEEP);
    const usage: LlmChunk = { type: "usage", usage: { input: 10, output: 20 } };
    expect(guard.push(usage, 2_005)).toEqual([usage]);
    const guard2 = new ReplayGuard(OPTS);
    guard2.push(text("abcdefgh"), 0);
    expect(guard2.push(text("ab"), 2_000)).toEqual(KEEP);
    expect(guard2.push(usage, 2_005)).toEqual([{ type: "text-delta", text: "ab" }, usage]);
  });

  it("close 部分重放达阈丢弃（症状钉子：删确认阈裁决分支曾不红）", () => {
    const guard = new ReplayGuard({ gapMs: 1_000, confirmChars: 8, minEmitted: 4 });
    guard.push(text("0123456789abcdefghijklmnop"), 0);
    expect(guard.push(text("0123456789ab"), 2_000)).toEqual(KEEP);
    expect(guard.close()).toEqual([]);
  });

  it("guardStream 流终未决：达阈丢弃 / 未阈补发冲刷", async () => {
    const a = guardStream(script([text("0123456789abcdefghijklmnopqrst"), text("0123456789ab")], [0, 30]), FAST);
    expect(await collect(a)).toBe("0123456789abcdefghijklmnopqrst");
    const b = guardStream(script([text("0123456789abcdefghij"), text("0123")], [0, 30]), FAST);
    expect(await collect(b)).toBe("0123456789abcdefghij0123");
  });

  it("guardStream 提前 return：下游弃单后上游收殓透传", async () => {
    let upstreamReturned = false;
    const upstream = (async function* (): AsyncGenerator<LlmChunk> {
      try {
        yield text("0123456789abcdefghij");
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
        yield text("0123456789ab");
      } finally {
        upstreamReturned = true;
      }
    })();
    const stream = guardStream(upstream, FAST);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return?.(undefined);
    expect(upstreamReturned).toBe(true);
  });

  it("扣留期保活：HOLD 中每次上游帧产出零宽 text-delta（下游看门狗不计时超时——不装死）", () => {
    const guard = new ReplayGuard({ gapMs: 1_000, confirmChars: 8, minEmitted: 4 });
    guard.push(text("0123456789abcdefghij"), 0);
    expect(guard.push(text("0123"), 2_000)).toEqual(KEEP);
    expect(guard.push(text("4567"), 2_010)).toEqual(KEEP);
  });

  it("短已放行文本（< minEmitted）停顿后直通不比对", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("ab"), 0);
    expect(guard.push(text("cd"), 2_000)).toEqual([text("cd")]);
  });
});

describe("guardStream 流包装 + 插件装配", () => {
  it("流包装：真实时延下整文重发 → 下游收到干净单份（症状：回复正文重复拼接）", async () => {
    const full = "abcdefgh123456";
    const stream = guardStream(
      script([text(full.slice(0, 5)), text(full.slice(5)), text(full)], [0, 0, 30]),
      FAST,
    );
    expect(await collect(stream)).toBe(full);
  });

  it("流包装：发散续写零丢失", async () => {
    const stream = guardStream(script([text("abcdefgh"), text("new-tail")], [0, 30]), FAST);
    expect(await collect(stream)).toBe("abcdefghnew-tail");
  });

  it("gapMs ≤ 0 整体直通（插件关闭形态）", async () => {
    const chunks = [text("aa"), text("aa")];
    const stream = guardStream(script(chunks, [0, 30]), { ...OPTS, gapMs: 0 });
    expect(await collect(stream)).toBe("aaaa");
  });

  it("插件装配：挂 llm/stream waterfall，适配器重放流经插件后干净", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [llmPlugin, createReplayGuardPlugin({ ...FAST })]);
    try {
      const off = ctx.use(llmRuntime).registerAdapter({
        name: "replayer",
        stream: () => script([text("abcdefgh"), text("abcdefgh")], [0, 30]),
      });
      ctx.effect(off);
      const runtime = ctx.use(llmRuntime);
      let received = "";
      for await (const chunk of runtime.stream({ model: "m", provider: "replayer", tools: [], messages: [], signal: new AbortController().signal })) {
        if (chunk.type === "text-delta") received += chunk.text;
      }
      expect(received).toBe("abcdefgh");
    } finally {
      await ctx.dispose();
      void unload;
    }
  });
});

afterEach(() => {});
