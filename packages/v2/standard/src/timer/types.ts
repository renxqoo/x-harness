import type {
  Cleanup,
  Disposer,
  MaybePromise,
  Result,
  Scheduler,
  TaskHandle,
} from "../../../core/src/index";

export interface TimerOwner<C extends { readonly signal: AbortSignal }> {
  readonly signal: AbortSignal;
  addCleanup(cleanup: Cleanup): Result<Disposer>;
  startTask(spec: {
    readonly label: string;
    readonly run: (call: C) => MaybePromise<Result<unknown, unknown>>;
    readonly timeoutMs?: number;
  }): Result<TaskHandle<unknown, unknown>>;
}
export interface ScheduleSpec<C> {
  readonly ms: number;
  readonly run: (call: C) => MaybePromise<Result<unknown, unknown>>;
  readonly label?: string;
  readonly timeoutMs?: number;
}
export interface ScheduledTask {
  readonly state: "scheduled" | "running" | "stopping" | "stopped";
  readonly finished: Promise<Result<void, unknown>>;
  cancel(): Result<void>;
}
export interface ScopedTimer<C> {
  timeout(spec: ScheduleSpec<C>): Result<ScheduledTask>;
  interval(spec: ScheduleSpec<C>): Result<ScheduledTask>;
}
export interface ScheduleSlot<C extends { readonly signal: AbortSignal }> {
  state: ScheduledTask["state"];
  resolve(result: Result<void, unknown>): void;
  readonly closed: Promise<Result<void, unknown>>;
  close(result: Result<void, unknown>): void;
  current?: {
    owner: TimerOwner<C>;
    scheduler: Scheduler;
    spec: ScheduleSpec<C>;
    repeat: boolean;
    dispose?: Disposer;
    clear?: () => void;
    task?: TaskHandle<unknown, unknown>;
    terminal?: Result<void, unknown>;
    onAbort: (this: void) => void;
  };
}
