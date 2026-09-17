// 装载编排（docs/PLUGIN-MANAGER.md §1.2 事件时序）：
// ① roots 路径校验 → ② 审批（import 前，按路径——import 即执行模块顶层代码）→
// ③ 模块加载 + 形状/版本校验 → ④ per-name 互斥 + 冲突/replace → ⑤ 模式分派执行 → ⑥ 登记/审计/信封。
// 落位纪律（裁决 9）：process 模式插件装进自己的 scope（teardown 单元），注册落位平台 root——
// 可见性向上（chain-up）、回卷向下（scope dispose 收编 root 注册的 disposer）。

import { isAbsolute, relative, resolve } from "node:path";
import { loadPlugins, pluginEvent } from "@x-harness/core";
import type { AnyToken, Plugin } from "@x-harness/core";
import { createWorkerBridge, type WorkerBridge } from "./bridge.ts";
import { handleOf, type Registry } from "./registry.ts";
import type { ApprovalGate } from "./approval.ts";
import type { ErrorLog } from "./error-log.ts";
import { validateModule } from "./validate-module.ts";
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

export interface Installer {
  install(input: InstallInput): Promise<Result<PluginHandle, string>>;
  uninstall(name: string, input?: UninstallInput): Promise<Result<undefined, string>>;
}

export function createInstaller(deps: InstallerDeps): Installer {
  const platform = deps.ctx;
  const kernelApiVersion = deps.kernelApiVersion ?? 1;
  // 首次加载 plain import（与宿主共享模块身份——token 对象同一）；同路径重装才 query bust
  const loadCounts = new Map<string, number>();
  const loadModule =
    deps.loadModule ??
    ((path: string) => {
      const count = (loadCounts.get(path) ?? 0) + 1;
      loadCounts.set(path, count);
      return count === 1 ? import(path) : import(`${path}?pmv=${count}`);
    });
  const hostPath = new URL("./worker/host.ts", import.meta.url).pathname;

  const audit = (entry: PluginAuditEntry): void => {
    void deps.audit?.append({ ...entry, ts: Date.now() });
  };
  const logError = (plugin: string, phase: PluginErrorEntry["phase"], where: string, message: string): void => {
    deps.errorLog.add({ plugin, phase, where, message, ts: Date.now() });
  };

  function register(
    name: string,
    path: string,
    mode: "process" | "worker",
    inject: readonly string[],
    teardown: () => Promise<Result<undefined, string>>,
  ): PluginHandle {
    const unloadFn = async (input?: UninstallInput): Promise<Result<undefined, string>> => {
      const result = await teardown();
      deps.registry.remove(name);
      audit({ kind: "uninstall", plugin: name });
      platform.emit(pluginEvent, {
        plugin: "plugin-manager",
        kind: "uninstalled",
        data: { name, outcome: result.ok },
        ts: Date.now(),
      });
      void input;
      return result;
    };
    deps.registry.put(
      { name, path, mode, status: "active", installedAt: Date.now(), inject: [...inject] },
      unloadFn,
    );
    const view = deps.registry.entry(name);
    if (view === undefined) throw new Error(`registry lost ${name} right after install`);
    audit({ kind: "install", plugin: name });
    platform.emit(pluginEvent, {
      plugin: "plugin-manager",
      kind: "installed",
      data: { name, path, mode },
      ts: Date.now(),
    });
    return handleOf(view);
  }

  async function installProcess(path: string, plugin: Plugin, name: string): Promise<Result<PluginHandle, string>> {
    const scope = platform.scope({ agentId: `plugin:${name}` });
    const wrapped = wrapPluginForErrorRouting(
      plugin,
      (where, message) => logError(name, "runtime", where, message),
      platform, // 裁决 9：注册落位 root，回卷链 scope
      (token) => deps.tokenTable.set(token.name, token), // 裁决 10：token 注册表（svc.token 消费面）
    );
    try {
      const unloaders = await loadPlugins(scope, [wrapped]);
      const unload = unloaders[0];
      if (unload === undefined) throw new Error("unloader missing");
      return {
        ok: true,
        value: register(name, path, "process", plugin.inject ?? [], async () => {
          await scope.dispose(); // 只回卷本插件层——平台无恙
          await unload(); // composite（dispose 已跑过注册项，此处幂等兜底 apply-disposer）
          return { ok: true, value: undefined };
        }),
      };
    } catch (error) {
      await scope.dispose();
      logError(name, "install", "apply", String(error));
      audit({ kind: "install-failed", plugin: name, detail: String(error) });
      return { ok: false, reason: `apply failed: ${String(error)}` };
    }
  }

  async function installWorker(path: string, replace: boolean): Promise<Result<PluginHandle, string>> {
    let bridgeName = "unknown";
    const bridge = createWorkerBridge({
      pluginPath: path,
      platform,
      tokenTable: deps.tokenTable,
      applyTimeoutMs: deps.applyTimeoutMs ?? 10_000,
      runtimeTimeoutMs: deps.runtimeTimeoutMs ?? 60_000,
      hostPath,
      onRuntimeError: (where, message) => logError(bridgeName, "runtime", where, message),
      onKilled: (reason) => {
        logError(bridgeName, "runtime", "worker", `killed: ${reason}`);
        audit({ kind: "killed", plugin: bridgeName, detail: reason });
        deps.registry.remove(bridgeName);
      },
    });
    const launched = await bridge.launch();
    if (!launched.ok) {
      await bridge.kill(`launch failed: ${launched.reason}`);
      logError("unknown", "install", "worker-launch", launched.reason);
      audit({ kind: "install-failed", plugin: "unknown", detail: launched.reason });
      return { ok: false, reason: launched.reason };
    }
    const { name, inject } = launched.value;
    bridgeName = name;
    return deps.registry.withNameLock(name, async () => {
      const existing = deps.registry.entry(name);
      if (existing !== undefined && existing.record.status === "active") {
        if (!replace) {
          await bridge.kill(`duplicate name after launch: ${name}`);
          const reason = `plugin "${name}" already installed (use replace)`;
          logError(name, "install", "conflict", reason);
          return { ok: false, reason };
        }
        const removed = await existing.unload();
        if (!removed.ok) return removed;
      }
      return {
        ok: true,
        value: register(name, path, "worker", inject, () => bridge.shutdown()),
      };
    });
  }

  return {
    async install(input) {
      const withinRoots = resolveWithinRoots(deps.roots, input.path);
      if (!withinRoots.ok) {
        audit({ kind: "install-failed", plugin: "?", detail: withinRoots.reason });
        return { ok: false, reason: withinRoots.reason };
      }
      const path = withinRoots.value;
      const approved = await deps.approvalGate({ path });
      if (!approved.ok) {
        audit({ kind: "install-failed", plugin: "?", detail: approved.reason });
        return { ok: false, reason: approved.reason };
      }
      const mode = input.mode ?? deps.mode ?? "process";
      if (mode === "worker") return installWorker(path, input.replace === true);

      const mod = await loadModule(path);
      const validated = validateModule(mod, kernelApiVersion);
      if (!validated.ok) {
        // 校验失败拿不到名字：不进登记簿，只进错误日志与审计
        logError("unknown", "install", "validate", validated.reason);
        audit({ kind: "install-failed", plugin: "unknown", detail: validated.reason });
        return { ok: false, reason: validated.reason };
      }
      const plugin = validated.value.plugin;
      const name = plugin.name;
      return deps.registry.withNameLock(name, async () => {
        const existing = deps.registry.entry(name);
        if (existing !== undefined && existing.record.status === "active") {
          if (input.replace !== true) {
            const reason = `plugin "${name}" already installed (use replace)`;
            logError(name, "install", "conflict", reason);
            return { ok: false, reason };
          }
          const removed = await existing.unload();
          if (!removed.ok) return removed;
        }
        return installProcess(path, plugin, name);
      });
    },

    async uninstall(name, input) {
      return deps.registry.withNameLock(name, async () => {
        const entry = deps.registry.entry(name);
        if (entry === undefined) return { ok: false, reason: `unknown plugin: ${name}` };
        const dependents = deps.registry.dependentsOf(name);
        if (dependents.length > 0 && input?.force !== true) {
          const reason = `plugin "${name}" has dependents: ${dependents.join(", ")} (use force)`;
          logError(name, "install", "uninstall-blocked", reason);
          return { ok: false, reason };
        }
        return entry.unload();
      });
    },
  };
}

export type { WorkerBridge };
