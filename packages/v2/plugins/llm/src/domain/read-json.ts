import { readData } from "../../../../core/src/validation";
import type { JsonValue } from "../../../../core/src/index";
import type { LlmResult } from "../contracts";
import { fail } from "./fail";

export function readLlmJson(
  raw: unknown,
  limits: { readonly maxBytes: number; readonly maxDepth?: number; readonly maxNodes?: number },
): LlmResult<JsonValue> {
  let bytes = 0;
  let nodes = 0;
  const path = new Set<object>();

  const charge = (size: number) => {
    bytes += size;
    return bytes <= limits.maxBytes;
  };

  const string = (value: string) => {
    if (!charge(2) || value.length > limits.maxBytes) return false;

    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      let size = 3;

      if (code < 32) {
        size = [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      } else if (code === 34 || code === 92) size = 2;
      else if (code < 128) size = 1;
      else if (code < 2048) size = 2;
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        size = 4;
        i++;
      } else if (code >= 0xd800 && code <= 0xdfff) size = 6;

      if (!charge(size)) return false;
    }

    return true;
  };

  const visit = (value: unknown, depth: number): LlmResult<JsonValue> => {
    if (++nodes > (limits.maxNodes ?? 100000) || depth > (limits.maxDepth ?? 32))
      return fail("invalid-input");

    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
    )
      return charge(JSON.stringify(value).length) ? { ok: true, value } : fail("capacity-exceeded");

    if (typeof value === "string")
      return string(value) ? { ok: true, value } : fail("capacity-exceeded");

    if (!value || typeof value !== "object" || path.has(value)) return fail("invalid-input");

    if (!charge(2)) return fail("capacity-exceeded");

    path.add(value);

    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const size = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;

      if (
        !Number.isSafeInteger(size) ||
        (size as number) < 0 ||
        (size as number) > (limits.maxNodes ?? 100000) ||
        keys.length !== (size as number) + 1
      )
        return fail("invalid-input");

      const output: JsonValue[] = [];

      for (let i = 0; i < (size as number); i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));

        if (!descriptor || !("value" in descriptor)) return fail("invalid-input");

        if (i && !charge(1)) return fail("capacity-exceeded");

        const child = visit(descriptor.value, depth + 1);

        if (!child.ok) return child;

        output.push(child.value);
      }

      path.delete(value);
      return { ok: true, value: Object.freeze(output) };
    }

    const read = readData(value);

    if (!read.ok) return fail("invalid-input");

    const output: Record<string, JsonValue> = Object.create(null);
    let index = 0;

    for (const [key, item] of Object.entries(read.value)) {
      if (!string(key) || !charge(1 + Number(index++ > 0))) return fail("capacity-exceeded");

      const child = visit(item, depth + 1);

      if (!child.ok) return child;

      output[key] = child.value;
    }

    path.delete(value);
    return { ok: true, value: Object.freeze(output) };
  };

  try {
    return visit(raw, 0);
  } catch {
    return fail("invalid-input");
  }
}
