import { readData, readJsonValue } from "../../../core/src/validation";
import type { ProcessRunner } from "./types";
import { fail } from "./fail";
export interface ProcessBackend {
  readonly name: string;
  readonly isolation: "none" | "seatbelt-single-process";
  readonly systemReadRoots?: readonly string[];
  readonly run: ProcessRunner;
}

export function readBackend(raw: unknown) {
  const parsed = readData(raw);

  if (!parsed.ok) return fail("invalid-input");

  const d = parsed.value,
    roots = readJsonValue(d.systemReadRoots ?? []);

  if (
    Object.keys(d).some((k) => !["name", "isolation", "systemReadRoots", "run"].includes(k)) ||
    typeof d.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(d.name) ||
    !["none", "seatbelt-single-process"].includes(d.isolation as string) ||
    typeof d.run !== "function" ||
    !roots.ok ||
    !Array.isArray(roots.value) ||
    roots.value.length > 32 ||
    roots.value.some((p) => typeof p !== "string" || !p.startsWith("/") || p.includes("\0"))
  )
    return fail("invalid-input");

  return {
    ok: true as const,
    value: {
      name: d.name,
      isolation: d.isolation as ProcessBackend["isolation"],
      systemReadRoots: roots.value as string[],
      run: d.run as ProcessRunner,
    },
  };
}
