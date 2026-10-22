import { readData, readJsonValue } from "../../../core/src/validation";
import type { ProcessExecutionOptions, ProcessLimits } from "./types";
import { fail } from "./fail";
const defaults: ProcessLimits = {
  maxActiveRequests: 8,
  timeoutMs: 60000,
  maxOutputBytes: 1048576,
  maxScanEntries: 10000,
};
const maximum: ProcessLimits = {
  maxActiveRequests: 128,
  timeoutMs: 1800000,
  maxOutputBytes: 16777216,
  maxScanEntries: 100000,
};

export function readOptions(raw: unknown) {
  const parsed = readJsonValue(raw);

  if (!parsed.ok) return fail("invalid-input");

  const data = readData(parsed.value);

  if (!data.ok || Object.keys(data.value).some((k) => !["profiles", "limits"].includes(k)))
    return fail("invalid-input");

  const profiles = readData(data.value.profiles),
    limits = readData(data.value.limits ?? {});

  if (
    !profiles.ok ||
    Object.keys(profiles.value).length < 1 ||
    Object.keys(profiles.value).length > 32 ||
    !limits.ok
  )
    return fail("invalid-input");

  const output = { ...defaults };

  for (const [key, value] of Object.entries(limits.value)) {
    if (
      !Object.hasOwn(maximum, key) ||
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > maximum[key as keyof ProcessLimits]
    )
      return fail("invalid-input");

    output[key as keyof ProcessLimits] = value as number;
  }

  for (const [name, profile] of Object.entries(profiles.value)) {
    const p = readData(profile);

    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ||
      !p.ok ||
      Object.keys(p.value).some(
        (k) => !["cwd", "readRoots", "writeRoots", "env", "allowEnv", "allowedDomains"].includes(k),
      ) ||
      typeof p.value.cwd !== "string" ||
      !p.value.cwd.startsWith("/") ||
      p.value.cwd.length > 4096
    )
      return fail("invalid-input");

    for (const key of ["readRoots", "writeRoots", "allowEnv", "allowedDomains"]) {
      const values = p.value[key];

      if (
        values !== undefined &&
        (!Array.isArray(values) ||
          values.length > 32 ||
          values.some((v) => typeof v !== "string" || !v.length || v.length > 4096))
      )
        return fail("invalid-input");
    }

    if (
      p.value.allowEnv !== undefined &&
      (p.value.allowEnv as string[]).some((k) => !/^[_A-Za-z][_A-Za-z0-9]*$/.test(k))
    )
      return fail("invalid-input");

    if (
      p.value.allowedDomains !== undefined &&
      (p.value.allowedDomains as string[]).some(
        (k) =>
          k.includes("\0") ||
          !/^([a-zA-Z0-9][a-zA-Z0-9.-]*|\*\.[a-zA-Z0-9][a-zA-Z0-9.-]*)$/.test(k),
      )
    )
      return fail("invalid-input");

    const env = readData(p.value.env ?? {});

    if (
      !env.ok ||
      Object.entries(env.value).some(
        ([key, v]) =>
          !/^[_A-Za-z][_A-Za-z0-9]*$/.test(key) || typeof v !== "string" || v.includes("\0"),
      )
    )
      return fail("invalid-input");
  }

  return {
    ok: true as const,
    value: {
      profiles: profiles.value as unknown as ProcessExecutionOptions["profiles"],
      limits: Object.freeze(output),
    },
  };
}
