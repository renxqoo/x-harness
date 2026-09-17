
import { defineEvent } from "./tokens.ts";

export const serviceProvided = defineEvent<{ readonly service: string }>("service/provided");
export const pluginLoaded = defineEvent<{ readonly plugin: string }>("plugin/loaded");
/** 卸载完成（含部分失败）——与 plugin/loaded 成对（C12 成对律） */
export const pluginUnloaded = defineEvent<{ readonly plugin: string }>("plugin/unloaded");
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
