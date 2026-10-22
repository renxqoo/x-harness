import { readData } from "../../../../core/src/validation";

export function data(raw: unknown) {
  const parsed = readData(raw);
  return parsed.ok ? parsed.value : undefined;
}

export function keys(raw: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(raw).every((key) => allowed.includes(key));
}

export function integer(raw: unknown, min: number, max: number): raw is number {
  return Number.isSafeInteger(raw) && (raw as number) >= min && (raw as number) <= max;
}

export function id(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128;
}

export function name(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(raw);
}
