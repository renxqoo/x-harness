// 重放守卫变换器纯函数面 + 插件装配面（docs/LLM-REPLAY-GUARD.md §2）：三态机的全部路径——
// 直通零开销、发散补放行（零丢失）、整文重发吞并、片段重放重同步（尾段放行）、流终确认阈、
// thinking/usage 直通与 HOLD 未决裁决。症状命名：上游断流从头重发致回复正文重复拼接。

import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayGuard, createReplayGuardPlugin, guardStream } from "../index.ts";

const OPTS = { gapMs: 1_000, confirmChars: 8, minEmitted: 4 } as const;
// 流级/插件级用真实毫秒时延——阈值缩到 10ms 使 30ms 间隔可触发
const FAST = { gapMs: 10, confirmChars: 8, minEmitted: 4 } as const;
const text = (t: string): { type: "text-delta"; text: string } => ({ type: "text-delta", text: t });
/** 扣留期保活帧：零宽 text-delta——下游看门狗间隔重置，累积无影响 */
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
    expect(guard.push(text("世界"), 100)).toEqual([text("世界")]); // 间隔 < gapMs
    expect(guard.close()).toEqual([]);
  });

  it("整文重发吞并（症状：kvhh03 式回复精确重复拼接）：停顿后完整重发 → 下游单份", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0); // 已放行 8 字符（≥ minEmitted）
    expect(guard.push(text("abcd"), 2_000)).toEqual(KEEP); // 停顿后重发前半段：扣留比对
    expect(guard.push(text("efgh"), 2_010)).toEqual(KEEP); // 重发后半段（续推帧）：恰等长吞并转 PASS
    const tail = guard.push(text("ijk"), 2_020); // 重发流的新增内容：直通
    expect(tail).toEqual([text("ijk")]);
    expect(guard.close()).toEqual([]);
  });

  it("片段重放重同步（症状：pmv4b1 前缀片段+全文重发）：已放行片段为重发前缀，尾段放行成干净全文", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("frag"), 0); // 断流时只到了 4 字符片段
    expect(guard.push(text("frag123456789"), 2_000)).toEqual([text("123456789")]); // 越过已放行长度的部分放行
    expect(guard.push(text("tail"), 2_050)).toEqual([text("tail")]);
    expect(guard.close()).toEqual([]);
  });

  it("发散补放行（零丢失）：停顿后是合法续写（不匹配已放行头部）→ 扣留部分原样补发", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("zzz"), 2_000)).toEqual([{ type: "text-delta", text: "zzz" }]); // 首字即发散：当场补放行
    expect(guard.push(text("yyy"), 2_010)).toEqual([text("yyy")]); // 回到直通
    expect(guard.close()).toEqual([]);
  });

  it("确认窗内发散：部分匹配后分叉 → 合并补放行全部扣留", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("abc"), 2_000)).toEqual(KEEP); // 前 3 字符匹配：扣留
    expect(guard.push(text("XYZ"), 2_010)).toEqual([{ type: "text-delta", text: "abcXYZ" }]); // 分叉：全量补发（零丢失）
    expect(guard.close()).toEqual([]);
  });

  it("流终未决：达确认阈丢弃（纯重放）；未达保守补放行", () => {
    const a = new ReplayGuard(OPTS);
    a.push(text("abcdefgh"), 0);
    expect(a.push(text("abcdefgh"), 2_000)).toEqual(KEEP); // 全匹配但流结束（matched=8 ≥ confirmChars）
    expect(a.close()).toEqual([]); // 丢弃
    const b = new ReplayGuard(OPTS);
    b.push(text("abcdefgh"), 0);
    expect(b.push(text("abc"), 2_000)).toEqual(KEEP); // 只匹配 3 < confirmChars
    expect(b.close()).toEqual([{ type: "text-delta", text: "abc" }]); // 未确认：保守保真
  });

  it("非 text 帧直通；HOLD 未决时非 text 帧触发达阈裁决/未达补发+透传；usage 双计费照落不纠", () => {
    const guard = new ReplayGuard(OPTS);
    guard.push(text("abcdefgh"), 0);
    expect(guard.push(text("abcdefgh"), 2_000)).toEqual(KEEP); // 全匹配扣留
    const usage: LlmChunk = { type: "usage", usage: { input: 10, output: 20 } };
    expect(guard.push(usage, 2_005)).toEqual([usage]); // 达阈：扣留丢弃，usage 透传（双计费是服务端事实）
    const guard2 = new ReplayGuard(OPTS);
    guard2.push(text("abcdefgh"), 0);
    expect(guard2.push(text("ab"), 2_000)).toEqual(KEEP); // 匹配 2 < 阈
    expect(guard2.push(usage, 2_005)).toEqual([{ type: "text-delta", text: "ab" }, usage]); // 补发 + 透传
  });

  it("close 部分重放达阈丢弃（症状钉子：删确认阈裁决分支曾不红）", () => {
    const guard = new ReplayGuard({ gapMs: 1_000, confirmChars: 8, minEmitted: 4 });
    guard.push(text("0123456789abcdefghijklmnop"), 0); // 已放行 26 字符
    expect(guard.push(text("0123456789ab"), 2_000)).toEqual(KEEP); // 匹配 12 ∈ [阈 8, 已放行 26)：扣留
    expect(guard.close()).toEqual([]); // 达阈纯重放未决 → 丢弃（不补发 12 字符重复文本）
  });

  it("guardStream 流终未决：达阈丢弃 / 未阈补发冲刷", async () => {
    const a = guardStream(script([text("0123456789abcdefghijklmnopqrst"), text("0123456789ab")], [0, 30]), FAST);
    expect(await collect(a)).toBe("0123456789abcdefghijklmnopqrst"); // 匹配 12 ≥ 阈 8：重放尾丢弃
    const b = guardStream(script([text("0123456789abcdefghij"), text("0123")], [0, 30]), FAST);
    expect(await collect(b)).toBe("0123456789abcdefghij0123"); // 匹配 4 < 阈：保守补发（零丢失）
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
    await iterator.return?.(undefined); // 下游弃单（turn cancel 路径）
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
    guard.push(text("ab"), 0); // 2 < minEmitted=4
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
    expect(await collect(stream)).toBe(full); // 第二次全文重发被吞并
  });

  it("流包装：发散续写零丢失", async () => {
    const stream = guardStream(script([text("abcdefgh"), text("new-tail")], [0, 30]), FAST);
    expect(await collect(stream)).toBe("abcdefghnew-tail");
  });

  it("gapMs ≤ 0 整体直通（插件关闭形态）", async () => {
    const chunks = [text("aa"), text("aa")];
    const stream = guardStream(script(chunks, [0, 30]), { ...OPTS, gapMs: 0 });
    expect(await collect(stream)).toBe("aaaa"); // 重发不纠——关闭即透传
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
      expect(received).toBe("abcdefgh"); // 重放被守卫吞并
    } finally {
      await ctx.dispose();
      void unload;
    }
  });
});

afterEach(() => {});
