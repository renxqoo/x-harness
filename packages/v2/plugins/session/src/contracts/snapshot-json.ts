import type { JsonValue } from "../../../../core/src/index";
import type { SessionResult } from "./types";
import { fail } from "../domain/fail";

export function snapshotJson(
  input: unknown,
  budget: number,
): SessionResult<{ value: JsonValue; json: string; bytes: number }> {
  const path = new Set<object>();
  const invalid = Symbol();
  const capacity = Symbol();
  let nodes = 0;
  let bytes = 0;

  const charge = (size: number) => {
    bytes += size;

    if (bytes > budget) throw capacity;
  };

  const string = (value: string) => {
    charge(2);

    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);

      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) charge(2);
      else if (code < 32) charge(6);
      else if (code < 128) charge(1);
      else if (code < 2048) charge(2);
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        charge(4);
        i++;
      } else if (code >= 0xd800 && code <= 0xdfff) charge(6);
      else charge(3);
    }
  };

  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > 100000 || depth > 32) throw invalid;

    if (value === null) {
      charge(4);
      return value;
    }

    if (typeof value === "boolean") {
      charge(value ? 4 : 5);
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
      charge(JSON.stringify(value).length);
      return value;
    }

    if (typeof value === "string") {
      string(value);
      return value;
    }

    if (!value || typeof value !== "object" || path.has(value)) throw invalid;

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);

    if (!array && prototype !== Object.prototype && prototype !== null) throw invalid;

    const keys = Reflect.ownKeys(value);

    if (keys.length > 100000 || keys.some((key) => typeof key !== "string")) throw invalid;

    path.add(value);
    charge(2);

    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;

      if (
        !Number.isSafeInteger(length) ||
        (length as number) < 0 ||
        keys.length !== (length as number) + 1
      )
        throw invalid;

      const output: JsonValue[] = [];

      for (let i = 0; i < (length as number); i++) {
        if (i) charge(1);

        output.push(visit(data(value, String(i)), depth + 1));
      }

      path.delete(value);
      return Object.freeze(output);
    }

    const output: Record<string, JsonValue> = Object.create(null);
    let index = 0;

    for (const key of (keys as string[]).sort()) {
      if (index++) charge(1);

      string(key);
      charge(1);
      output[key] = visit(data(value, key), depth + 1);
    }

    path.delete(value);
    return Object.freeze(output);
  };

  try {
    const value = visit(input, 0);
    return { ok: true, value: { value, json: JSON.stringify(value), bytes } };
  } catch (error) {
    return fail(error === capacity ? "capacity-exceeded" : "invalid-input");
  }
}

function data(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);

  if (!property || !("value" in property)) throw undefined;

  return property.value;
}
