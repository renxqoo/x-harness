import type { JsonValue } from "../../../../core/src/index";
export function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true; if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]!));
  const first = left as Readonly<Record<string, JsonValue>>; const second = right as Readonly<Record<string, JsonValue>>; const keys = Object.keys(first); return keys.length === Object.keys(second).length && keys.every((key) => Object.hasOwn(second, key) && equalJson(first[key]!, second[key]!));
}
