// 内核级 Result 判别联合：业务失败走返回值不走异常（仓库铁律）。
export type Result<T, E = string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: E };
