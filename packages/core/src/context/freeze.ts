// 冻结策略（docs/CONTEXT.md §2.3）：deep = 递归冻结（原对象冻结，非拷贝）；
// shell = 只冻一级字段（信封类：plugin/event 壳冻结、data 原引用——信任边界）。
// 覆盖范围为 plain object 与 array；Map/Set/Date 等容器只冻结外壳（§2.3 容器边界）；
// 环引用安全（seen 集终止）；预冻结外壳不阻断子代递归（对抗审查 #2 修复）。

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
