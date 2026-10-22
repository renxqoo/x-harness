import type { ToolsError, ToolsResult } from "../contracts/types";

export function fail(code: ToolsError["code"]): ToolsResult<never> {
  return { ok: false, error: Object.freeze({ source: "tools", code, message: code }) };
}
