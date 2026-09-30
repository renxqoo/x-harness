import { tailBytes } from "../shared/truncate.ts";
import { INFLIGHT_TOOL_TAIL_BYTES, INFLIGHT_TOOL_MAX } from "../shared/limits.ts";

export interface InflightRegistration {
  signal: AbortSignal;
  abort(): void;
  readonly done: Promise<void>;
  unregister(): void;
}

export function createInflightRegistry() {
  const entries = new Map<number, { controller: AbortController; done: Promise<void> }>();
  let next = 0;
  return {
    register(): InflightRegistration {
      next += 1;
      const key = next;
      const controller = new AbortController();
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      entries.set(key, { controller, done });
      return {
        signal: controller.signal,
        abort: () => controller.abort(),
        done,
        unregister: () => {
          entries.delete(key);
          resolveDone();
        },
      };
    },
    async abortAll(): Promise<void> {
      for (const entry of entries.values()) entry.controller.abort();
      await Promise.allSettled([...entries.values()].map((entry) => entry.done));
    },
    size: () => entries.size,
  };
}

export type InflightRegistry = ReturnType<typeof createInflightRegistry>;

export interface ToolOutputTail {
  callId: string;
  output: string;
  truncated: boolean;
  startedAt: number;
}

export interface InflightSnapshot {
  turnStartSeq: number | null;
  turnStartedAt: number | null;
  message: unknown;
  toolOutputs: ToolOutputTail[];
}

export function createInflightState() {
  let turnStartSeq: number | null = null;
  let turnStartedAt: number | null = null;
  let message: unknown = null;
  const toolOutputs = new Map<string, ToolOutputTail>();

  return {
    turnStart(seq: number, at: number): void {
      turnStartSeq = seq;
      turnStartedAt = at;
      message = null;
      toolOutputs.clear();
    },
    turnEnd(): void {
      turnStartSeq = null;
      turnStartedAt = null;
      message = null;
      toolOutputs.clear();
    },
    partial(next: unknown): void {
      message = next;
    },
    toolOutput(callId: string, chunk: string): void {
      const existing = toolOutputs.get(callId);
      if (existing === undefined) {
        if (toolOutputs.size >= INFLIGHT_TOOL_MAX) return;
        const tail = tailBytes(chunk, INFLIGHT_TOOL_TAIL_BYTES);
        toolOutputs.set(callId, { callId, output: tail.text, truncated: tail.truncated, startedAt: Date.now() });
        return;
      }
      const appended = existing.output + chunk;
      const tail = tailBytes(appended, INFLIGHT_TOOL_TAIL_BYTES);
      existing.output = tail.text;
      existing.truncated = existing.truncated || tail.truncated;
    },
    toolDone(callId: string): void {
      toolOutputs.delete(callId);
    },
    snapshot(): InflightSnapshot {
      return {
        turnStartSeq,
        turnStartedAt,
        message,
        toolOutputs: [...toolOutputs.values()],
      };
    },
  };
}

export type InflightState = ReturnType<typeof createInflightState>;
