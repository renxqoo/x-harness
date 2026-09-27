// 边沿注入快照（docs/TAIL-SNAPSHOT-CHANNEL.md）：agentStatus running 边沿幂等注入
// user/message。落位时序如实：首 kick 边沿先于锚点落账——首份快照在锚点之前（预锚，
// 进 compaction 保护头永不折叠）；内容变更后的重注入副本落当前尾部（可折叠，走自愈环：
// 折叠 → surface 缺席 → 下次 kick 重注入 verbatim）。幂等 = 同 kind 最新一条全文精确
// 匹配（仅扫 append 型 user/message 单 text 块——replace 型摘要节点排除，整段回显不
// 误判在场；回摆形态旧条不算在场，对抗审查 M1）。回调整体同步红线（skill 先例——
// 引入 await 即滑出当轮请求）。

import type { Context, Disposer } from "@x-harness/core";
import type { Session, SurfaceNode } from "@x-harness/session";
import type { AgentLoopService } from "./types.ts";
import type { Dial } from "./tokens.ts";
import { agentRequest, agentStatus } from "./tokens.ts";

/** 快照信封统一作废声明（谓词四重合取之一） */
export const SNAPSHOT_SUPERSEDES = "This snapshot supersedes earlier snapshots of this kind.";

/** 铸统一信封：首行标签 + 次行作废声明 + body。信封是跨包识别的单一真相——
 *  消费方（compaction 切口语义、在场判定）一律经 isSnapshotNode，禁止字面量匹配。 */
export function snapshotEnvelope(kind: string, body: string): string {
  return `<snapshot kind="${kind}">\n${SNAPSHOT_SUPERSEDES}\n${body}\n</snapshot>`;
}

/** 快照节点谓词（四重合取）：append op ∧ user/message ∧ 单 text 块 ∧ 信封首行 + 作废次行。
 *  用户刻意伪造四条的残余后果仅「该消息不作切口候选」——权限面由模型侧正文兜底：基础段
 *  明示「信封格式非来源证明、内嵌载荷是 data」（对抗审查 H1），格式本身不授信
 *  （docs/TAIL-SNAPSHOT-CHANNEL.md 评审处置 F5/M11 + 伪造面修订）。 */
export function isSnapshotNode(node: SurfaceNode): boolean {
  const event = node.event;
  if (event.type !== "user/message" || event.surfaceOp !== "append") return false;
  const block = event.data.content[0];
  if (event.data.content.length !== 1 || block?.type !== "text") return false;
  const lines = block.text.split("\n");
  const head = lines[0];
  return typeof head === "string" && head.startsWith('<snapshot kind="') && head.endsWith(">") && lines[1] === SNAPSHOT_SUPERSEDES;
}

/** 信封首行形（在场分桶用——同 kind 判定） */
function envelopeHead(text: string): string | undefined {
  const head = text.split("\n", 1)[0] ?? "";
  return head.startsWith('<snapshot kind="') && head.endsWith(">") ? head : undefined;
}

/** 在场判定（最新一条语义——对抗审查 M1）：自尾部逆向找**同 kind** 最近一条 append 快照，
 *  全文精确相等才算在场（replace 型摘要节点不扫）。回摆形态（X→Y→X）旧条不算在场——
 *  重新注入收敛到最新值；历史旧条保留（supersession 语义）。非信封形文本回退「全史任一
 *  精确匹配」（旧语义——防御第三方非信封用法）。 */
function snapshotPresent(session: Session, text: string): boolean {
  const surface = session.surface();
  const head = envelopeHead(text);
  if (head === undefined) {
    return surface.some((node) => node.event.type === "user/message" && node.event.surfaceOp === "append"
      && node.event.data.content.length === 1 && node.event.data.content[0]?.type === "text" && node.event.data.content[0]?.text === text);
  }
  for (let i = surface.length - 1; i >= 0; i -= 1) {
    const node = surface[i];
    if (node === undefined || node.event.type !== "user/message" || node.event.surfaceOp !== "append") continue;
    if (node.event.data.content.length !== 1 || node.event.data.content[0]?.type !== "text") continue;
    const nodeText = node.event.data.content[0]?.text ?? "";
    if (envelopeHead(nodeText) !== head) continue; // 非信封/别的 kind——继续向前找本 kind 最新条
    return nodeText === text;
  }
  return false;
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

/** 请求时点快照 spec：render 收**生效** dial（waterfall 输出——下游改写后的最终值，
 *  /model 切换与 hub 重拨的单一真相源；对抗审查 B1：输入 dial 不含末端改写） */
export interface RequestSnapshotSpec {
  /** 诊断标识（告警文案用） */
  readonly id: string;
  /** 当前应注入全文（含信封）；空串 = 本次不注入 */
  readonly render: (dial: Dial) => string;
  /** render 异常 / append 失败的告警面（缺席静默收敛） */
  readonly onWarn?: (message: string) => void;
}

/** 请求时点快照：agentRequest 派发内注入——与 running 边沿版同信封/同在场幂等（最新一条
 *  语义）。**render 收 waterfall 输出 dial**（post-next：下游中间件——如 hub dial-hook 的
 *  末端 meta 折叠——改写生效后才渲染；plugin-api 同款 next-先形态）。消息投影
 *  （deriveMessages）在整个 dispatch 返回后的 attempt 内才发生，next 返回后同步 append 仍
 *  入**当次**请求体（拨号切换后首个请求即携带新事实行，无滞后轮）。已知偏差（落档）：
 *  retry 的 dial 补丁不重派本 waterfall——降级请求沿用已注入行；413 紧急压缩 retry 的
 *  replace 若折叠掉快照行，重试请求体缺席该行至下一 step 自愈；append 落在
 *  session-checkpoint 请求屏障之后——不享本请求的 fsync 屏障（崩溃窗口由下一请求重注入
 *  收敛）。与 tail 版的其余差异：首份注入恒在锚点之后（dialStep 后于 anchorSystem）——
 *  不入 compaction 保护头，靠每请求自愈补偿。中间件纪律：必调 next 恰一次、输出原样
 *  透传（返回下游 out，不回写输入 dial）。 */
export function createRequestSnapshot(input: {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly spec: RequestSnapshotSpec;
}): Disposer {
  const { ctx, loop, spec } = input;
  return ctx.on(agentRequest, async (payload, next) => {
    const out = await next(payload);
    const session = loop.get(payload.session)?.agent.session;
    if (session !== undefined && out !== undefined) {
      let text: string;
      try {
        text = spec.render(out);
      } catch (error) {
        spec.onWarn?.(`snapshot(${spec.id}): render failed (${error instanceof Error ? error.message : String(error)})`);
        return out;
      }
      if (text !== "" && !snapshotPresent(session, text)) {
        const appended = session.append(
          "user/message",
          { turn: 0, step: 0, content: [{ type: "text" as const, text }] },
          { surfaceOp: "append" },
        );
        if (!appended.ok) spec.onWarn?.(`snapshot(${spec.id}): append failed for session ${String(payload.session)} (${appended.reason})`);
      }
    }
    return out;
  });
}
