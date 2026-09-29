export function materializeJson(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("not-json");
    return value;
  }
  if (typeof value !== "object") throw new Error("not-json");
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("not-json");
    return value.map((item) => materializeJson(item));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error("not-json");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("not-json");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: materializeJson((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
