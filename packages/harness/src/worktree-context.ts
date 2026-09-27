// worktree 子会话提示词覆盖（docs/WORKTREE-CONTEXT-AWARENESS §1.4 Track U）：
// untyped/fork 子走 prompt.assemble（无静态 systemPrompt 短路），经 agentSpawned
// 事件的 worktree 三字段对该会话注册 base/core 会话层同名段——Environment 块换成
// worktree 事实。named 子不走本轨（静态 systemPrompt 短路——事实由 delegation 在
// options 上拼接，Track N）。清理双钩：agentWorktreeGone（stop removed——树删会话
// 驻留）+ sessionDisposed（会话终结——system-prompt 插件 dropLayer 主路径，本插件
// 同步删自有登记防泄漏）。

import type { Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import { agentSpawned, agentWorktreeGone } from "@x-harness/agent-delegation";
import type { AgentSpawnedPayload, AgentWorktreeGonePayload } from "@x-harness/agent-delegation";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";
import { baseCoreText } from "./base-prompt.ts";
import type { BasePromptFacts } from "./base-prompt.ts";

export interface WorktreeContextOptions {
  /** 宿主装配 facts（非 git 部分复用——cwd/platform/shell 变量本就根层注册，此处仅
   *  取 ENV 块的非 git 上下文；worktree 事实来自事件，不重跑探测——D4） */
  readonly facts: BasePromptFacts;
}

/** 子会话 ENV 块（worktree 事实直烘焙——与 base-prompt environmentBlock 同构，
 *  增隔离语义句：主仓在沙箱外，只读参照） */
function worktreeEnvironmentBlock(payload: { readonly worktree: string; readonly branch?: string; readonly worktreeMain?: string }): string {
  const lines = [
    "You have been invoked in the following environment:",
    `- Working directory: ${payload.worktree}`,
    "- Is a git repository: yes",
  ];
  if (payload.branch !== undefined && payload.branch !== "") lines.push(`- Git branch: ${payload.branch}`);
  if (payload.worktreeMain !== undefined && payload.worktreeMain !== "") {
    lines.push(`- Git worktree of: ${payload.worktreeMain}`);
    lines.push(`- The main repository at ${payload.worktreeMain} is outside your sandbox: treat it as a read-only reference`);
  }
  lines.push("- Platform: {{platform}}", "- Shell: {{shell}}");
  return lines.join("\n");
}

/** 覆盖段全文：完整 base/core（守则/上下文管理/输出格式与根层逐字节同源），仅
 *  Environment 块换 worktree 事实——同名会话段顶替根槽位（registry 合并投影）。 */
function worktreeCoreText(options: WorktreeContextOptions, payload: { readonly worktree: string; readonly branch?: string; readonly worktreeMain?: string }): string {
  const covered: BasePromptFacts = {
    ...options.facts,
    gitBranch: payload.branch,
    ...(payload.worktreeMain !== undefined && payload.worktreeMain !== "" ? { gitWorktreeMain: payload.worktreeMain } : {}),
  };
  const text = baseCoreText(covered);
  // baseCoreText 的 ENV 块持根层 {{cwd}} 变量形态——覆盖块需烘焙 worktree 路径：
  // 以 worktreeEnvironmentBlock 替换 environmentBlock 段落（首尾锚唯一）。
  const head = text.indexOf("You have been invoked in the following environment:");
  const tail = text.indexOf("## Context Management");
  if (head === -1 || tail === -1) return text; // 形态漂移防御：保守整文（守则仍在）
  return `${text.slice(0, head)}${worktreeEnvironmentBlock(payload)}\n\n${text.slice(tail)}`;
}

/** Track U 覆盖插件：agentSpawned（worktree+worktree 字段在场门）→ scoped base/core；
 *  agentWorktreeGone → 摘层；sessionDisposed → 登记表清理（层本体由 system-prompt
 *  插件 dropLayer）。双在场门：worktree 与 branch 缺一不注册（branch 缺席 = 树形态
 *  不可判——覆盖无增益且可能误导）。 */
export function createWorktreeContextPlugin(options: WorktreeContextOptions): Plugin {
  return {
    name: "worktree-context",
    inject: ["system-prompt"],
    apply: (ctx): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const layers = new Map<string, () => void>();
      const onSpawned = (payload: AgentSpawnedPayload): void => {
        if (payload.worktree === undefined || payload.worktree === "") return;
        if (payload.branch === undefined || payload.branch === "") return;
        const sessionId = String(payload.sessionId);
        layers.get(sessionId)?.(); // 幂等：复活再发先摘旧层
        const off = prompt.scoped(sessionId).section({
          name: wellKnown.baseCore,
          text: worktreeCoreText(options, { worktree: payload.worktree, branch: payload.branch, ...(payload.worktreeMain !== undefined ? { worktreeMain: payload.worktreeMain } : {}) }),
        });
        layers.set(sessionId, off);
      };
      const drop = (sessionId: string): void => {
        const off = layers.get(sessionId);
        if (off !== undefined) {
          off();
          layers.delete(sessionId);
        }
      };
      const offs = [
        ctx.on(agentSpawned, onSpawned),
        ctx.on(agentWorktreeGone, (payload: AgentWorktreeGonePayload) => drop(String(payload.sessionId))),
        ctx.on(sessionDisposed, ({ session }) => drop(String(session))),
      ];
      return () => {
        for (const off of offs) off();
        for (const entry of layers.entries()) {
          entry[1]();
          layers.delete(entry[0]);
        }
      };
    },
  };
}
