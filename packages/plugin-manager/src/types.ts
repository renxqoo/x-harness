import type { AnyToken, Context, Plugin, ServiceToken } from "@x-harness/core";

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: E };

export type ExecMode = "process" | "worker";

export interface InstallInput {
  readonly path: string;
  readonly replace?: boolean;
  readonly mode?: ExecMode;
}

export interface UninstallInput {
  readonly force?: boolean;
}

export interface PluginHandle {
  readonly name: string;
  readonly path: string;
  readonly mode: ExecMode;
  unload(input?: UninstallInput): Promise<Result<undefined, string>>;
}

export interface PluginRecord {
  readonly name: string;
  readonly path: string;
  readonly mode: ExecMode;
  readonly status: "active" | "failed";
  readonly installedAt: number;
  readonly inject: readonly string[];
}

export interface PluginErrorEntry {
  readonly plugin: string;
  readonly phase: "install" | "runtime" | "uninstall";
  readonly where: string;
  readonly message: string;
  readonly ts: number;
}

export interface PluginManagerService {
  install(input: InstallInput): Promise<Result<PluginHandle, string>>;
  uninstall(name: string, input?: UninstallInput): Promise<Result<undefined, string>>;
  list(): readonly PluginRecord[];
  errors(name?: string): readonly PluginErrorEntry[];
  dependentsOf(name: string): readonly string[];
  token(name: string): AnyToken | undefined;
  serviceToken(name: string): ServiceToken<unknown> | undefined;
}

export const pluginManagerService: ServiceToken<PluginManagerService> = Object.freeze({
  kind: "service",
  name: "plugin-manager",
}) as ServiceToken<PluginManagerService>;

export interface PluginAuditEntry {
  readonly kind: "install" | "uninstall" | "install-failed" | "runtime-error" | "killed";
  readonly plugin: string;
  readonly detail?: string;
}

export interface AuditPort {
  append(entry: PluginAuditEntry & { readonly ts: number }): Promise<void>;
}

export interface CreatePluginManagerDeps {
  readonly ctx: Context;
  readonly roots: readonly string[];
  readonly mode?: ExecMode;
  readonly approveInstall?: (input: { readonly path: string }) => boolean | Promise<boolean>;
  readonly errorLogLimit?: number;
  readonly audit?: AuditPort;
  readonly applyTimeoutMs?: number;
  readonly runtimeTimeoutMs?: number;
  readonly vendorRoots?: readonly string[];
  readonly tokens?: readonly AnyToken[];
  readonly kernelApiVersion?: number;
  readonly loadModule?: (path: string) => Promise<unknown>;
}

export interface ValidatedModule {
  readonly plugin: Plugin;
  readonly apiVersion?: number;
}
