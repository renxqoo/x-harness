// 装载编排（docs/PLUGIN-MANAGER.md §1.2，审查批次修复后）：
// ① roots 校验 → ② 审批（import 前）→ ③ 模块加载 + 形状/版本校验 →
// ④ per-name 互斥 + 冲突/replace → ⑤ 模式分派 → ⑥ 登记/审计/信封。
// worker 三段式（#1/#7/#16）：begin（boot+ready，apply 未跑）→ 锁内 replace/冲突 → proceed → register。
// 落位纪律（裁决 9）：process 注册落平台 root，disposer 链回插件 scope。

import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlugins, pluginEvent } from "@x-harness/core";
import type { AnyToken, Plugin } from "@x-harness/core";
import { createWorkerBridge, type WorkerBridge } from "./bridge.ts";
import type { Registry } from "./registry.ts";
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
  // #15：percent-encoding 解码（含空格/非 ASCII 路径）
  const hostPath = fileURLToPath(new URL("./worker/host.ts", import.meta.url));

  const audit = (entry: PluginAuditEntry): void => {
    void deps.audit?.append({ ...entry, ts: Date.now() });
  };
  // 生命周期审计（install/uninstall 低频）：await 落盘后才返回——持久性优先于延迟
  const auditNow = async (entry: PluginAuditEntry): Promise<void> => {
    await deps.audit?.append({ ...entry, ts: Date.now() });
  };
  const logError = (
    plugin: string,
    phase: PluginErrorEntry["phase"],
    where: string,
    message: string,
  ): void => {
    deps.errorLog.add({ plugin, phase, where, message, ts: Date.now() });
  };
  const emitEnvelope = (kind: string, data: Record<string, unknown>): void => {
    platform.emit(pluginEvent, { plugin: "plugin-manager", kind, data, ts: Date.now() });
  };
  const installFailed = (plugin: string, detail: string): void => {
    audit({ kind: "install-failed", plugin, detail });
    emitEnvelope("install-failed", { name: plugin, detail });
  };

  /** 登记与句柄（#6：teardown 异常折算 err、remove 不因失败跳过；#14：句柄卸载经服务面锁） */
  async function register(
    name: string,
    path: string,
    mode: "process" | "worker",
    inject: readonly string[],
    teardown: () => Promise<Result<undefined, string>>,
  ): Promise<PluginHandle> {
    const unloadFn = async (): Promise<Result<undefined, string>> => {
      let result: Result<undefined, string>;
      try {
        result = await teardown();
      } catch (error) {
        result = { ok: false, reason: `unload failed: ${String(error)}` };
      }
      deps.registry.remove(name); // 登记完整性优先：失败也不卡死同名重装
      await auditNow({ kind: "uninstall", plugin: name, detail: result.ok ? undefined : "unload reported failure" });
      emitEnvelope("uninstalled", { name, outcome: result.ok });
      return result;
    };
    deps.registry.put(
      { name, path, mode, status: "active", installedAt: Date.now(), inject: [...inject] },
      unloadFn,
    );
    await auditNow({ kind: "install", plugin: name }); // 生命周期审计 await 落盘（与 uninstall 同律，保次序）
    emitEnvelope("installed", { name, path, mode });
    return {
      name,
      path,
      mode,
      // #14：句柄卸载经服务面（同名锁 + 依赖检查），不绕过互斥
      unload: (input) => uninstall(name, input),
    };
  }

  /** #5：apply 期失败留 failed 登记（成功重装覆盖；显式 uninstall 清除） */
  function registerFailure(
    name: string,
    path: string,
    mode: "process" | "worker",
    reason: string,
  ): void {
    deps.registry.put(
      { name, path, mode, status: "failed", installedAt: Date.now(), inject: [] },
      async () => {
        deps.registry.remove(name);
        audit({ kind: "uninstall", plugin: name, detail: "failed record cleared" });
        return { ok: true, value: undefined };
      },
    );
    installFailed(name, reason);
  }

  async function installProcess(
    path: string,
    plugin: Plugin,
    name: string,
  ): Promise<Result<PluginHandle, string>> {
    const scope = platform.scope({ agentId: `plugin:${name}` });
    const wrapped = wrapPluginForErrorRouting(
      plugin,
      (where, message) => logError(name, "runtime", where, message),
      platform, // 裁决 9：注册落位 root，回卷链 scope
      (token) => deps.tokenTable.set(token.name, token), // 裁决 10：token 注册表
    );
    try {
      const unloaders = await loadPlugins(scope, [wrapped]);
      const unload = unloaders[0];
      if (unload === undefined) throw new Error("unloader missing");
      return {
        ok: true,
        value: await register(name, path, "process", plugin.inject ?? [], async () => {
          await scope.dispose(); // 只回卷本插件层——平台无恙（内核容错聚合上抛，此处折算 err）
          await unload(); // composite（dispose 已跑过注册项，此处幂等兜底 apply-disposer）
          return { ok: true, value: undefined };
        }),
      };
    } catch (error) {
      await scope.dispose();
      const reason = `apply failed: ${String(error)}`;
      logError(name, "install", "apply", reason);
      registerFailure(name, path, "process", reason); // #5：失败留痕
      return { ok: false, reason };
    }
  }

  async function installWorker(
    path: string,
    replace: boolean,
  ): Promise<Result<PluginHandle, string>> {
    let bridgeName: string | undefined; // #19：未知名不碰登记簿
    const bridge = createWorkerBridge({
      pluginPath: path,
      platform,
      tokenTable: deps.tokenTable,
      applyTimeoutMs: deps.applyTimeoutMs ?? 10_000,
      runtimeTimeoutMs: deps.runtimeTimeoutMs ?? 60_000,
      kernelApiVersion,
      hostPath,
      onRuntimeError: (where, message) => logError(bridgeName ?? "unknown", "runtime", where, message),
      onKilled: (reason) => {
        logError(bridgeName ?? "unknown", "runtime", "worker", `killed: ${reason}`);
        audit({ kind: "killed", plugin: bridgeName ?? "unknown", detail: reason });
        if (bridgeName !== undefined) deps.registry.remove(bridgeName);
      },
    });
    // 三段式之一：boot + ready（apply 未跑——锁与 replace 在此窗口）
    const begun = await bridge.begin();
    if (!begun.ok) {
      await bridge.kill(`begin failed: ${begun.reason}`);
      logError("unknown", "install", "worker-boot", begun.reason);
      installFailed("unknown", begun.reason);
      return { ok: false, reason: begun.reason };
    }
    const { name, inject } = begun.value;
    bridgeName = name;
    return deps.registry.withNameLock(name, async () => {
      const existing = deps.registry.entry(name);
      if (existing !== undefined && existing.record.status === "active") {
        if (!replace) {
          await bridge.kill(`duplicate name after ready: ${name}`);
          const reason = `plugin "${name}" already installed (use replace)`;
          logError(name, "install", "conflict", reason);
          return { ok: false, reason };
        }
        const removed = await existing.unload();
        if (!removed.ok) {
          await bridge.kill(`replace unload failed: ${name}`); // #7：不泄漏已启动的新 bridge
          logError(name, "install", "replace", `old unload failed: ${removed.reason}`);
          return removed;
        }
      }
      // 三段式之二：放行 apply（新插件注册此刻才落平台——旧已卸载，无冲突窗口）
      const applied = await bridge.proceed();
      if (!applied.ok) {
        logError(name, "install", "apply", applied.reason);
        registerFailure(name, path, "worker", applied.reason); // #5
        return { ok: false, reason: applied.reason };
      }
      if (bridge.isDead()) {
        // #13：apply-done 与登记之间的窄窗退出——不做僵尸 active 登记
        const reason = "worker died right after apply";
        logError(name, "install", "race", reason);
        registerFailure(name, path, "worker", reason);
        return { ok: false, reason };
      }
      return { ok: true, value: await register(name, path, "worker", inject, () => bridge.shutdown()) };
    });
  }

  async function uninstall(name: string, input?: UninstallInput): Promise<Result<undefined, string>> {
    return deps.registry.withNameLock(name, async () => {
      const entry = deps.registry.entry(name);
      if (entry === undefined) return { ok: false, reason: `unknown plugin: ${name}` };
      if (entry.record.status === "failed") return entry.unload(); // 显式清除失败记录
      const dependents = deps.registry.dependentsOf(name);
      if (dependents.length > 0 && input?.force !== true) {
        const reason = `plugin "${name}" has dependents: ${dependents.join(", ")} (use force)`;
        logError(name, "uninstall", "uninstall-blocked", reason); // #23：phase 用 uninstall
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
      if (mode === "worker") return installWorker(path, input.replace === true);

      const mod = await loadModule(path);
      const validated = validateModule(mod, kernelApiVersion);
      if (!validated.ok) {
        // 校验失败拿不到名字：不进登记簿，只进错误日志与审计
        logError("unknown", "install", "validate", validated.reason);
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
            logError(name, "install", "conflict", reason);
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
