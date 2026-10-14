import type { DefinitionData } from "../contracts/definition-data";
import type {
  Context, CoreFaultCode, DefinitionRef, Diagnostic, Disposer, Limits, MaybePromise,
  Origin, Plugin, PluginState, Result, Scheduler, ScopeState,
} from "../contracts/types";

export type AnyResult = Result<unknown, unknown>;
export type Handler = (input: unknown, next: unknown, call: unknown) => MaybePromise<unknown>;

export interface Scope {
  id: string;
  label: string;
  parent?: Scope;
  creator?: Owner;
  state: ScopeState;
  controller: AbortController;
  limits: Limits;
  owners: Set<Owner>;
  children: Set<Scope>;
  providers: Map<DefinitionRef, Provider>;
  tombstones: Set<DefinitionRef>;
  close?: Promise<Result<import("../contracts/types").CloseReport>>;
  actualClose?: Promise<Result<import("../contracts/types").CloseReport>>;
  closeDeadline?: number;
}

export interface Owner {
  id: string;
  name?: string;
  scope: Scope;
  state: PluginState | "host";
  controller: AbortController;
  plugin?: Plugin;
  bindings: Map<DefinitionRef, Provider | null>;
  providers: Set<Provider>;
  registrations: Set<Registration>;
  effects: Set<Effect>;
  activities: Set<Work>;
  children: Set<Scope>;
  leases: Set<ServiceLease>;
  transaction?: Install;
  cleanupFailed: boolean;
  activation?: Work;
  cleanupController?: AbortController;
  cleanupDeadline?: number;
  close?: Promise<Result<void>>;
}

export interface Provider {
  id: string;
  definition: DefinitionData;
  scope: Scope;
  owner: Owner;
  active: boolean;
  published: boolean;
  configured: boolean;
  implementation?: Readonly<Record<string, (input: unknown, call: unknown) => Promise<AnyResult>>>;
  terminal?: Handler;
  pins: Set<Effect>;
  leases: Set<ServiceLease>;
}

export interface Registration {
  id: string;
  owner: Owner;
  provider: Provider;
  handler?: Handler;
  active: boolean;
  published: boolean;
  order: number;
  queue: EventJob[];
  running: boolean;
}

export interface Effect {
  id: string;
  owner: Owner;
  executor: Owner;
  consumer: boolean;
  dependencies: Map<DefinitionRef, Provider | null>;
  disposer?: Disposer;
  handle: Disposer;
  revokeHandle(): void;
  beforeRelease?: () => Result<void>;
  promise?: Promise<Result<void>>;
  failed: boolean;
}

export interface EventJob {
  payload: unknown;
  origin: Origin & { emissionId: string; sequence: number };
}

export interface View {
  scope: Scope;
  owner: Owner;
  bound?: Work;
  cleanup?: boolean;
  dependencies?: Map<DefinitionRef, Provider | null>;
  cleanupControl?: CleanupControl;
}

export interface CleanupControl {
  controller: AbortController;
  deadline: number;
  finished?: boolean;
  leases?: Set<ServiceLease>;
}

export interface ServiceLease {
  runtime?: Runtime;
  view?: View;
  provider?: Provider;
}

export interface Work {
  id: string;
  kind: "call" | "task";
  phase: "activation" | "business" | "observer" | "cleanup";
  view: View;
  executor: Owner;
  resourceOwner: Owner;
  parent?: Work;
  depth: number;
  controller: AbortController;
  deadline: number;
  actual: Promise<AnyResult>;
  outcome: Promise<AnyResult>;
  fail(result: AnyResult): void;
  revokeInvocation?: () => void;
  children: Set<Work>;
  leases: Set<ServiceLease>;
  settled: boolean;
  observation: { observed: boolean; acknowledge?: () => void };
  result?: AnyResult;
}

export interface Install {
  owners: Owner[];
  providers: Map<DefinitionRef, Provider>;
  phase: "staging" | "committed" | "rollback";
}

export interface TaskCell {
  id: string;
  outcome: Promise<AnyResult>;
  work?: Work;
  settled: boolean;
  observation: { observed: boolean; acknowledge?: () => void };
}

export interface Runtime {
  root: Scope;
  host: Owner;
  scheduler: Scheduler;
  scopes: Map<string, Scope>;
  owners: Map<string, Owner>;
  definitions: Map<string, DefinitionRef>;
  works: Map<string, Work>;
  effects: Set<Effect>;
  effectIndex: WeakMap<Disposer, Effect>;
  views: WeakMap<Context, View>;
  taskHandles: WeakMap<object, TaskCell>;
  pluginRefs: WeakMap<object, string>;
  serviceCaches: WeakMap<View, Map<Provider, unknown>>;
  activeCalls: number;
  leaseCount: number;
  activeTasks: number;
  registrations: Set<Registration>;
  waiting: Map<string, Map<string, number>>;
  diagnostics: Diagnostic[];
  diagnosticSink?: (diagnostic: Diagnostic) => void;
  mutation: Promise<void>;
  pendingMutations: number;
  degraded: boolean;
  eventSequence: number;
  nextId: number;
  nextOrder: number;
  eventPending: number;
  fault(code: CoreFaultCode, owner?: Owner): Result<never>;
}
