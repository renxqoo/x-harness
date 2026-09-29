// live-only 命令路由门（SESSION-WORKTREE-WORKFLOW §1.2）：thread/notify 对非 live 表项态
// host 本地拒 thread_not_live——不入 wake（parked 唤醒会复活 worker 跑一轮 LLM）、
// 不入 retiring requeue（过期通告延迟材料化）。判定序：表项查找后、retiring requeue 前。

import { hubError } from "../shared/errors.ts";
import type { HubErrorShape } from "../shared/errors.ts";

export interface LiveOnlySpec {
  readonly id: string | undefined;
  readonly type: string;
  readonly threadId: string;
  readonly entry: { readonly state: string };
  readonly line: string;
}

export interface LiveOnlyDeps {
  emitFailure(id: string | undefined, type: string, error: HubErrorShape): void;
  deliver(threadId: string, line: string, info: { id?: string; type: string }): boolean;
}

/** live-only 路由：恒消费（返回 true = 已终态应答，调用方不再走常规路由） */
export function routeLiveOnly(spec: LiveOnlySpec, deps: LiveOnlyDeps): boolean {
  const { id, type, threadId, entry, line } = spec;
  if (entry.state !== "live") {
    deps.emitFailure(id, type, hubError("thread_not_live", `thread is ${entry.state}`));
    return true;
  }
  const info: { id?: string; type: string } = { type };
  if (id !== undefined) info.id = id;
  if (deps.deliver(threadId, line, info)) return true;
  deps.emitFailure(id, type, hubError("thread_not_live", "thread is not live"));
  return true;
}
