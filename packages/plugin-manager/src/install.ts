import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlugins, pluginEvent } from "@x-harness/core";
import type { AnyToken, Plugin } from "@x-harness/core";
import { createWorkerBridge, type WorkerBridge } from "./bridge.ts";
import type { Registry } from "./registry.ts";
import type { ApprovalGate } from "./approval.ts";
import type { ErrorLog } from "./error-log.ts";
import { validateModule } from "./validate-module.ts";
import { createProcessCapabilities } from "./capabilities.ts";
import type { PluginCapabilities } from "./capabilities.ts";
import { wrapPluginForErrorRouting } from "./wrapper.ts";
import type {
  CreatePluginManagerDeps,
  InstallInput,
  PluginAuditEntry,
  PluginErrorEntry,
  PluginHandle,
  Result,
  UninstallInput,
} from "./types.ts";

export interface InstallerDeps extends CreatePluginManagerDeps {
  readonly vendorRoots?: readonly string[];
  readonly registry: Registry;
  readonly errorLog: ErrorLog;
  readonly approvalGate: ApprovalGate;
  readonly tokenTable: Map<string, AnyToken>;
}

function resolveWithinRoots(roots: readonly string[], inputPath: string): Result<string, string> {
  for (const root of roots) {
    const absolute = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
    const rel = relative(resolve(root), absolute);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return { ok: true, value: absolute };
    }
  }
  return { ok: false, reason: `path outside roots: ${inputPath}` };
}

function isWithinAnyRoot(roots: readonly string[], inputPath: string): boolean {
  return roots.some((root) => {
    const rel = relative(resolve(root), inputPath);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

export interface Installer {
  install(input: InstallInput): Promise<Result<PluginHandle, string>>;
  uninstall(name: string, input?: UninstallInput): Promise<Result<undefined, string>>;
}

export function createInstaller(deps: InstallerDeps): Installer {
  const platform = deps.ctx;
  const kernelApiVersion = deps.kernelApiVersion ?? 1;
  const loadCounts = new Map<string, number>();
  const loadModule =
    deps.loadModule ??
    ((path: string) => {
      const count = (loadCounts.get(path) ?? 0) + 1;
      loadCounts.set(path, count);
      return count === 1 ? import(path) : import(`${path}?pmv=${count}`);
    });
  const hostPath = fileURLToPath(new URL("./worker/host.ts", import.meta.url));

  const audit = (entry: PluginAuditEntry): void => {
    void deps.audit?.append({ ...entry, ts: Date.now() });
  };
  const auditNow = async (entry: PluginAuditEntry): Promise<void> => {
    await deps.audit?.append({ ...entry, ts: Date.now() });
  };
  const logError = (entry: Omit<PluginErrorEntry, "ts">): void => {
    deps.errorLog.add({ ...entry, ts: Date.now() });
  };
  const emitEnvelope = (kind: string, data: Record<string, unknown>): void => {
    platform.emit(pluginEvent, { plugin: "plugin-manager", kind, data, ts: Date.now() });
  };
  const installFailed = (plugin: string, detail: string): void => {
    audit({ kind: "install-failed", plugin, detail });
    emitEnvelope("install-failed", { name: plugin, detail });
  };

  interface Registration {
    readonly name: string;
    readonly path: string;
    readonly mode: "process" | "worker";
    readonly inject: readonly string[];
    readonly teardown: () => Promise<Result<undefined, string>>;
    readonly owner: unknown;
  }

  async function register(args: Registration): Promise<PluginHandle> {
    const { name, path, mode, inject, teardown, owner } = args;
    const unloadFn = async (): Promise<Result<undefined, string>> => {
      let result: Result<undefined, string>;
      try {
        result = await teardown();
      } catch (error) {
        result = { ok: false, reason: `unload failed: ${String(error)}` };
      }
      deps.registry.remove(name);
      await auditNow({ kind: "uninstall", plugin: name, detail: result.ok ? undefined : "unload reported failure" });
      emitEnvelope("uninstalled", { name, outcome: result.ok });
      return result;
    };
    deps.registry.put(
      { name, path, mode, status: "active", installedAt: Date.now(), inject: [...inject] },
      unloadFn,
      owner,
    );
    await auditNow({ kind: "install", plugin: name });
    emitEnvelope("installed", { name, path, mode });
    return {
      name,
      path,
      mode,
      unload: (input) => uninstall(name, input),
    };
  }

  function registerFailure(args: {
    readonly name: string;
    readonly path: string;
    readonly mode: "process" | "worker";
    readonly reason: string;
  }): void {
    const { name, path, mode, reason } = args;
    deps.registry.put(
      { name, path, mode, status: "failed", installedAt: Date.now(), inject: [] },
      async () => {
        deps.registry.remove(name);
        audit({ kind: "uninstall", plugin: name, detail: "failed record cleared" });
        return { ok: true, value: undefined };
      },
      {},
    );
    installFailed(name, reason);
  }

  async function installProcess(
    path: string,
    plugin: Plugin,
    name: string,
  ): Promise<Result<PluginHandle, string>> {
    const scope = platform.scope({ agentId: `plugin:${name}` });
    const provided: { name: string; token: AnyToken }[] = [];
    const onCapabilityToken = (token: AnyToken): void => {
      const existing = deps.tokenTable.get(token.name);
      if (existing !== undefined && existing !== token) {
        throw new Error(`token name collision: "${token.name}" already registered by a different module (token identity is object-based — share via the defining package)`);
      }
      deps.tokenTable.set(token.name, token);
      provided.push({ name: token.name, token });
    };
    const capabilities: PluginCapabilities = createProcessCapabilities(platform, deps.tokenTable, onCapabilityToken);
    const wrapped = wrapPluginForErrorRouting(plugin, {
      capabilities,
      sink: (where, message) => logError({ plugin: name, phase: "runtime", where, message }),
      root: platform,
      onToken: (token) => {
        const existing = deps.tokenTable.get(token.name);
        if (existing !== undefined && existing !== token) {
          throw new Error(`token name collision: "${token.name}" already registered by a different module (token identity is object-based — share via the defining package)`);
        }
        deps.tokenTable.set(token.name, token);
        provided.push({ name: token.name, token });
      },
    });
    const cleanupTokens = (): void => {
      for (const { name: tokenName, token } of provided) {
        if (deps.tokenTable.get(tokenName) === token) deps.tokenTable.delete(tokenName);
      }
    };
    try {
      const unloaders = await loadPlugins(scope, [wrapped]);
      const unload = unloaders[0];
      if (unload === undefined) throw new Error("unloader missing");
      const teardown = async (): Promise<Result<undefined, string>> => {
        await scope.dispose();
        await unload();
        cleanupTokens();
        return { ok: true, value: undefined };
      };
      return {
        ok: true,
        value: await register({
          name,
          path,
          mode: "process",
          inject: plugin.inject ?? [],
          teardown,
          owner: teardown,
        }),
      };
    } catch (error) {
      await scope.dispose();
      cleanupTokens();
      const reason = `apply failed: ${String(error)}`;
      logError({ plugin: name, phase: "install", where: "apply", message: reason });
      registerFailure({ name, path, mode: "process", reason });
      return { ok: false, reason };
    }
  }

  async function installWorker(
    path: string,
    replace: boolean,
  ): Promise<Result<PluginHandle, string>> {
    const bridgeIdentity = { name: undefined as string | undefined };
    const bridge = createWorkerBridge({
      pluginPath: path,
      platform,
      tokenTable: deps.tokenTable,
      applyTimeoutMs: deps.applyTimeoutMs ?? 10_000,
      runtimeTimeoutMs: deps.runtimeTimeoutMs ?? 60_000,
      kernelApiVersion,
      hostPath,
      onRuntimeError: (where, message) =>
        logError({ plugin: bridgeIdentity.name ?? "unknown", phase: "runtime", where, message }),
      onKilled: (reason) => {
        logError({
          plugin: bridgeIdentity.name ?? "unknown",
          phase: "runtime",
          where: "worker",
          message: `killed: ${reason}`,
        });
        audit({ kind: "killed", plugin: bridgeIdentity.name ?? "unknown", detail: reason });
        if (bridgeIdentity.name !== undefined) {
          deps.registry.removeIfOwned(bridgeIdentity.name, teardown);
        }
      },
    });
    const teardown = (): Promise<Result<undefined, string>> => bridge.shutdown();
    const begun = await bridge.begin();
    if (!begun.ok) {
      await bridge.kill(`begin failed: ${begun.reason}`);
      logError({ plugin: "unknown", phase: "install", where: "worker-boot", message: begun.reason });
      installFailed("unknown", begun.reason);
      return { ok: false, reason: begun.reason };
    }
    const { name, inject } = begun.value;
    bridgeIdentity.name = name;
    return deps.registry.withNameLock(name, async () => {
      const existing = deps.registry.entry(name);
      if (existing !== undefined && existing.record.status === "active") {
        if (!replace) {
          await bridge.kill(`duplicate name after ready: ${name}`);
          const reason = `plugin "${name}" already installed (use replace)`;
          logError({ plugin: name, phase: "install", where: "conflict", message: reason });
          return { ok: false, reason };
        }
        const removed = await existing.unload();
        if (!removed.ok) {
          await bridge.kill(`replace unload failed: ${name}`);
          logError({
            plugin: name,
            phase: "install",
            where: "replace",
            message: `old unload failed: ${removed.reason}`,
          });
          return removed;
        }
      }
      const applied = await bridge.proceed();
      if (!applied.ok) {
        logError({ plugin: name, phase: "install", where: "apply", message: applied.reason });
        registerFailure({ name, path, mode: "worker", reason: applied.reason });
        return { ok: false, reason: applied.reason };
      }
      if (bridge.isDead()) {
        const reason = "worker died right after apply";
        logError({ plugin: name, phase: "install", where: "race", message: reason });
        registerFailure({ name, path, mode: "worker", reason });
        return { ok: false, reason };
      }
      return {
        ok: true,
        value: await register({ name, path, mode: "worker", inject, teardown, owner: teardown }),
      };
    });
  }

  async function uninstall(name: string, input?: UninstallInput): Promise<Result<undefined, string>> {
    return deps.registry.withNameLock(name, async () => {
      const entry = deps.registry.entry(name);
      if (entry === undefined) return { ok: false, reason: `unknown plugin: ${name}` };
      if (entry.record.status === "failed") return entry.unload();
      const dependents = deps.registry.dependentsOf(name);
      if (dependents.length > 0 && input?.force !== true) {
        const reason = `plugin "${name}" has dependents: ${dependents.join(", ")} (use force)`;
        logError({ plugin: name, phase: "uninstall", where: "uninstall-blocked", message: reason });
        return { ok: false, reason };
      }
      return entry.unload();
    });
  }

  return {
    async install(input) {
      const withinRoots = resolveWithinRoots(deps.roots, input.path);
      if (!withinRoots.ok) {
        installFailed("?", withinRoots.reason);
        return { ok: false, reason: withinRoots.reason };
      }
      const path = withinRoots.value;
      const approved = await deps.approvalGate({ path });
      if (!approved.ok) {
        installFailed("?", approved.reason);
        return { ok: false, reason: approved.reason };
      }
      const mode = input.mode ?? deps.mode ?? "process";
      if (isWithinAnyRoot(deps.vendorRoots ?? [], path) && mode === "process") {
        const reason = `vendor plugin path requires worker mode: ${path}`;
        installFailed("?", reason);
        return { ok: false, reason };
      }
      if (mode === "worker") {
        const hostOnDisk = await stat(hostPath).catch(() => undefined);
        if (hostOnDisk === undefined || !hostOnDisk.isFile()) {
          const reason = `worker mode unavailable: plugin host file not on disk (compiled single-file builds do not support thread-isolated plugins): ${hostPath}`;
          installFailed("?", reason);
          return { ok: false, reason };
        }
        return installWorker(path, input.replace === true);
      }

      const mod = await loadModule(path);
      const validated = validateModule(mod, kernelApiVersion);
      if (!validated.ok) {
        logError({ plugin: "unknown", phase: "install", where: "validate", message: validated.reason });
        installFailed("unknown", validated.reason);
        return { ok: false, reason: validated.reason };
      }
      const plugin = validated.value.plugin;
      const name = plugin.name;
      return deps.registry.withNameLock(name, async () => {
        const existing = deps.registry.entry(name);
        if (existing !== undefined && existing.record.status === "active") {
          if (input.replace !== true) {
            const reason = `plugin "${name}" already installed (use replace)`;
            logError({ plugin: name, phase: "install", where: "conflict", message: reason });
            return { ok: false, reason };
          }
          const removed = await existing.unload();
          if (!removed.ok) return removed;
        }
        return installProcess(path, plugin, name);
      });
    },
    uninstall,
  };
}

export type { WorkerBridge };
