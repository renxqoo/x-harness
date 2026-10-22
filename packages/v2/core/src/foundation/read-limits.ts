import type { Limits, Result } from "../contracts/types";
import { createFault } from "../contracts/create-fault";
import { readData } from "../contracts/read-data";
import { defaultLimits } from "./default-limits";

export function readLimits(input: unknown, ceiling?: Limits): Result<Limits> {
  const limits = { ...(ceiling ?? defaultLimits) };

  if (input === undefined) return { ok: true, value: Object.freeze(limits) };

  const read = readData(input);

  if (!read.ok) return read;

  for (const [key, value] of Object.entries(read.value)) {
    if (
      !Object.hasOwn(defaultLimits, key) ||
      !Number.isSafeInteger(value) ||
      (value as number) <= 0
    )
      return createFault("invalid-input");

    const field = key as keyof Limits;

    if (ceiling && (value as number) > ceiling[field]) return createFault("invalid-input");

    limits[field] = value as number;
  }

  return { ok: true, value: Object.freeze(limits) };
}
