// JSON 脱钩快照——本包唯一的 JSON 值域权威（单一真相：谓词/门一律以「物化先行」取代）：
// 物化 = 单遍「读即定影即拷贝」——stateful getter 无法给校验一个值、给存储另一个值；
// 稀疏数组 / 原型污染（含 {__proto__: X} 字面量）/ Symbol 键 / 显式 undefined / 非有限数与 -0 一律拒绝
// （JSON.stringify 会把它们静默改写：洞→null、NaN/Infinity→null、-0→0、Symbol 键→丢弃）；
// JSON 来源的 __proto__ 自有键经 defineProperty 落为自有键，不污染原型。

export function materializeJson(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("not-json");
    return value;
  }
  if (typeof value !== "object") throw new Error("not-json"); // undefined / function / symbol / bigint
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("not-json"); // 稀疏数组（洞）
    return value.map((item) => materializeJson(item));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error("not-json"); // Date/Map/类实例/原型污染
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("not-json"); // Symbol 键会被 JSON 静默丢弃
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
