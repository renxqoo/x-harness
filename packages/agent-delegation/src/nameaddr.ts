// 寻址解析（docs/AGENT-DELEGATION.md §5.2）：to 的唯一解析真源。
// C 阶段形态：main / agentId 精确 / name [ref] 消歧 / 裸名 latest-wins；
// 跨进程 box 域与 archive 惰性重建在后续阶段接入同入口。

import type { SessionId } from "@x-harness/session";
import { refOfAgentId } from "./lineage.ts";
import type { ChildRow, Lineage } from "./lineage.ts";

export type Resolution =
  | { readonly kind: "row"; readonly row: ChildRow }
  | { readonly kind: "main"; readonly parent: SessionId }
  | { readonly kind: "miss"; readonly reason: string };

const AGENT_ID = /^agent-[0-9a-f]+$/;
const WITH_REF = /^(.+) \[([0-9a-f]{6})\]$/;

export function resolveAddress(lineage: Lineage, caller: SessionId, to: string): Resolution {
  if (to === "main") {
    const callerRow = lineage.bySession(caller);
    // main 仅后台子代理可用（规格 :190）——根会话无父可回
    if (callerRow === undefined) return { kind: "miss", reason: "invalid-args:to 'main' is only available to background sub-agents" };
    return { kind: "main", parent: callerRow.parent };
  }
  if (AGENT_ID.test(to)) {
    const row = lineage.get(to);
    // agentId 不跨重启复活——名字才跨重启（§5.2-2）
    return row === undefined ? { kind: "miss", reason: `not-found:${to}; use list_agents to see your sub-agents` } : { kind: "row", row };
  }
  const refHit = WITH_REF.exec(to);
  if (refHit !== null) {
    const name = refHit[1] as string;
    const ref = refHit[2] as string;
    const hits = lineage.liveByName(name).filter((row) => refOfAgentId(row.agentId) === ref);
    if (hits.length === 1) return { kind: "row", row: hits[0] as ChildRow };
    return { kind: "miss", reason: notFoundWithRefs(lineage, name) };
  }
  // 裸名：latest-wins（规格 :194——同名最新 spawn 者；[ref] 供精确寻址）
  const rows = lineage.liveByName(to);
  if (rows.length === 0) return { kind: "miss", reason: `not-found:${to}; use list_agents to see your sub-agents` };
  return { kind: "row", row: rows[rows.length - 1] as ChildRow };
}

function notFoundWithRefs(lineage: Lineage, name: string): string {
  const refs = lineage.liveByName(name).map((row) => `[${refOfAgentId(row.agentId)}]`);
  return refs.length === 0
    ? `not-found:${name}; use list_agents to see your sub-agents`
    : `not-found:'${name} [ref]'; available refs for '${name}': ${refs.join(" ")}`;
}
