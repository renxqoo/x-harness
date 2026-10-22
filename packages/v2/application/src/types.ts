import type { CoreFault, Host, HostOptions, Plugin, PluginRef, Result } from "../../core/src/index";

export interface ApplicationOptions {
  readonly host?: HostOptions;
  readonly maxPlugins?: number;
  readonly maxPendingOperations?: number;
}
export interface PluginStatus {
  readonly name: string;
  readonly state: "active" | "pending" | "failed";
  readonly missing: readonly string[];
  readonly instanceId?: string;
  readonly error?: CoreFault;
}
export interface ApplicationSnapshot {
  readonly state: "open" | "closing" | "closed" | "close-failed";
  readonly plugins: readonly PluginStatus[];
}
export interface Application {
  setPlugins(plugins: readonly Plugin[]): Promise<Result<ApplicationSnapshot>>;
  refresh(): Promise<Result<ApplicationSnapshot>>;
  snapshot(): ApplicationSnapshot;
  use: Host["use"];
  dispatch: Host["dispatch"];
  inspect: Host["inspect"];
  diagnostics: Host["diagnostics"];
  close: Host["close"];
}
export interface PlannedPlugin {
  readonly source: Plugin;
  readonly spec: Plugin;
}
export interface PluginPlan {
  readonly entries: readonly PlannedPlugin[];
  readonly providers: ReadonlyMap<object, string>;
}
export interface ActivePlugin {
  readonly entry: PlannedPlugin;
  readonly ref: PluginRef;
  readonly bindings: ReadonlyMap<object, string | null>;
}
export interface ApplicationState {
  readonly host: Host;
  wanted: PluginPlan;
  readonly active: Map<string, ActivePlugin>;
  readonly failures: Map<string, CoreFault>;
}
