import type { Invocation, Result, TaskHandle } from "../../../../core/src/index";
import type { ToolCapacity, PreparedTool, ToolExecutionPlan, ToolPermission } from "./types";
import type { CatalogEntry } from "../contributions/read-contribution";
import type { ToolRequest, ToolsLimits } from "../contracts/types";
export interface PlanState {
  readonly handle: PreparedTool;
  readonly runtime: WeakRef<PlanningRuntime>;
  readonly entry: CatalogEntry;
  readonly request: ToolRequest;
  readonly limits: ToolsLimits;
  readonly originId: string;
  readonly leaseTimeoutMs: number;
  readonly plan: ToolExecutionPlan;
  readonly permissions: Extract<ToolPermission, { kind: "allow" }>[];
  readonly off: (() => void)[];
  phase: "pending" | "running" | "closed";
  endLease?: () => void;
  cancel?: (reason?: "cancelled" | "timeout") => void;
  capacities: readonly ToolCapacity[];
}
export interface PlanningRuntime {
  closed: boolean;
  readonly limits: ToolsLimits;
  readonly watches: Set<() => import("../../../../core/src/index").Result<void>>;
  readonly listeners: Set<() => void>;
  readonly pending: Set<PreparedTool>;
  readonly active: Set<PlanState>;
  readonly toolActive: Map<string, number>;
  emit(): void;
  lease(state: PlanState): Result<TaskHandle<void>>;
  discover(
    call: Invocation,
  ): Promise<import("../contracts/types").ToolsResult<readonly CatalogEntry[]>>;
}
