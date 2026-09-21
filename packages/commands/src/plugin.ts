// 命令注册面插件（BATCH3-DESIGN §2.1）：全局单层注册表（scoped 遮蔽不移植——差异表
// D4）+ execute 三态 + command/run|done log-only 配对落账。命令不开 turn、不进模型
// 上下文；abort/cancel 权归调用方 signal（不移植 withAbort 竞速——差异表 D10）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { errorText } from "@x-harness/core";
import type { Session } from "@x-harness/session";
import { randomUUID } from "node:crypto";
import { COMMAND_NAME, parseCommand } from "./lexer.ts";
import { commandRegistry, commandsChange } from "./tokens.ts";
import type { CommandDefinition, CommandDescriptor, CommandExecution, CommandResult } from "./types.ts";

/** 定义校验（注册期 fail-fast——违词形/空描述/非函数 handler/同名冲突） */
function validateDefinition(definition: CommandDefinition): void {
  if (!COMMAND_NAME.test(definition.name)) {
    throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`);
  }
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new TypeError(`command "${definition.name}" description must be a non-empty string`);
  }
  if (typeof definition.execute !== "function") {
    throw new TypeError(`command "${definition.name}" handler must be a function`);
  }
}

/** 结果校验（registry 边界解冻——判别联合形状 fail-fast） */
function normalizeResult(command: string, value: unknown): CommandResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`command "${command}" handler must return a CommandResult`);
  }
  const result = value as { kind?: unknown; text?: unknown; data?: unknown };
  if (result.kind === "success") {
    if (result.text !== undefined && typeof result.text !== "string") {
      throw new TypeError(`command "${command}" success text must be a string when supplied`);
    }
    return { kind: "success", ...(result.text !== undefined ? { text: result.text } : {}), ...("data" in result ? { data: result.data } : {}) };
  }
  if (result.kind === "error") {
    if (typeof result.text !== "string" || result.text.trim() === "") {
      throw new TypeError(`command "${command}" error text must be a non-empty string`);
    }
    return { kind: "error", text: result.text };
  }
  throw new TypeError(`command "${command}" returned unknown result kind "${String(result.kind)}"`);
}

export const commandsPlugin = {
  name: "commands",
  apply: (ctx: Context): Disposer => {
    const definitions = new Map<string, CommandDefinition>();
    /** instanceToken = 每插件实例随机——同进程重装配（thread/stop→resume）不撞车 */
    const instanceToken = randomUUID().slice(0, 8);
    let commandSeq = 0;

    function appendCommandEvent(session: Session, type: "command/run" | "command/done", data: unknown): void {
      const appended = session.append(type as never, data as never);
      if (!appended.ok) throw new Error(`append-failed:${type}:${appended.reason}`);
    }

    /** done 落账（错误路径 contained——append 失败只吞不掩盖 handler 自身错误；
     *  失败面即会话已封存，与 delegation 通知面同款静默收敛纪律） */
    function settleThrown(session: Session, commandId: string): void {
      try {
        appendCommandEvent(session, "command/done", { commandId, kind: "error", text: "command handler failed" });
      } catch {
        /* 会话已封存：run/done 配对在恢复面按悬挂 run 合法 */
      }
    }

    const service = {
      register(definition: CommandDefinition): () => void {
        validateDefinition(definition);
        if (definitions.has(definition.name)) {
          throw new Error(`command "${definition.name}" is already registered`);
        }
        definitions.set(definition.name, definition);
        ctx.emit(commandsChange, {});
        return () => {
          if (definitions.get(definition.name) === definition) {
            definitions.delete(definition.name);
            ctx.emit(commandsChange, {});
          }
        };
      },
      list(): readonly CommandDescriptor[] {
        return [...definitions.values()].map((definition) => ({ name: definition.name, description: definition.description })).sort((left, right) => (left.name < right.name ? -1 : 1));
      },
      find(name: string): CommandDefinition | undefined {
        return definitions.get(name);
      },
      async execute(session: Session, line: string, signal: AbortSignal): Promise<CommandExecution | undefined> {
        const parsed = parseCommand(line);
        if (parsed === undefined) return undefined;
        const definition = definitions.get(parsed.name);
        if (definition === undefined) return undefined;
        signal.throwIfAborted(); // 已中止：零事件（对齐参照系）
        commandSeq += 1;
        const commandId = `cmd-${instanceToken}-${String(commandSeq)}`;
        appendCommandEvent(session, "command/run", {
          commandId,
          name: parsed.name,
          ...(definition.recordInput === false ? {} : { args: parsed.rawInput }),
        });
        const appendDone = (result: CommandResult): void => {
          appendCommandEvent(session, "command/done", {
            commandId,
            kind: result.kind,
            ...(result.text !== undefined ? { text: result.text } : {}),
          });
        };
        let result: CommandResult;
        try {
          result = normalizeResult(parsed.name, await definition.execute({ commandId, session, rawInput: parsed.rawInput, signal }));
        } catch (error) {
          settleThrown(session, commandId);
          throw error instanceof Error ? error : new Error(`command handler failed: ${errorText(error)}`);
        }
        try {
          appendDone(result);
        } catch {
          /* 会话已封存（stop/fork 拆线竞窗）：结果仍交付（悬挂 run 合法——BATCH3 收口审 H1） */
        }
        return { commandId, result };
      },
    };

    return ctx.provide(commandRegistry, service);
  },
} satisfies Plugin;
