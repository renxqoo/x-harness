import type { ToolCapacity } from "./types";
import { capacityCells } from "./shared";
import { fail } from "../domain/fail";

export function readCapacities(raw: unknown) {
  if (raw === undefined)
    return { ok: true as const, value: Object.freeze([]) as readonly ToolCapacity[] };

  try {
    if (!Array.isArray(raw)) return fail("invalid-input");

    const length = Object.getOwnPropertyDescriptor(raw, "length")?.value as unknown;

    if (!Number.isSafeInteger(length) || (length as number) > 8 || (length as number) < 0)
      return fail("invalid-input");

    const keys = Reflect.ownKeys(raw);

    if (
      keys.length !== (length as number) + 1 ||
      keys.some((k) => typeof k !== "string" || (k !== "length" && !/^(0|[1-9][0-9]*)$/.test(k)))
    )
      return fail("invalid-input");

    const values: ToolCapacity[] = [];

    for (let i = 0; i < (length as number); i++) {
      const d = Object.getOwnPropertyDescriptor(raw, String(i));

      if (!d || !("value" in d) || !capacityCells.has(d.value as ToolCapacity))
        return fail("invalid-input");

      values.push(d.value as ToolCapacity);
    }

    return { ok: true as const, value: Object.freeze(values) };
  } catch {
    return fail("invalid-input");
  }
}
