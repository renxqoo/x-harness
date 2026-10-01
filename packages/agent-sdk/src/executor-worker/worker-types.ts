import type { Session } from "@x-harness/session";
import type { AgentHandle } from "@x-harness/agent-loop";
import type { World } from "@x-harness/harness";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import type { DialFact } from "../shared/meta-fold.ts";
import type { ThinkingLevel } from "@x-harness/llm";
import type { PermissionModeService } from "@x-harness/permission";
import type { DelegationView } from "@x-harness/agent-delegation";
import type { CommandRegistry } from "@x-harness/commands";
import type { ScriptAdapter } from "../shared/script-adapter.ts";

export interface WorkerState {
  handle: AgentHandle | undefined;
  world: World | undefined;
  catalog: WorkerCatalog;
  catalogBox: { current: WorkerCatalog };
  dial: DialFact;
  thinking: ThinkingLevel | undefined;
  permissionService: PermissionModeService | undefined;
  commands: CommandRegistry | undefined;
  delegation: DelegationView | undefined;
  threadId: string;
  sessionPath: string;
  cwd: string;
  trusted: boolean;
  skillsDirs: readonly string[];
  skillsDisabled: ReadonlySet<string>;
  scriptAdapter: ScriptAdapter | undefined;
}

export interface CommandHandlerRegistry extends Map<string, (input: Record<string, unknown>) => Promise<void>> {}

export type { Session };

export interface WorkerRuntimeLike {
  state: WorkerState;
  emitLine: (line: string) => void;
  agentDir: string;
  sessionsRoot: string;
  broker: { confirm(threadId: string, fields: never): Promise<unknown>; pendingCount(): number; denyAll(): void; pendingAll(): unknown };
  bash: { exec(spec: never): Promise<unknown>; abortAdmissions(cause?: string): boolean | void; abortRunning(id: string | undefined): void; isRunning(): boolean; readLatest(): unknown };
  inflight: { register(): { signal: AbortSignal; unregister(): void }; abortAll(): Promise<void> };
  inflightState: { snapshot(): unknown };
  bridge: { isStreaming(): boolean; commandBusy(): boolean; childBusy(): boolean; emitSettledFor(payload: { threadId: string; sendId: string; ok: boolean; reason?: string }): void };
  triggerShutdown(): void;
  env: Record<string, string | undefined>;
  pendingSends: number;
  proposals?: unknown;
}
