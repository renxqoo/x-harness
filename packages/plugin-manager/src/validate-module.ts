// 模块形状校验 + 版本门（docs/PLUGIN-MANAGER.md 裁决 6）。

import type { Plugin } from "@x-harness/core";
import type { Result, ValidatedModule } from "./types.ts";

export function validateModule(
  mod: unknown,
  kernelApiVersion: number,
): Result<ValidatedModule, string> {
  if (mod === null || typeof mod !== "object") {
    return { ok: false, reason: "module has no default/plugin export of Plugin shape" };
  }
  const holder = mod as { default?: unknown; plugin?: unknown };
  const candidate = (holder.default ?? holder.plugin) as
    | { name?: unknown; apply?: unknown; apiVersion?: unknown }
    | undefined;
  if (candidate === undefined || typeof candidate !== "object") {
    return { ok: false, reason: "module default export is not a Plugin" };
  }
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    return { ok: false, reason: "plugin.name must be a non-empty string" };
  }
  if (typeof candidate.apply !== "function") {
    return { ok: false, reason: "plugin.apply must be a function" };
  }
  const apiVersion = candidate.apiVersion;
  if (apiVersion !== undefined) {
    if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion)) {
      return { ok: false, reason: "plugin.apiVersion must be an integer when declared" };
    }
    if (apiVersion !== kernelApiVersion) {
      return {
        ok: false,
        reason: `plugin apiVersion ${apiVersion} does not match kernel ${kernelApiVersion}`,
      };
    }
  }
  return {
    ok: true,
    value: {
      plugin: candidate as unknown as Plugin,
      apiVersion: apiVersion as number | undefined,
    },
  };
}
