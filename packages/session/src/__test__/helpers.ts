import type { Result } from "@x-harness/core";
import type { SessionId } from "../types.ts";

/** 测试用 Result 解包：失败即抛（测试内失败路径另行显式断言） */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

export function sid(id: string): SessionId {
  return id as SessionId;
}
