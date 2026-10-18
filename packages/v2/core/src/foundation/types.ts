import type { DefinitionData } from "../contracts/definition-data";
import type {
  Context, DependencyContext, Invocation, CoreFaultCode, DefinitionRef, Diagnostic, JsonValue, Cleanup, Disposer, Limits, MaybePromise,
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
  tombstones: WeakSet<DefinitionRef>;
  close?: Promise<Result<import("../contracts/types").CloseReport>>;
  actualClose?: Promise<Result<import("../contracts/types").CloseReport>>;
  closeDeadline?: number;
}

export interface Owner {
  readonly id: string;
  readonly name?: string;
  readonly scope: Scope;
  readonly state: PluginState | "host";
  readonly kind: "host" | "plugin";
  readonly controller: AbortController;
  readonly plugin?: Plugin;
  readonly bindings: ReadonlyMap<DefinitionRef, Provider | null>;
  readonly providers: ReadonlySet<Provider>;
  readonly registrations: ReadonlySet<Registration>;
  readonly effects: ReadonlySet<Effect>;
  readonly activities: ReadonlySet<Work>;
  readonly children: ReadonlySet<Scope>;
  readonly leases: ReadonlySet<ServiceLease>;
  readonly transaction?: Install;
  readonly revokeContexts: ReadonlySet<() => void>;
  readonly cleanupFailed: boolean;
  readonly activation?: Work;
  readonly cleanupController?: AbortController;
  readonly cleanupDeadline?: number;
  readonly close?: Promise<Result<void>>;
}

export interface Provider {
  readonly id: string;
  readonly definition: DefinitionData;
  readonly scope: Scope;
  readonly owner: Owner;
  readonly active: boolean;
  readonly published: boolean;
  readonly configured: boolean;
  readonly shadow: boolean;
  readonly implementation?: Readonly<Record<string, (input: unknown, call: unknown) => Promise<AnyResult>>>;
  readonly terminal?: Handler;
  readonly pins: ReadonlySet<Effect>;
  readonly leases: ReadonlySet<ServiceLease>;
}

export interface Registration {
  readonly id: string;
  readonly owner: Owner;
  readonly provider: Provider;
  readonly handler?: Handler;
  readonly active: boolean;
  readonly published: boolean;
  readonly onRetire?: () => void;
}

export interface Effect {
  readonly cleanupWork?: ReadonlySet<Work>;
  readonly kind: import("../contracts/types").ResourceInspection["kind"];
  readonly id: string;
  readonly owner: Owner;
  readonly executor: Owner;
  readonly consumer: boolean;
  readonly dependencies: ReadonlyMap<DefinitionRef, Provider | null>;
  readonly disposer?: Cleanup;
  readonly disposerIdentity?: Cleanup;
  readonly handle: Disposer;
  revokeHandle(): void;
  readonly beforeRelease?: () => Result<void>;
  readonly beginRelease?: () => void;
  readonly promise?: Promise<Result<void>>;
  readonly failed: boolean;
}

export interface EventJob {
  payload: unknown;
  origin: Origin & { emissionId: string; sequence: number };
}

export interface View {
  resourceOwner?: Owner;
  staging?: boolean;
  scope: Scope;
  owner: Owner;
  bound?: Work;
  cleanup?: boolean;
  dependencies?: ReadonlyMap<DefinitionRef, Provider | null>;
  cleanupControl?: CleanupControl;
}

export interface CleanupControl {
  controller: AbortController;
  deadline: number;
  finished?: boolean;
  leases?: Set<ServiceLease>;
  works: Set<Work>;
  revokeContexts: Set<() => void>;
}

export interface ServiceLease {
  kernel?: Kernel;
  view?: View;
  provider?: Provider;
  counted?: boolean;
}

export interface Work {
  label?: string;
  bodyOpen: boolean;
  id: string;
  kind: "call" | "task";
  phase: "activation" | "business" | "observer" | "cleanup";
  view: View;
  executor: Owner;
  resourceOwner: Owner;
  parent?: Work;
  depth: number;
  controller: AbortController;
  cancellation?: "cancelled" | "timeout";
  deadline: number;
  actual: Promise<AnyResult>;
  outcome: Promise<AnyResult>;
  fail(result: AnyResult): void;
  revokeInvocation?: () => void;
  revokeContexts: Set<() => void>;
  children: Set<Work>;
  leases: Set<ServiceLease>;
  settled: boolean;
  observation: { observed: boolean; acknowledge?: () => void };
  result?: AnyResult;
}

export interface Install {
  participants: Set<Owner>;
  owners: Owner[];
  providers: Map<DefinitionRef, Provider>;
  phase: "staging" | "committed" | "rollback";
  cause?: Result<never>;
}

export interface TaskCell {
  id: string;
  outcome: Promise<AnyResult>;
  work?: Work;
  settled: boolean;
  observation: { observed: boolean; acknowledge?: () => void };
}

export interface DefinitionEntry {
  token: DefinitionRef;
  references: Set<object>;
}

export interface Kernel {
  readonly createContextView: (view: View) => Context;
  readonly createInvocation: (work: Work) => Invocation;
  readonly createDependencyContext: (view: View, cleanup?: CleanupControl) => DependencyContext;
  readonly closeScope: (scope: Scope) => Promise<Result<import("../contracts/types").CloseReport>>;
  readonly root: Scope;
  readonly scheduler: Scheduler;
  readonly id: () => number;
  readonly registry: ReturnType<typeof import("../registry/create-registry").createRegistry>;
  readonly execution: ReturnType<typeof import("../execution/create-execution").createExecution>;
  readonly lifetime: ReturnType<typeof import("../lifetime/create-lifetime").createLifetime>;
  readonly assembly: ReturnType<typeof import("../assembly/create-assembly").createAssembly>;
  readonly events: ReturnType<typeof import("../mechanisms/events/create-event-queue").createEventQueue>;
  readonly diagnostics: () => readonly Diagnostic[];
  readonly fault: (code: CoreFaultCode, owner?: Owner, context?: { definition?: DefinitionRef; details?: JsonValue; scopeId?: string; callId?: string }) => Result<never>;
}
