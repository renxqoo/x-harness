// 系统提示词 section 注册（docs/CLI.md §2.5）：CLI 内置 cli-core section（variable 注入
// 环境事实）+ --append-system-prompt 追加段。--system-prompt 整体替换时不注册本层
// （装配方裁决），AgentOptions.systemPrompt 静态串优先于 assemble 是包契约。

import type { Disposer } from "@x-harness/core";
import type { SystemPromptService } from "@x-harness/system-prompt";

export interface PromptFacts {
  readonly cwd: string;
  readonly platform: string;
  readonly date: string;
}

export function coreSectionText(): string {
  return `You are x-harness, a terminal-based coding agent.

## Environment
- Working directory: {{cwd}}
- Platform: {{platform}}
- Today: {{date}}

## Conduct
- Explore before editing: use read/grep to understand existing code and conventions before writing.
- Keep changes minimal and consistent with the surrounding style.
- bash runs inside a sandbox with a network domain allowlist; a denied domain is a fence, not an obstacle to route around—ask the user instead.
- State outcomes plainly when a task is done; report failures honestly.`;
}

/** 注册 cli-core + 追加段；返回整体注销器（{{var}} 由 variable 提供方插值）。
 * 追加段链式锚定（第 n 段锚第 n-1 段尾部）：同锚多段的插入序语义不保证注册序，链式才稳定 */
export function registerCliPromptSections(prompt: SystemPromptService, facts: PromptFacts, appends: readonly string[]): Disposer {
  const offs = [
    prompt.variable("cwd", facts.cwd),
    prompt.variable("platform", facts.platform),
    prompt.variable("date", facts.date),
    prompt.section({ name: "cli-core", text: coreSectionText() }),
  ];
  let anchor = "cli-core";
  for (let index = 0; index < appends.length; index += 1) {
    const name = `cli-user-${index}`;
    offs.push(prompt.section({ name, after: anchor, text: appends[index] ?? "" }));
    anchor = name;
  }
  return () => {
    for (const off of offs) off();
  };
}
