// /compact 命令自声明（BATCH3-DESIGN §2.3）：命令注册面（@x-harness/commands）上的
// kit 自带命令——「compact 存在」这个事实只住在本包，随装配旅行。busy 前置 = agent
// running（kick 窗口 ≡ turn 窗口，对 stdin 驱动的外部观察者无漂移）+ 插件内 running
// 同步 check-and-set（并发双发零窗口）；signal 归属调用方（hub 侧 = inflight 登记）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { commandRegistry } from "@x-harness/commands";
import type { CommandResult } from "@x-harness/commands";
import { compactionRunner } from "./tokens.ts";
import { previousSummaryOf } from "./compact.ts";

/** 手动压缩保留窗（历史常量——CONTEXT-TOKEN-UNIFICATION M-5 收编：手动路径不再
 *  独立覆盖 keepRecentTokens，走 CompactionOptions 缺省（与水位/自愈同源同配置，
 *  含 keepMinTurns 护栏）；常量保留导出为兼容面，值与 DEFAULT_KEEP_RECENT 对齐锁定） */
export const COMPACT_KEEP_RECENT_TOKENS = 20_000;

/** compact skip reason 归一（封闭映射——错误词表单源，hub/CLI 共用） */
export function compactSkipError(reason: string): string {
  if (reason === "no-cut-point" || reason === "summary-input-budget-exhausted" || reason === "summary-empty") {
    return "context too small to compact";
  }
  if (reason === "summarizer-unconfigured") return "compaction summarizer not configured";
  if (reason === "aborted") return "compaction aborted";
  return `compaction failed: ${reason}`;
}

export const commandCompactPlugin = {
  name: "command-compact",
  inject: ["commands", "compaction"],
  apply: (ctx: Context): Disposer => {
    const registry = ctx.use(commandRegistry);
    const runner = ctx.use(compactionRunner);
    // busy 前置的 agent 查询面：惰性 tryUse（装配序无关；无 agent-loop 服务的最小
    // 世界退化为不查——hub 装配恒含 agent-loop，kick 窗口 ≡ turn 窗口无观察漂移）
    let running = false; // 同步 check-and-set——并发双发零窗口

    const off = registry.register({
      name: "compact",
      description: "Compact the conversation history",
      execute: async ({ session, rawInput, signal }): Promise<CommandResult> => {
        const loop = ctx.tryUse(agentLoopServiceToken);
        if (loop?.get(session.id)?.agent.status === "running") {
          return { kind: "error", text: "thread is streaming" };
        }
        if (running) return { kind: "error", text: "Compaction already in progress" };
        running = true;
        try {
          const customInstructions = rawInput.trim() !== "" ? rawInput.trim() : undefined;
          const result = await runner.compact({
            session: session.id,
            trigger: "manual",
            signal,
            ...(customInstructions !== undefined ? { customInstructions } : {}),
          });
          if (!result.ok) return { kind: "error", text: compactSkipError(result.reason) };
          return {
            kind: "success",
            data: {
              summary: previousSummaryOf(session.surface()),
              replacedCount: result.replacedNodes,
              summaryTokens: result.summaryTokens,
            },
          };
        } finally {
          running = false;
        }
      },
    });
    return off;
  },
} satisfies Plugin;
