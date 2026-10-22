import { readData } from "../../../../core/src/validation";

export function data(raw: unknown) {
  const read = readData(raw);
  return read.ok ? read.value : undefined;
}

export function keys(raw: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(raw).every((key) => allowed.includes(key));
}

export function text(raw: unknown, limit = 256): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= limit;
}

export function count(raw: unknown): raw is number {
  return Number.isSafeInteger(raw) && (raw as number) >= 0;
}
