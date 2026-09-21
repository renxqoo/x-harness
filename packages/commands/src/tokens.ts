// 命令注册面事件与令牌（BATCH3-DESIGN §2.1）。

import { defineEvent, defineService } from "@x-harness/core";
import type { CommandDefinition, CommandDescriptor, CommandExecution } from "./types.ts";
import type { Session } from "@x-harness/session";

/** 目录增删通知（freeze:none——UI 刷新面，非否决；逐监听器隔离异常） */
export const commandsChange = defineEvent<Record<string, never>>("commands/change", { freeze: "none" });

export interface CommandRegistry {
  /** 注册一条命令（违词形/空描述/同名 → throw fail-fast）；返回注销 disposer */
  register(definition: CommandDefinition): () => void;
  /** 目录（name 序）——get_commands 消费 */
  list(): readonly CommandDescriptor[];
  find(name: string): CommandDefinition | undefined;
  /** 词法解析 + 查表 + 执行（run/done 落账配对）。词法不命中或未注册 → undefined
   *  （调用方分路交模型）；已中止 signal → throw（零事件）；handler throw → 落
   *  done{error} 后重抛 */
  execute(session: Session, line: string, signal: AbortSignal): Promise<CommandExecution | undefined>;
}

export const commandRegistry = defineService<CommandRegistry>("command/registry");
