// AgentOptions 合成（docs/CLI.md §2.1/§2.6）：工具白/黑名单矩阵（--no-tools > --tools
// [+--exclude-tools] > 全部注册工具）+ 模型两层（新建用 defaults；resume 用 overrides）
// + 系统提示词形态（--system-prompt 静态串优先）。纯函数。

import type { AgentOptions } from "@x-harness/agent-loop";
import type { CliArgs } from "./parse-cli-args.ts";
import type { ModelChoice } from "./resolve-model.ts";

/** 工具名单解析：no-tools → []（全禁）；tools 为基、exclude 再减；都缺省 = registered 全集 */
export function resolveToolNames(args: CliArgs, registered: readonly string[]): readonly string[] {
  if (args.noTools) return [];
  const exclude = args.excludeTools ?? [];
  if (args.tools === undefined) {
    return exclude.length === 0 ? registered : registered.filter((name) => !exclude.includes(name));
  }
  return args.tools.filter((name) => !exclude.includes(name));
}

/** 新建会话的 AgentOptions（dial = defaults 层全量；工具面 restriction 由 main 装配注册） */
export function agentOptionsForCreate(args: CliArgs, defaults: ModelChoice): AgentOptions {
  return {
    provider: defaults.provider,
    model: defaults.model,
    ...(defaults.thinking !== undefined ? { thinking: defaults.thinking } : {}),
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
  };
}

/** resume 会话的 AgentOptions（仅显式 flag；未给处 undefined 回落会话末次 dial/header）。
 *  工具面（勘误——W2B）：无 flag = 显式全集（放开），与历史行为等价；原「不静默放开」
 *  注释词不达意——restriction 语义见 main.ts 装配处（带 flag 才注册） */
export function agentOptionsForResume(args: CliArgs, overrides: Partial<ModelChoice>): AgentOptions {
  return {
    ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.thinking !== undefined ? { thinking: overrides.thinking } : {}),
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
  };
}
