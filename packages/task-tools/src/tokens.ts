// 任务件契约（docs/TASKS.md §1.2 + docs/TASK-PUSH-DESIGN.md §2.1）：TaskHub 服务 + 三态
// probe + 源接口（stop 单动词：agent 报告推送交付、bash 读面=日志文件 +
// [task-notification]）。路由序 = kind 字典序（agent 先于 bash）——不依赖注册
// 时序；kind 闭合词表防装配态漂移。

import { defineService } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

/** 源对 task_id 的认领裁决：hit 续走 stop；denied 认领但终结（透传源文案，路由不续走
 *  ——后源不得遮蔽）；miss 续试下一源 */
export type TaskProbe =
  | { readonly kind: "hit" }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "miss" };

export type TaskOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export interface TaskSource {
  readonly kind: "agent" | "bash";
  probe(taskId: string, caller: SessionId | undefined): TaskProbe;
  /** 失败 reason 以 `not-found:` 开头 = 迟到 miss（probe hit 后行消失）——路由层据此续试
   *  余源并兜底统一词表；其余 reason 一律透传终结。这是源的协议事实，第三源措辞必须遵守 */
  stop(taskId: string, caller: SessionId | undefined): Promise<TaskOutcome>;
}

export interface TaskHub {
  /** 重名 kind throw（装配 fail-fast）；返回摘除句柄，注册方自经 ctx.effect 挂摘除 */
  registerSource(source: TaskSource): () => void;
  /** kind 字典序快照（agent 先于 bash）——路由序固定 */
  sources(): readonly TaskSource[];
}

export const taskHub = defineService<TaskHub>("task-hub");
