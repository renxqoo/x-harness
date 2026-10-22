import type { ExecutionError } from "../../execution/src/index";

export function fail(code: ExecutionError["code"]) {
  return { ok: false as const, error: { source: "execution" as const, code, message: code } };
}
