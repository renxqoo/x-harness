// 追加段注册 + 环境事实探测（docs/CLI.md §2.5）：基础段已迁 @x-harness/system-prompt
// （basePromptPlugin——facts 经本层探测后传入，包不做 IO）；--append-system-prompt 追加段
// 无边落尾（位于全部内置段之后），链式锚定保序。--system-prompt 整体替换时不注册本层
// （装配方裁决），AgentOptions.systemPrompt 静态串优先于 assemble 是包契约。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Disposer } from "@x-harness/core";
import { normalizeBaseFacts } from "@x-harness/system-prompt";
import type { BasePromptFacts, SystemPromptService } from "@x-harness/system-prompt";

/** facts 探测所需的最小 IO 面（CliIO 结构子集——避免与 main 循环依赖） */
export interface CliIoFacts {
  readonly cwd: string;
  readonly platform: string;
  readonly env: NodeJS.ProcessEnv;
}

/** 本地时区 yyyy-mm-dd（toISOString 是 UTC——东八区晚间会差一天） */
function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 自 cwd 向上寻 .git（目录或 worktree file 皆算——到文件系统根为止） */
function isGitWorkdir(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** 宿主探测：环境事实（date 会话内定格于此——午夜漂移不打断缓存前缀）；
 *  normalizeBaseFacts 入口归一（换行压空格/垃圾降级）——注入面收口在包侧统一执行 */
export function promptFactsOf(io: CliIoFacts): BasePromptFacts {
  return normalizeBaseFacts({
    cwd: io.cwd,
    isGit: isGitWorkdir(io.cwd),
    platform: io.platform,
    shell: io.env.SHELL ?? "",
    date: localToday(),
  });
}

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
