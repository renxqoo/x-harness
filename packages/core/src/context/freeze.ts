
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}

export function shellFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
  }
  return value;
}
