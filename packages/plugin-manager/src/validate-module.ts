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


const SDK_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^"'`]*from\s*["'](@x-harness\/[^"']+)["']/;
const SDK_DYNAMIC_IMPORT_RE = /import\s*\(\s*["'](@x-harness\/[^"']+)["']\s*\)/;

export interface ThirdPartyManifest {
  readonly name: string;
  readonly apiVersion: number;
  readonly kind: "third-party";
  readonly description?: string;
  readonly entry?: string;
}

export interface ThirdPartyInspectResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly manifest?: ThirdPartyManifest;
}

export function validateThirdPartyManifest(value: unknown): Result<ThirdPartyManifest, string> {
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: "manifest must be an object" };
  }
  const m = value as Record<string, unknown>;
  if (typeof m["name"] !== "string" || m["name"].length === 0) {
    return { ok: false, reason: "manifest.name must be a non-empty string" };
  }
  if (m["kind"] !== "third-party") {
    return { ok: false, reason: 'manifest.kind must be "third-party"' };
  }
  if (typeof m["apiVersion"] !== "number" || !Number.isInteger(m["apiVersion"])) {
    return { ok: false, reason: "manifest.apiVersion must be an integer" };
  }
  if (m["description"] !== undefined && typeof m["description"] !== "string") {
    return { ok: false, reason: "manifest.description must be a string when present" };
  }
  if (m["entry"] !== undefined && (typeof m["entry"] !== "string" || m["entry"].length === 0)) {
    return { ok: false, reason: "manifest.entry must be a non-empty string when present" };
  }
  return {
    ok: true,
    value: {
      name: m["name"],
      apiVersion: m["apiVersion"],
      kind: "third-party",
      ...(m["description"] !== undefined ? { description: m["description"] } : {}),
      ...(m["entry"] !== undefined ? { entry: m["entry"] } : {}),
    },
  };
}

export function scanSourceForSdkImports(source: string): string[] {
  const found: string[] = [];
  const staticMatch = SDK_IMPORT_RE.exec(source);
  if (staticMatch?.[1] !== undefined) found.push(staticMatch[1]);
  const dynamicMatch = SDK_DYNAMIC_IMPORT_RE.exec(source);
  if (dynamicMatch?.[1] !== undefined) found.push(dynamicMatch[1]);
  return [...new Set(found)];
}

export function inspectThirdParty(input: {
  readonly manifest: unknown;
  readonly sources: readonly { readonly path: string; readonly source: string }[];
}): ThirdPartyInspectResult {
  const manifest = validateThirdPartyManifest(input.manifest);
  if (!manifest.ok) return { ok: false, reason: manifest.reason };
  for (const file of input.sources) {
    const hits = scanSourceForSdkImports(file.source);
    if (hits.length > 0) {
      return {
        ok: false,
        reason: `${file.path}: bare @x-harness import not allowed in third-party plugin (${hits.join(", ")})`,
      };
    }
  }
  return { ok: true, manifest: manifest.value };
}
