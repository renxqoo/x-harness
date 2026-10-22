import { readData } from "../../../../core/src/validation";
import type { SessionResult } from "../contracts/types";
import { fail } from "./fail";

export function readInput(
  input: unknown,
  allowed: readonly string[],
): SessionResult<Record<string, unknown>> {
  const read = readData(input);

  if (!read.ok || Object.keys(read.value).some((key) => !allowed.includes(key)))
    return fail("invalid-input");

  return read;
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
}
