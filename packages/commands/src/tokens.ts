import { defineEvent, defineService } from "@x-harness/core";
import type { CommandDefinition, CommandDescriptor, CommandExecution } from "./types.ts";
import type { Session } from "@x-harness/session";

export const commandsChange = defineEvent<Record<string, never>>("commands/change", { freeze: "none" });

export interface CommandRegistry {
  register(definition: CommandDefinition): () => void;
  list(): readonly CommandDescriptor[];
  find(name: string): CommandDefinition | undefined;
  execute(session: Session, line: string, signal: AbortSignal): Promise<CommandExecution | undefined>;
}

export const commandRegistry = defineService<CommandRegistry>("command/registry");
