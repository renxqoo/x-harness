// 边沿注入快照（docs/TAIL-SNAPSHOT-CHANNEL.md）：agentStatus running 边沿幂等注入
// user/message。落位时序如实：首 kick 边沿先于锚点落账——首份快照在锚点之前（预锚，
// 进 compaction 保护头永不折叠）；内容变更后的重注入副本落当前尾部（可折叠，走自愈环：
// 折叠 → surface 缺席 → 下次 kick 重注入 verbatim）。幂等 = 内容维精确匹配（仅扫
// append 型 user/message 单 text 块——replace 型摘要节点排除，整段回显不误判在场）。
// 回调整体同步红线（skill 先例——引入 await 即滑出当轮请求）。

import type { Context, Disposer } from "@x-harness/core";
import type { Session, SurfaceNode } from "@x-harness/session";
import type { AgentLoopService } from "./types.ts";
import { agentStatus } from "./tokens.ts";

/** 快照信封统一作废声明（谓词四重合取之一） */
export const SNAPSHOT_SUPERSEDES = "This snapshot supersedes earlier snapshots of this kind.";

/** 铸统一信封：首行标签 + 次行作废声明 + body。信封是跨包识别的单一真相——
 *  消费方（compaction 切口语义、在场判定）一律经 isSnapshotNode，禁止字面量匹配。 */
export function snapshotEnvelope(kind: string, body: string): string {
  return `<snapshot kind="${kind}">\n${SNAPSHOT_SUPERSEDES}\n${body}\n</snapshot>`;
}

/** 快照节点谓词（四重合取）：append op ∧ user/message ∧ 单 text 块 ∧ 信封首行 + 作废次行。
 *  用户刻意伪造四条的残余后果仅「该消息不作切口候选」——保守方向无安全面
 *  （docs/TAIL-SNAPSHOT-CHANNEL.md 评审处置 F5/M11）。 */
export function isSnapshotNode(node: SurfaceNode): boolean {
  const event = node.event;
  if (event.type !== "user/message" || event.surfaceOp !== "append") return false;
  const block = event.data.content[0];
  if (event.data.content.length !== 1 || block?.type !== "text") return false;
  const lines = block.text.split("\n");
  const head = lines[0];
  return typeof head === "string" && head.startsWith('<snapshot kind="') && head.endsWith(">") && lines[1] === SNAPSHOT_SUPERSEDES;
}

/** 在场判定：append 型 user/message 单 text 块与全文精确相等（replace 型摘要节点不扫） */
function snapshotPresent(session: Session, text: string): boolean {
  return session.surface().some((node) => {
    if (node.event.type !== "user/message" || node.event.surfaceOp !== "append") return false;
    const block = node.event.data.content[0];
    return node.event.data.content.length === 1 && block?.type === "text" && block.text === text;
  });
}

export interface TailSnapshotSpec {
  /** 诊断标识（告警文案用） */
  readonly id: string;
  /** 当前应注入全文（含信封）；空串 = 本次不注入 */
  readonly render: () => string;
  /** render 异常 / append 失败的告警面（缺席静默收敛） */
  readonly onWarn?: (message: string) => void;
}

/** running 边沿幂等注入：render 异常告警不炸；在场跳过；缺席 append（turn/step 元数据
 *  对齐 skill 现状——位置由 append 决定，本轮请求即携带）。 */
export function createTailSnapshot(input: {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly spec: TailSnapshotSpec;
}): Disposer {
  const { ctx, loop, spec } = input;
  return ctx.on(agentStatus, (payload) => {
    if (payload.status !== "running") return;
    const session = loop.get(payload.session)?.agent.session;
    if (session === undefined) return;
    let text: string;
    try {
      text = spec.render();
    } catch (error) {
      spec.onWarn?.(`snapshot(${spec.id}): render failed (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (text === "") return;
    if (snapshotPresent(session, text)) return;
    const appended = session.append(
      "user/message",
      { turn: 0, step: 0, content: [{ type: "text" as const, text }] },
      { surfaceOp: "append" },
    );
    if (!appended.ok) spec.onWarn?.(`snapshot(${spec.id}): append failed for session ${String(payload.session)} (${appended.reason})`);
  });
}
