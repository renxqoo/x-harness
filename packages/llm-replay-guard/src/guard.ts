import type { LlmChunk } from "@x-harness/llm";

export interface ReplayGuardOptions {
  readonly gapMs: number;
  readonly confirmChars: number;
  readonly minEmitted: number;
}

export const DEFAULT_REPLAY_GUARD: ReplayGuardOptions = { gapMs: 10_000, confirmChars: 32, minEmitted: 16 };

type TextDelta = Extract<LlmChunk, { type: "text-delta" }>;

const KEEPALIVE: readonly LlmChunk[] = [{ type: "text-delta", text: "" }];

export class ReplayGuard {
  private readonly options: ReplayGuardOptions;
  private mode: "pass" | "hold" = "pass";
  private emitted = "";
  private held = "";
  private matched = 0;
  private lastTextAt = 0;

  constructor(options: ReplayGuardOptions = DEFAULT_REPLAY_GUARD) {
    this.options = options;
  }

  push(chunk: LlmChunk, now: number): readonly LlmChunk[] {
    if (chunk.type !== "text-delta") {
      if (this.mode !== "hold") return [chunk];
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

  close(): readonly LlmChunk[] {
    if (this.mode !== "hold") return [];
    if (this.matched >= this.options.confirmChars) {
      this.toPass();
      return [];
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
    if (this.advanceMatch()) return this.flushHeld();
    if (this.matched >= this.emitted.length) {
      const tail = this.held.slice(this.emitted.length);
      this.emitted += tail;
      this.toPass();
      return tail === "" ? KEEPALIVE : [{ type: "text-delta", text: tail }];
    }
    return KEEPALIVE;
  }

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
            continue;
          }
          pending = guard.push(result.value, Date.now());
        }
      },
      return: async (value: unknown) => {
        void guard.close();
        return upstream.return?.(value as never) ?? { done: true, value: undefined };
      },
    }),
  };
}
