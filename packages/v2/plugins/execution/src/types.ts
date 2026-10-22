import type { JsonValue, Result } from "../../../core/src/index";
export interface ResourceClaim {
  readonly domain: string;
  readonly path: readonly string[];
  readonly scope: "exact" | "subtree";
  readonly mode: "read" | "write";
}
export interface ExecutionRequest {
  readonly profile: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}
export interface ExecutionTarget {
  readonly id: string;
  readonly backend: string;
  readonly profile: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly resources: readonly ResourceClaim[];
  readonly restrictions: Readonly<Record<string, JsonValue>>;
}
export const executionErrorCodes = [
  "invalid-input",
  "backend-unavailable",
  "profile-not-found",
  "target-changed",
  "access-denied",
  "busy",
  "output-limit",
  "cancelled",
  "timeout",
  "execution-failed",
  "closed",
] as const;
export interface ExecutionError {
  readonly source: "execution";
  readonly code: (typeof executionErrorCodes)[number];
  readonly message: string;
}
export type ExecutionResult<T> = Result<T, ExecutionError>;
export interface ExecutionOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ExecutionService {
  prepare(input: ExecutionRequest): Promise<ExecutionResult<ExecutionTarget>>;
  run(input: {
    readonly target: ExecutionTarget;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<ExecutionResult<ExecutionOutput>>;
}
export interface ExecutionFacade {
  run(): Promise<ExecutionResult<ExecutionOutput>>;
}
