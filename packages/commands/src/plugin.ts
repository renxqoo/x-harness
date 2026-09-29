import type { Context, Disposer, Plugin } from "@x-harness/core";
import { errorText } from "@x-harness/core";
import type { Session, SessionEventData } from "@x-harness/session";
import { randomUUID } from "node:crypto";
import { COMMAND_NAME, parseCommand } from "./lexer.ts";
import { commandRegistry, commandsChange } from "./tokens.ts";
import type { CommandDefinition, CommandDescriptor, CommandExecution, CommandResult } from "./types.ts";

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
    const instanceToken = randomUUID().slice(0, 8);
    let commandSeq = 0;

    function appendCommandEvent<K extends "command/run" | "command/done">(session: Session, type: K, data: SessionEventData[K]): void {
      const appended = session.append(type, data);
      if (!appended.ok) throw new Error(`append-failed:${type}:${appended.reason}`);
    }

    function settleThrown(session: Session, commandId: string): void {
      try {
        appendCommandEvent(session, "command/done", { commandId, kind: "error", text: "command handler failed" });
      } catch {
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
        signal.throwIfAborted();
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
        }
        return { commandId, result };
      },
    };

    return ctx.provide(commandRegistry, service);
  },
} satisfies Plugin;
