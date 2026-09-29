import type { SessionId } from "@x-harness/session";
import type { InlineTypeResource } from "./types-inline.ts";

export interface LoadedAgentType {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly provider?: string;
  readonly tools?: readonly string[];
  readonly prompt: string;
}

export interface DelegationOptions {
  readonly agentsDirs: readonly string[];
  readonly workspaceRoot: string;
  readonly builtinTypes?: readonly InlineTypeResource[];
  readonly spawnDescriptionAppend?: string;
  readonly mailbox?: {
    readonly box: string;
    readonly mainSession: SessionId;
  };
  readonly maxDepth?: number;
  readonly maxConcurrent?: number;
  readonly reportCap?: number;
  readonly worktreeSweep?: boolean;
  readonly maxResident?: number;
  readonly onWarn?: (message: string) => void;
  readonly resolveProviderOf?: (model: string) => string | undefined;
}

export type ChildView =
  | {
      readonly kind: "subagent";
      readonly agentId: string;
      readonly sessionId: string;
      readonly type: string;
      readonly depth: number;
      readonly status: "running" | "idle" | "stopped";
      readonly work?: string;
      readonly worktree?: string;
    }
  | {
      readonly kind: "local-session";
      readonly name: string;
      readonly ref: string;
      readonly status: "running" | "idle";
    };
