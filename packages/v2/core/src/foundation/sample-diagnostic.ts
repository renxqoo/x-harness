import type { JsonValue } from "../contracts/types";

export function sampleDiagnostic<T>(
  values: Iterable<T>,
  project: (value: T) => JsonValue,
): JsonValue {
  let total = 0;
  const items: JsonValue[] = [];

  for (const value of values) {
    total += 1;

    if (items.length < 8) items.push(project(value));
  }

  return { total, omitted: total - items.length, items };
}
