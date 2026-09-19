// L1 无损清理（docs/COMPACTION.md §1.2；参照系 scavenger 移植，落账改写为
// tool/result 单点 replace——同 callId/turn/step 占位、保留 isError，配对不变量不破坏）：
// 白名单 + 在飞轮整轮豁免 + keepRecent 按条保底 + 占位幂等 + path 提取。
// write 恒豁免（回执不变量：L1-only 路径无文件账本兜底，模型对自己刚写过的东西
// 必须有回执）。占位文案英文（模型可见文本纪律）。

import type { Session, SessionEvent, SurfaceNode } from "@x-harness/session";
import { isTurnStartNode } from "@x-harness/compaction";
import { estimateText } from "@x-harness/token-meter";

/** 占位幂等标记前缀（二次计划对已清理结果跳过） */
export const PLACEHOLDER_PREFIX = "[cleared:";

export interface ClearPlanEntry {
  /** tool/result 节点 seq（落账 replace 端点） */
  readonly seq: number;
  readonly callId: string;
  readonly toolName: string;
  readonly placeholder: string;
  readonly originalTokens: number;
}

export interface ClearPlan {
  readonly entries: readonly ClearPlanEntry[];
  readonly gainTokens: number;
}

export interface ScavengerConfig {
  readonly clearableTools: readonly string[];
  readonly clearKeepRecent: number;
}

/** callId → 工具名/入参关联（tool/call 事件回查——tool/result 本身不带工具名） */
function toolCallsOf(events: readonly SessionEvent[]): Map<string, { name: string; arguments: string }> {
  const byId = new Map<string, { name: string; arguments: string }>();
  for (const event of events) {
    if (event.type === "tool/call") byId.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments });
  }
  return byId;
}

/** 占位 path 提取：参数 JSON 的 path 字段；bash 取命令首 token + cwd；无则 <no-path> */
function extractPath(toolName: string, rawArgs: string): string {
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch {
    /* 垃圾入参降级 */
  }
  if (typeof fields["path"] === "string" && fields["path"] !== "") return fields["path"];
  if (toolName === "bash") {
    const command = typeof fields["command"] === "string" ? fields["command"] : "";
    const head = command.split(/\s+/)[0] ?? "";
    const cwd = typeof fields["cwd"] === "string" ? fields["cwd"] : "";
    if (head !== "") return cwd !== "" ? `${head} (${cwd})` : head;
  }
  return "<no-path>";
}

/** 末个真轮起点节点下标（在飞轮边界——其前结果才可清理） */
export function lastTurnStartIndex(nodes: readonly SurfaceNode[]): number {
  let last = -1;
  for (const [i, node] of nodes.entries()) {
    if (isTurnStartNode(node)) last = i;
  }
  return last;
}

/** computeClearPlan：候选 = 白名单工具、在飞轮之前、未占位、非空内容；自尾向首
 *  keepRecent 条豁免，其余进 plan（纯函数——后台算而未落） */
export function computeClearPlan(nodes: readonly SurfaceNode[], events: readonly SessionEvent[], config: ScavengerConfig): ClearPlan {
  const lastStart = lastTurnStartIndex(nodes);
  if (lastStart <= 0) return { entries: [], gainTokens: 0 };
  const calls = toolCallsOf(events);
  const eligible: ClearPlanEntry[] = [];
  for (let i = lastStart - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node === undefined || node.event.type !== "tool/result") continue;
    const data = node.event.data;
    const call = calls.get(data.callId);
    if (call === undefined || !config.clearableTools.includes(call.name)) continue;
    if (data.content.startsWith(PLACEHOLDER_PREFIX)) continue; // 已占位（幂等）
    if (data.content === "") continue;
    const tokens = estimateText(data.content);
    eligible.push({
      seq: node.seq,
      callId: data.callId,
      toolName: call.name,
      placeholder: `[cleared: ${call.name} ${extractPath(call.name, call.arguments)} ${String(data.content.length)} chars]`,
      originalTokens: tokens,
    });
  }
  const entries = eligible.slice(config.clearKeepRecent);
  return { entries, gainTokens: gainTokensOf(entries) };
}

/** 收益单份口径：逐条 estimateText 求和（CJK 上界——预门槛消费同一收益） */
export function gainTokensOf(entries: readonly ClearPlanEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.originalTokens, 0);
}

export interface LandL1Result {
  readonly landed: number;
  readonly gainTokens: number;
}

/** L1 落账：逐条 replace [seq,seq] 以占位文案（同 callId/turn/step、保留 isError）。
 *  部分失败即停（前缀部分占位无害——幂等标记使续跑跳过已清条目） */
export function landClearPlan(session: Session, nodes: readonly SurfaceNode[], entries: readonly ClearPlanEntry[]): LandL1Result {
  const bySeq = new Map<number, SurfaceNode>();
  for (const node of nodes) bySeq.set(node.seq, node);
  let landed = 0;
  let gainTokens = 0;
  for (const entry of entries) {
    const node = bySeq.get(entry.seq);
    if (node === undefined || node.event.type !== "tool/result") continue;
    const data = node.event.data;
    const appended = session.append(
      "tool/result",
      {
        turn: data.turn,
        step: data.step,
        callId: data.callId,
        content: entry.placeholder,
        ...(data.isError !== undefined ? { isError: data.isError } : {}),
      },
      { surfaceOp: { op: "replace", startSeq: entry.seq, endSeq: entry.seq } },
    );
    if (!appended.ok) break;
    landed += 1;
    gainTokens += entry.originalTokens;
  }
  return { landed, gainTokens };
}
