// plugin-manager 契约（docs/PLUGIN-MANAGER.md §1.1，v2 完整形态）。
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
  /** 按名取 token（消费面：跨模块 token 身份的注册表——插件 provide/on 的 token 均登记） */
  token(name: string): AnyToken | undefined;
  /** 服务的类型化糖：token(name) 且 kind === "service" */
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

/** 审计持久化端口（缺省实现：JSONL 追加文件） */
export interface AuditPort {
  append(entry: PluginAuditEntry & { readonly ts: number }): Promise<void>;
}

export interface CreatePluginManagerDeps {
  readonly ctx: Context;
  /** 安装白名单目录（绝对路径；install 的 path 必须落在某一 root 之下） */
  readonly roots: readonly string[];
  /** 执行模式缺省（install 可逐次覆盖） */
  readonly mode?: ExecMode;
  /** 审批门：缺省全拒（agent 自写自装必须人确认——PLUGIN-MANAGER.md 裁决 2）。
   *  import 前调用（pluginName 此时未知，按路径/来源决策）。 */
  readonly approveInstall?: (input: { readonly path: string }) => boolean | Promise<boolean>;
  readonly errorLogLimit?: number;
  readonly audit?: AuditPort;
  /** worker 模式 apply 超时（缺省 10s；超时 terminate = 装载失败） */
  readonly applyTimeoutMs?: number;
  /** worker 模式单次 RPC 超时（缺省 60s；超时 = 击杀 + 记录 + 平台继续） */
  readonly runtimeTimeoutMs?: number;
  /** P1 引擎层强制点：vendor 根内路径恒 worker 模式（process 请求 = 装载拒） */
  readonly vendorRoots?: readonly string[];
  /** worker 模式可桥接 token 白名单（内核词表自动含）；未注册 token 的监听 = 装载拒 */
  readonly tokens?: readonly AnyToken[];
  /** 内核 API 版本门（缺省 1；manifest.apiVersion 不匹配 = 拒） */
  readonly kernelApiVersion?: number;
  /** 模块加载器（测试注入；缺省动态 import + query 缓存 bust） */
  readonly loadModule?: (path: string) => Promise<unknown>;
}

/** 模块形状校验的产物 */
export interface ValidatedModule {
  readonly plugin: Plugin;
  readonly apiVersion?: number;
}
