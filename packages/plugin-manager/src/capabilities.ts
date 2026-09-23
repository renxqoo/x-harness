// 能力注入面（B 路线）：第三方插件零 `@x-harness/*` import，apply 第二参收按名
// facade。token 解析全部收敛到 tokenTable 单点（名字 → 真 token → 真 ctx 调用），
// 插件侧只见纯业务接口。
//
// 元能力排除（安全不变式）：插件装卸与内核生命周期事件对第三方件不可见——
// caps.use/tryUse/on 对 META_TOKEN_NAMES 恒缺席/拒收。第三方件不能经 caps 装卸
// 插件、不能监听装载生命周期干扰平台。
//
// 错误面：垃圾输入（未知名）按「能力缺席」语义处理——use 抛（与 ctx.use 缺席
// 同语义）、tryUse 返 undefined；provide 同名异体在 install.ts collision 门拦截，
// 此处不重复（onToken 回调仍是单一强制点）。

import type { AnyToken, Context, Disposer, EventToken, ServiceToken } from "@x-harness/core";
import { defineEvent, defineService } from "@x-harness/core";

/** caps 面恒不可见的元能力名：插件装卸服务 + 内核装载/生命周期事件词表 */
export const META_TOKEN_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    "plugin-manager",
    "service/provided",
    "plugin/loaded",
    "plugin/unloaded",
    "plugin/error",
    "context/disposing",
    "plugin/event",
  ]),
);

/** use 的未知名/元能力名报错口径（与 ctx.use 缺席语义对齐，附名字便于排障） */
export class CapabilityNameError extends Error {
  constructor(name: string) {
    super(`capability not available: "${name}"`);
  }
}

/** 按名合成 token：worker 桥语义——身份不过线，双侧各自解析（名字是唯一载体） */
const serviceTokens = new Map<string, ServiceToken<unknown>>();
const eventTokens = new Map<string, EventToken<unknown>>();

export function syntheticServiceToken(name: string): ServiceToken<unknown> {
  const found = serviceTokens.get(name);
  if (found !== undefined) return found;
  const token = defineService<unknown>(name);
  serviceTokens.set(name, token);
  return token;
}

export function syntheticEventToken(name: string): EventToken<unknown> {
  const found = eventTokens.get(name);
  if (found !== undefined) return found;
  const token = defineEvent<unknown>(name);
  eventTokens.set(name, token);
  return token;
}

/** 第三方插件能力面：apply(ctx, capabilities) 第二参 */
export interface PluginCapabilities {
  /** 按名取平台服务（缺席 = throw，与 ctx.use 同语义） */
  use<T = unknown>(name: string): T;
  /** 按名试探平台服务（缺席 = undefined） */
  tryUse<T = unknown>(name: string): T | undefined;
  /** 按名停靠等待平台服务出现 */
  waitFor<T = unknown>(name: string): Promise<T>;
  /** 提供服务：名字进 tokenTable（onToken 收集 + collision 门在装载层） */
  provide<T = unknown>(name: string, impl: T): Disposer;
  /** 监听事件（emit 模式）；元能力名拒收 */
  on(name: string, listener: (payload: unknown) => void): Disposer;
  /** 发出事件 */
  emit(name: string, payload: unknown): void;
}

/** caps 组装依赖：名字解析（tokenTable）、调用落位（真 ctx 或 worker bridged ctx）、token 收集 */
export interface CapabilitiesDeps {
  /** 名字 → token；缺席（含元能力排除）由本模块判定 */
  readonly resolveToken: (name: string) => AnyToken | undefined;
  /** 服务取用落位：process = platform.use/tryUse/waitFor；worker = bridged ctx（RPC 桥） */
  readonly useToken: (token: ServiceToken<unknown>) => unknown;
  readonly tryUseToken: (token: ServiceToken<unknown>) => unknown | undefined;
  readonly waitForToken: (token: ServiceToken<unknown>) => Promise<unknown>;
  /** provide 落位（真 ctx.provide——main 侧平台 root 或 worker 侧 provided 桥） */
  readonly provideToken: (token: ServiceToken<unknown>, impl: unknown) => Disposer;
  /** 事件监听落位 */
  readonly onToken: (token: EventToken<unknown>, listener: (payload: unknown) => void) => Disposer;
  /** 事件发出落位 */
  readonly emitToken: (token: EventToken<unknown>, payload: unknown) => void;
}

const isMeta = (name: string): boolean => META_TOKEN_NAMES.has(name);

export function createCapabilities(deps: CapabilitiesDeps): PluginCapabilities {
  return {
    use<T>(name: string): T {
      if (isMeta(name)) throw new CapabilityNameError(name);
      const token = deps.resolveToken(name);
      if (token === undefined || token.kind !== "service") throw new CapabilityNameError(name);
      return deps.useToken(token as ServiceToken<unknown>) as T;
    },
    tryUse<T>(name: string): T | undefined {
      if (isMeta(name)) return undefined;
      const token = deps.resolveToken(name);
      if (token === undefined || token.kind !== "service") return undefined;
      return deps.tryUseToken(token as ServiceToken<unknown>) as T | undefined;
    },
    waitFor<T>(name: string): Promise<T> {
      if (isMeta(name)) return Promise.reject(new CapabilityNameError(name));
      const token = deps.resolveToken(name);
      if (token === undefined || token.kind !== "service") {
        return Promise.reject(new CapabilityNameError(name));
      }
      return deps.waitForToken(token as ServiceToken<unknown>) as Promise<T>;
    },
    provide<T>(name: string, impl: T): Disposer {
      if (isMeta(name)) throw new CapabilityNameError(name);
      if (name.length === 0) throw new CapabilityNameError(name);
      return deps.provideToken(syntheticServiceToken(name), impl as unknown);
    },
    on(name: string, listener: (payload: unknown) => void): Disposer {
      if (isMeta(name)) throw new CapabilityNameError(name);
      return deps.onToken(syntheticEventToken(name), listener);
    },
    emit(name: string, payload: unknown): void {
      if (isMeta(name)) throw new CapabilityNameError(name);
      deps.emitToken(syntheticEventToken(name), payload);
    },
  };
}

/** process 模式 caps：tokenTable 真 token 直连平台 ctx */
export function createProcessCapabilities(
  platform: Context,
  tokenTable: Map<string, AnyToken>,
  onToken: (token: AnyToken) => void,
): PluginCapabilities {
  return createCapabilities({
    resolveToken: (name) => tokenTable.get(name),
    useToken: (token) => platform.use(token),
    tryUseToken: (token) => platform.tryUse(token),
    waitForToken: (token) => platform.waitFor(token),
    provideToken: (token, impl) => {
      onToken(token);
      return platform.provide(token, impl);
    },
    onToken: (token, listener) =>
      (platform.on as (t: AnyToken, f: unknown) => Disposer)(token, listener),
    emitToken: (token, payload) => platform.emit(token, payload),
  });
}
