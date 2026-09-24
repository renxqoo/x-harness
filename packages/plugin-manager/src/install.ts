// 装载编排（docs/PLUGIN-MANAGER.md §1.2，审查批次修复后）：
// ① roots 校验 → ② 审批（import 前）→ ③ 模块加载 + 形状/版本校验 →
// ④ per-name 互斥 + 冲突/replace → ⑤ 模式分派 → ⑥ 登记/审计/信封。
// worker 三段式（#1/#7/#16）：begin（boot+ready，apply 未跑）→ 锁内 replace/冲突 → proceed → register。
// 落位纪律（裁决 9）：process 注册落平台 root，disposer 链回插件 scope。

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

/** P1 引擎层强制点：vendor 根内路径恒 worker 模式（编排层覆写是第一层，此处第二层——
 * 不可信代码即使绕过编排层也进不了主进程） */
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
  // 首次加载 plain import（与宿主共享模块身份——token 对象同一）；同路径重装才 query bust
  const loadCounts = new Map<string, number>();
  const loadModule =
    deps.loadModule ??
    ((path: string) => {
      const count = (loadCounts.get(path) ?? 0) + 1;
      loadCounts.set(path, count);
      return count === 1 ? import(path) : import(`${path}?pmv=${count}`);
    });
  // #15：percent-encoding 解码（含空格/非 ASCII 路径）。
  // 形态约束：host.ts 必须是磁盘真实文件（worker spawn 的物理前提）——dist 多文件
  // 形态（--external @x-harness/*）经 node_modules 链解析到源码，天然满足；编译
  // 单文件形态（plugin-manager 被内联进可执行体）该文件不在磁盘 → worker 装载
  // 明确拒绝（报错优于 spawn 挂死——boot 超时兜底的主动化）。探测按安装器实例
  // 一次（同步 exists 延迟到 installWorker 首次调用也可，此处装载期一次性即可）。
  const hostPath = fileURLToPath(new URL("./worker/host.ts", import.meta.url));

  const audit = (entry: PluginAuditEntry): void => {
    void deps.audit?.append({ ...entry, ts: Date.now() });
  };
  // 生命周期审计（install/uninstall 低频）：await 落盘后才返回——持久性优先于延迟
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

  /** 登记入参（#6：teardown 异常折算 err、remove 不因失败跳过；#14：句柄卸载经服务面锁） */
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
      deps.registry.remove(name); // 登记完整性优先：失败也不卡死同名重装
      await auditNow({ kind: "uninstall", plugin: name, detail: result.ok ? undefined : "unload reported failure" });
      emitEnvelope("uninstalled", { name, outcome: result.ok });
      return result;
    };
    deps.registry.put(
      { name, path, mode, status: "active", installedAt: Date.now(), inject: [...inject] },
      unloadFn,
      owner,
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

  /** #5：apply 期失败留 failed 登记（成功重装覆盖；显式 uninstall 清除）——owner 用新鲜对象，任何桥击杀都碰不到它 */
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
    // 裁决 10：token 注册表——本插件提供的 token 收集在案，卸载时按身份清理（与 worker 桥同语义）
    const provided: { name: string; token: AnyToken }[] = [];
    // caps.provide 与 wrapper provide 两路共用：collision 门 + provided 账本（卸载清理闭环）
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
      root: platform, // 裁决 9：注册落位 root，回卷链 scope
      onToken: (token) => {
        // F0.5 词表治理：同名异体 = 跨模块 token 身份分裂（消费方 use 不到提供方）——fail-closed
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
        await scope.dispose(); // 只回卷本插件层——平台无恙（内核容错聚合上抛，此处折算 err）
        await unload(); // composite（dispose 已跑过注册项，此处幂等兜底 apply-disposer）
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
      cleanupTokens(); // apply 失败同样不留 token 残留
      const reason = `apply failed: ${String(error)}`;
      logError({ plugin: name, phase: "install", where: "apply", message: reason });
      registerFailure({ name, path, mode: "process", reason }); // #5：失败留痕
      return { ok: false, reason };
    }
  }

  async function installWorker(
    path: string,
    replace: boolean,
  ): Promise<Result<PluginHandle, string>> {
    // #19：未知名不碰登记簿——桥名 ready 后才可知，用 const 壳承载可变位
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
        // 收殓按桥身份删登记（removeIfOwned）：只删「本桥注册的 active 登记」——
        // apply 期击杀时 registerFailure 已留 failed 痕（#5 律：重装覆盖/显式卸载清除），
        // 同名被拒不碰在运行老插件，晚到击杀不误删继任者
        if (bridgeIdentity.name !== undefined) {
          deps.registry.removeIfOwned(bridgeIdentity.name, teardown);
        }
      },
    });
    const teardown = (): Promise<Result<undefined, string>> => bridge.shutdown();
    // 三段式之一：boot + ready（apply 未跑——锁与 replace 在此窗口）
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
          await bridge.kill(`replace unload failed: ${name}`); // #7：不泄漏已启动的新 bridge
          logError({
            plugin: name,
            phase: "install",
            where: "replace",
            message: `old unload failed: ${removed.reason}`,
          });
          return removed;
        }
      }
      // 三段式之二：放行 apply（新插件注册此刻才落平台——旧已卸载，无冲突窗口）
      const applied = await bridge.proceed();
      if (!applied.ok) {
        logError({ plugin: name, phase: "install", where: "apply", message: applied.reason });
        registerFailure({ name, path, mode: "worker", reason: applied.reason }); // #5
        return { ok: false, reason: applied.reason };
      }
      if (bridge.isDead()) {
        // #13：apply-done 与登记之间的窄窗退出——不做僵尸 active 登记
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
      if (entry.record.status === "failed") return entry.unload(); // 显式清除失败记录
      const dependents = deps.registry.dependentsOf(name);
      if (dependents.length > 0 && input?.force !== true) {
        const reason = `plugin "${name}" has dependents: ${dependents.join(", ")} (use force)`;
        logError({ plugin: name, phase: "uninstall", where: "uninstall-blocked", message: reason }); // #23：phase 用 uninstall
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
        // 校验失败拿不到名字：不进登记簿，只进错误日志与审计
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
