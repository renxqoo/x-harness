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

/** 单行归一（与 base-prompt inline 同款口径）：事件 payload 字段未过 normalize——
 *  压掉换行，环境值不得伪造新段落标题（注入面收口）。 */
function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** 子会话 ENV 块：全部事实直烘焙（worktree 路径/分支/主仓 + facts 的 platform/shell）。
 *  不用 {{platform}}/{{shell}} 占位——base 插件缺席形态（--system-prompt 整替）下变量
 *  无注册者会残留原文；烘焙对两形态恒正确（红测回归锚）。增隔离语义句：主仓只读参照。 */
function worktreeEnvironmentBlock(facts: BasePromptFacts, payload: { readonly worktree: string; readonly branch?: string; readonly worktreeMain?: string }): string {
  const worktree = inline(payload.worktree);
  const branch = payload.branch !== undefined ? inline(payload.branch) : "";
  const main = payload.worktreeMain !== undefined ? inline(payload.worktreeMain) : "";
  const lines = [
    "You have been invoked in the following environment:",
    `- Working directory: ${worktree}`,
    "- Is a git repository: yes",
  ];
  if (branch !== "") lines.push(`- Git branch: ${branch}`);
  if (main !== "") {
    lines.push(`- Git worktree of: ${main}`);
    lines.push(`- The main repository at ${main} is outside your sandbox: treat it as a read-only reference`);
  }
  lines.push(`- Platform: ${facts.platform}`, `- Shell: ${facts.shell}`);
  return lines.join("\n");
}

/** ENV 首尾锚（baseCoreText 正文切片的定位串——漂移即放弃覆盖） */
const ENV_HEAD = "You have been invoked in the following environment:";
const ENV_TAIL = "## Context Management";

/** 覆盖段全文：完整 base/core（守则/上下文管理/输出格式与根层逐字节同源），仅
 *  Environment 块换 worktree 事实——同名会话段顶替根槽位（registry 合并投影）。
 *  锚缺失（宿主自定义/漂移的 base 正文）→ undefined：放弃覆盖（返回混合体会把
 *  {{cwd}} 占位与 worktree 分支缝成静默错误——红测回归锚），根层原文照常。 */
function worktreeCoreText(options: WorktreeContextOptions, payload: { readonly worktree: string; readonly branch?: string; readonly worktreeMain?: string }): string | undefined {
  const covered: BasePromptFacts = {
    ...options.facts,
    gitBranch: payload.branch,
    ...(payload.worktreeMain !== undefined && payload.worktreeMain !== "" ? { gitWorktreeMain: payload.worktreeMain } : {}),
  };
  const text = baseCoreText(covered);
  // baseCoreText 的 ENV 块持根层 {{cwd}} 变量形态——覆盖块需烘焙 worktree 路径：
  // 以 worktreeEnvironmentBlock 替换 environmentBlock 段落。
  const head = text.indexOf(ENV_HEAD);
  const tail = text.indexOf(ENV_TAIL);
  if (head === -1 || tail === -1) return undefined;
  return `${text.slice(0, head)}${worktreeEnvironmentBlock(options.facts, payload)}\n\n${text.slice(tail)}`;
}

/** Track U 覆盖插件：agentSpawned（worktree 在场门）→ scoped base/core；
 *  agentWorktreeGone → 摘层；sessionDisposed → 登记表清理（层本体由 system-prompt
 *  插件 dropLayer）。branch/worktreeMain 缺席只省略对应行（detached HEAD 的子仍
 *  需知道自己在 worktree——目录行是底线事实）。 */
export function createWorktreeContextPlugin(options: WorktreeContextOptions): Plugin {
  return {
    name: "worktree-context",
    inject: ["system-prompt"],
    apply: (ctx): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const layers = new Map<string, () => void>();
      const onSpawned = (payload: AgentSpawnedPayload): void => {
        if (payload.worktree === undefined || payload.worktree === "") return;
        // 目录行是底线事实（工作区在哪不依赖 git 可读性）；branch 缺席（detached HEAD/
        // .git 不可读）只省略分支行——不放弃整个覆盖层（审查缺口：双在场门会让
        // detached 树的 untyped 子退回主仓 cwd 提示——与执行面矛盾，红测回归锚）
        const text = worktreeCoreText(options, { worktree: payload.worktree, ...(payload.branch !== undefined && payload.branch !== "" ? { branch: payload.branch } : {}), ...(payload.worktreeMain !== undefined ? { worktreeMain: payload.worktreeMain } : {}) });
        if (text === undefined) return; // 锚漂移（自定义 base 正文）——放弃覆盖，根层照常
        const sessionId = String(payload.sessionId);
        layers.get(sessionId)?.(); // 幂等：复活再发先摘旧层
        const off = prompt.scoped(sessionId).section({ name: wellKnown.baseCore, text });
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
