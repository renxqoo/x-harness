// 追加段注册（--append-system-prompt）：基础段与 facts 探测归 @x-harness/harness
// （base-prompt.ts / base-prompt-probe.ts——两宿主同源）；追加段无边落尾（位于全部
// 内置段之后），链式锚定保序。--system-prompt 整体替换时不注册本层（装配方裁决），
// AgentOptions.systemPrompt 静态串优先于 assemble 是包契约。

import type { Disposer } from "@x-harness/core";
import type { SystemPromptService } from "@x-harness/system-prompt";

/** 注册追加段链（首段无边 → 落尾即全部内置段之后；后续链式锚定保序）；返回整体注销器 */
export function registerAppendSections(prompt: SystemPromptService, appends: readonly string[]): Disposer {
  const offs: Disposer[] = [];
  let anchor: string | undefined;
  for (let index = 0; index < appends.length; index += 1) {
    const name = `cli-user-${index}`;
    offs.push(prompt.section({ name, ...(anchor !== undefined ? { after: anchor } : {}), text: appends[index] ?? "" }));
    anchor = name;
  }
  return () => {
    for (const off of offs) off();
  };
}
