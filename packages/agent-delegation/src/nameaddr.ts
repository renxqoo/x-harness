// 寻址解析（docs/AGENT-DELEGATION.md §5.2——修订A「去名」）：to 的唯一解析真源。
// 形态收敛为 main / agentId 精确（跨进程 box 域与 archive 按 agentId 复活在 verbs 回退链接入）。

import type { SessionId } from "@x-harness/session";
import type { ChildRow, Lineage } from "./lineage.ts";

export type Resolution =
  | { readonly kind: "row"; readonly row: ChildRow }
  | { readonly kind: "main"; readonly parent: SessionId }
  | { readonly kind: "miss"; readonly reason: string };

const AGENT_ID = /^agent-[0-9a-f]+$/;

export function resolveAddress(lineage: Lineage, caller: SessionId, to: string): Resolution {
  if (to === "main") {
    const callerRow = lineage.bySession(caller);
    // main 仅后台子代理可用（规格 :190）——根会话无父可回
    if (callerRow === undefined) return { kind: "miss", reason: "invalid-args:to 'main' is only available to background sub-agents" };
    return { kind: "main", parent: callerRow.parent };
  }
  if (AGENT_ID.test(to)) {
    const row = lineage.get(to);
    return row === undefined ? { kind: "miss", reason: `not-found:${to}` } : { kind: "row", row };
  }
  return { kind: "miss", reason: `not-found:${to}; agent ids look like 'agent-<hex>' (from agent_spawn), or 'main', or a local session name` };
}
