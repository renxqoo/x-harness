import type { HubErrorShape } from "../shared/errors.ts";

export interface CommandOutcome {
  command: string;
  data?: unknown;
  error?: HubErrorShape;
  control?: ControlFact;
}

export interface ControlFact {
  kind: "thread-started" | "thread-resumed" | "thread-stopped" | "thread-rekeyed" | "shutdown";
  threadId: string;
  sessionPath?: string;
  cwd?: string;
  gitBranch?: string;
  projectSettingsPresent?: boolean;
  oldThreadId?: string;
}

export type CommandHandler = (input: Record<string, unknown>) => Promise<CommandOutcome> | CommandOutcome;

export interface CommandDeps {
  resolveOutcome(outcome: CommandOutcome, requestId?: string): void;
}
