import { join } from "node:path";
import type { AnyToken, Plugin } from "@x-harness/core";
import { contextDisposing, pluginError, pluginEvent, pluginLoaded, pluginUnloaded, serviceProvided } from "@x-harness/core";
import { createApprovalGate } from "./approval.ts";
import { createErrorLog, createFileAudit } from "./error-log.ts";
import { createInstaller } from "./install.ts";
import { createRegistry } from "./registry.ts";
import { pluginManagerService } from "./types.ts";
import type { CreatePluginManagerDeps, PluginManagerService } from "./types.ts";

export function createPluginManager(deps: CreatePluginManagerDeps): Plugin {
  return {
    name: "plugin-manager",
    apply(platformCtx) {
      const ctx = deps.ctx ?? platformCtx;
      const registry = createRegistry();
      const audit = deps.audit ?? createFileAudit(join(deps.roots[0] ?? process.cwd(), ".plugin-manager-audit.jsonl"));
      const errorLog = createErrorLog(deps.errorLogLimit ?? 100, audit);
      const approvalGate = createApprovalGate(deps.approveInstall);
      const tokenTable = new Map<string, AnyToken>();
      for (const token of [
        serviceProvided,
        pluginLoaded,
        pluginUnloaded,
        pluginError,
        contextDisposing,
        pluginEvent,
        ...(deps.tokens ?? []),
      ]) {
        tokenTable.set(token.name, token as AnyToken);
      }
      const installer = createInstaller({ ...deps, ctx, registry, errorLog, approvalGate, tokenTable, audit });

      const service: PluginManagerService = {
        install: (input) => installer.install(input),
        uninstall: (name, input) => installer.uninstall(name, input),
        list: () => registry.entries(),
        errors: (name) => errorLog.query(name),
        dependentsOf: (name) => registry.dependentsOf(name),
        token: (name) => tokenTable.get(name),
        serviceToken: (name) => {
          const token = tokenTable.get(name);
          return token !== undefined && token.kind === "service" ? token : undefined;
        },
      };
      platformCtx.provide(pluginManagerService, service);
    },
  };
}
