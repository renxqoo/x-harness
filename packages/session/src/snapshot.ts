// JSON 脱钩快照：事件收养/落账前物化为纯 JSON 值（docs/SESSION.md §1.3）。
// 目的：调用方对象不被就地冻结（脱钩）、getter 不稳定值被一次性定影（TOCTOU 关闭）、
// 字面 __proto__ 键经 defineProperty 落为自有键（不污染原型）。输入须先过 isJsonSafe 门。

export function materializeJson(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") throw new Error("not-json");
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("not-json"); // 稀疏数组（洞）
    return value.map((item) => materializeJson(item));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error("not-json");
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
