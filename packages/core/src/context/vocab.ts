// 内核自举词表 + 通用信封（docs/CONTEXT.md §6.1）——Context 自身拥有的 5 个 token。
// 词表封闭性由测试锁死（导出常量集合 == 文档词表，双向）。

import { defineEvent } from "./tokens.ts";

export const serviceProvided = defineEvent<{ readonly service: string }>("service/provided");
export const pluginLoaded = defineEvent<{ readonly plugin: string }>("plugin/loaded");
export const pluginError = defineEvent<{ readonly plugin: string; readonly error: string }>(
  "plugin/error",
);
export const contextDisposing = defineEvent<Record<string, never>>("context/disposing");

/** 插件瞬时观察信封：壳冻结（一级字段），data 保持原引用——信任边界（§2.3） */
export const pluginEvent = defineEvent<{
  readonly plugin: string;
  readonly kind: string;
  readonly data: unknown;
  readonly ts: number;
}>("plugin/event", { freeze: "shell" });
