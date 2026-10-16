import type { RegistrationOptions, Result } from "./types";
import { readData } from "./read-data";
import { createFault } from "./create-fault";

export function readRegistrationOptions(input: unknown): Result<RegistrationOptions> {
  const parsed = readData(input ?? {});
  if (!parsed.ok || Object.keys(parsed.value).some((key) => key !== "shadow") ||
      (parsed.value.shadow !== undefined && typeof parsed.value.shadow !== "boolean")) return createFault("invalid-input");
  return { ok: true, value: Object.freeze(parsed.value) };
}
