export interface CommandInvocation {
  readonly commandId: string;
  readonly session: import("@x-harness/session").Session;
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

export type CommandResult =
  | { readonly kind: "success"; readonly text?: string; readonly data?: unknown }
  | { readonly kind: "error"; readonly text: string };

export interface CommandExecution {
  readonly commandId: string;
  readonly result: CommandResult;
}

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly recordInput?: boolean;
  execute(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
}

export interface CommandDescriptor {
  readonly name: string;
  readonly description: string;
}

export interface ParsedCommand {
  readonly name: string;
  readonly rawInput: string;
}
