// 在途面（DESIGN §3.3）：未落盘事实的登记与读口。长操作登记（abortAll 先全部
// abort 再等 settle——恰一响应）；toolOutputs 尾部 64KiB/调用、至多 8 条、truncated
// 粘滞；bash 面按命令 id 隔离（读口取最新仍在跑者）；turnStartSeq 权威轮游标。
import { tailBytes } from "../shared/truncate.ts";
import { INFLIGHT_TOOL_TAIL_BYTES, INFLIGHT_TOOL_MAX } from "../shared/limits.ts";

export interface InflightRegistration {
  /** per-call 取消信号（compact 联动 abort / 长操作共用面） */
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

/** 在途状态：worker 从事件流与执行器喂入；快照只读 */
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
      toolOutputs.clear(); // 轮边界：上一轮未清的尾部作废（轮面归零）
    },
    turnEnd(): void {
      turnStartSeq = null;
      turnStartedAt = null;
      message = null;
      toolOutputs.clear();
      // bash 面不清：模型轮与直执行并发
    },
    partial(next: unknown): void {
      message = next;
    },
    toolOutput(callId: string, chunk: string): void {
      const existing = toolOutputs.get(callId);
      if (existing === undefined) {
        if (toolOutputs.size >= INFLIGHT_TOOL_MAX) return; // 满表不挤（读口有界）
        // 首块即过 64KiB 同样封顶（单块工具输出不撑爆快照面）
        const tail = tailBytes(chunk, INFLIGHT_TOOL_TAIL_BYTES);
        toolOutputs.set(callId, { callId, output: tail.text, truncated: tail.truncated, startedAt: Date.now() });
        return;
      }
      const appended = existing.output + chunk;
      const tail = tailBytes(appended, INFLIGHT_TOOL_TAIL_BYTES);
      existing.output = tail.text;
      existing.truncated = existing.truncated || tail.truncated; // 粘滞：丢过头即恒 true
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
