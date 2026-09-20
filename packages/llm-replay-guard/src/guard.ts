// 重放守卫变换器（纯函数面，docs/LLM-REPLAY-GUARD.md §1）：上游（服务端/SSE 网关）断流后
// 从头重发整段文本时，消费端三态容错——PASS 直通（正常流零缓冲零延迟）；停顿（相邻
// text-delta 间隔 > gapMs）后进入 HOLD 扣留比对：新序列与已放行文本逐位比对，发散即补放行
// （合法续写，零丢失）、越过已放行长度即重同步（只放行新增尾段，下游/UI 拿到干净单份）、
// 流终未决按确认阈裁决（达阈=纯重放丢弃；未达=保守补放行）。扣留期向下游放零宽保活帧
//（活跃重放不得被下游看门狗误杀）。thinking/usage/toolcall 直通；只纠正 text
//（usage 双计费是服务端事实，照落）。

import type { LlmChunk } from "@x-harness/llm";

export interface ReplayGuardOptions {
  /** 触发阈值：相邻 text-delta 间隔超过此毫秒进入比对；≤0 = 整体直通（插件关闭） */
  readonly gapMs: number;
  /** 流终未决时的丢弃确认阈：已逐位匹配字符数达此值才判纯重放并丢弃，否则保守补放行 */
  readonly confirmChars: number;
  /** 已放行文本短于此值不进入比对（短文本重放无价值，直通） */
  readonly minEmitted: number;
}

export const DEFAULT_REPLAY_GUARD: ReplayGuardOptions = { gapMs: 10_000, confirmChars: 32, minEmitted: 16 };

type TextDelta = Extract<LlmChunk, { type: "text-delta" }>;

/** 零宽保活帧：扣留期向下游报「上游活着」——累积器拼接无影响，看门狗间隔计时重置 */
const KEEPALIVE: readonly LlmChunk[] = [{ type: "text-delta", text: "" }];

export class ReplayGuard {
  private readonly options: ReplayGuardOptions;
  private mode: "pass" | "hold" = "pass";
  private emitted = ""; // 已放行 text 拼接（下游视角的正文）
  private held = ""; // HOLD 期扣留的新序列
  private matched = 0; // held 前缀与 emitted 头部已逐位确认的长度
  private lastTextAt = 0;

  constructor(options: ReplayGuardOptions = DEFAULT_REPLAY_GUARD) {
    this.options = options;
  }

  /** 推入一帧：返回应放行的帧序列（0=吞、1=直通/合并补发、2=补发+透传非 text 帧） */
  push(chunk: LlmChunk, now: number): readonly LlmChunk[] {
    if (chunk.type !== "text-delta") {
      if (this.mode !== "hold") return [chunk];
      // 比对未决遇非 text 帧：达确认阈=纯重放（吞掉扣留）；未达=保守补放行后透传本帧
      if (this.matched >= this.options.confirmChars) {
        this.toPass();
        return [chunk];
      }
      const flush = this.held;
      this.toPass();
      this.emitted += flush;
      return flush === "" ? [chunk] : [{ type: "text-delta", text: flush }, chunk];
    }
    return this.pushText(chunk, now);
  }

  /** 流终（迭代器 done）裁决：HOLD 未决时按确认阈丢弃或补放行 */
  close(): readonly LlmChunk[] {
    if (this.mode !== "hold") return [];
    if (this.matched >= this.options.confirmChars) {
      this.toPass();
      return []; // 纯重放：扣留部分与已放行重复，丢弃
    }
    const flush = this.held;
    this.toPass();
    this.emitted += flush;
    return flush === "" ? [] : [{ type: "text-delta", text: flush }];
  }

  private pushText(chunk: TextDelta, now: number): readonly LlmChunk[] {
    if (chunk.text === "") return [chunk];
    if (this.mode === "pass") {
      const gap = now - this.lastTextAt;
      this.lastTextAt = now;
      if (gap > this.options.gapMs && this.emitted.length >= this.options.minEmitted) {
        // 停顿后首帧：进入比对（HOLD 共路径裁决——首帧即发散当场补放行，零延迟损失）
        this.mode = "hold";
        this.held = chunk.text;
        this.matched = 0;
      } else {
        this.emitted += chunk.text;
        return [chunk];
      }
    } else {
      this.lastTextAt = now;
      this.held += chunk.text;
    }
    // HOLD 共路径（进入帧与续推帧同裁决）：发散→补放行；比对覆盖到已放行末尾→尾段放行/吞并转 PASS
    if (this.advanceMatch()) return this.flushHeld();
    if (this.matched >= this.emitted.length) {
      // 重放前段吞掉，超出部分为新增尾段（下游 = 旧前缀 + 尾段 = 干净全文）；恰好等长
      //（尾段空）则本帧全为重放——吞并后转 PASS，后续帧是新增直通
      const tail = this.held.slice(this.emitted.length);
      this.emitted += tail;
      this.toPass();
      return tail === "" ? KEEPALIVE : [{ type: "text-delta", text: tail }];
    }
    // 比对窗内继续扣留——放零宽 text-delta 保活：下游看门狗测的是本守卫的输出侧间隔，
    // 上游活着（本帧到达）就不能装死，否则活跃重放超时会被看门狗误杀重拨
    return KEEPALIVE;
  }

  /** 增量逐位比对 held 与 emitted 头部（只比到 emitted 长度——越出部分是新增内容，
   *  由长度判定放行，不作发散论处）；发散返回 true */
  private advanceMatch(): boolean {
    const comparable = Math.min(this.held.length, this.emitted.length);
    for (let index = this.matched; index < comparable; index += 1) {
      if (this.emitted[index] !== this.held[index]) return true;
    }
    this.matched = comparable;
    return false;
  }

  private flushHeld(): readonly LlmChunk[] {
    const flush = this.held;
    this.emitted += flush;
    this.toPass();
    return [{ type: "text-delta", text: flush }];
  }

  private toPass(): void {
    this.mode = "pass";
    this.held = "";
    this.matched = 0;
  }
}

/** 流包装：挂 llm/stream waterfall 的最终形态（gapMs ≤0 直通原流） */
export function guardStream(stream: AsyncIterable<LlmChunk>, options: ReplayGuardOptions): AsyncIterable<LlmChunk> {
  if (options.gapMs <= 0) return stream;
  const guard = new ReplayGuard(options);
  const upstream = stream[Symbol.asyncIterator]();
  let pending: readonly LlmChunk[] = [];
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<LlmChunk>> {
        for (;;) {
          if (pending.length > 0) {
            const chunk = pending[0];
            pending = pending.slice(1);
            if (chunk !== undefined) return { done: false, value: chunk };
            continue;
          }
          const result = await upstream.next();
          if (result.done === true) {
            pending = guard.close();
            if (pending.length === 0) return { done: true, value: undefined };
            continue; // 先冲刷 close 的补发帧，下次调用返回 done
          }
          pending = guard.push(result.value, Date.now());
        }
      },
      return: async (value: unknown) => {
        void guard.close(); // 提前退出：未决扣留按确认阈裁决后丢弃（下游已弃单，补发无意义）
        return upstream.return?.(value as never) ?? { done: true, value: undefined };
      },
    }),
  };
}
