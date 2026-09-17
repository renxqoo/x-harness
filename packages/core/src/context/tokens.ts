// token 铸造（docs/CONTEXT.md §2.1）：模式编码在 token、泛型即载荷——注册即类型（C1）。
// 同名 token 重复 define 合法（跨插件隔离域：注册表按 token 对象为键，同名不同对象互不可见）。

import type {
  EventToken,
  FreezeMode,
  GuardToken,
  ParallelToken,
  SerialToken,
  ServiceToken,
  WaterfallToken,
} from "./types.ts";

function assertTokenName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("token name must be a non-empty string");
  }
}

export function defineService<T>(name: string): ServiceToken<T> {
  assertTokenName(name);
  return Object.freeze({ kind: "service", name }) as ServiceToken<T>;
}

/** freeze 缺省 "deep"；"shell" = 信封类（壳冻结、data 原引用）；"none" = 高频豁免（§2.3） */
export function defineEvent<T>(
  name: string,
  opts?: { freeze?: FreezeMode },
): EventToken<T> {
  assertTokenName(name);
  return Object.freeze({
    kind: "event",
    mode: "emit",
    name,
    freeze: opts?.freeze ?? "deep",
  }) as EventToken<T>;
}

export function defineWaterfall<I, O>(name: string): WaterfallToken<I, O> {
  assertTokenName(name);
  return Object.freeze({ kind: "waterfall", mode: "waterfall", name }) as WaterfallToken<I, O>;
}

export function defineSerial<T>(name: string): SerialToken<T> {
  assertTokenName(name);
  return Object.freeze({ kind: "serial", mode: "serial", name }) as SerialToken<T>;
}

export function defineGuard<T>(name: string): GuardToken<T> {
  assertTokenName(name);
  return Object.freeze({ kind: "guard", mode: "guard", name }) as GuardToken<T>;
}

export function defineParallel<T>(name: string): ParallelToken<T> {
  assertTokenName(name);
  return Object.freeze({ kind: "parallel", mode: "parallel", name }) as ParallelToken<T>;
}
