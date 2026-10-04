import type { Context, Disposer } from "@x-harness/core";
import { agentMessageData } from "@x-harness/session";
import type { ContentBlock, Session, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import type { AgentLoopService } from "./types.ts";
import type { Dial } from "./tokens.ts";
import { agentRequest, agentStatus } from "./tokens.ts";

export const SNAPSHOT_SUPERSEDES = "This snapshot supersedes earlier snapshots of this kind.";

/** 注入快照的写入身份（agent/message 的 source 单一真相）。注入上下文不借 user/message
 *  形态落盘：客户端按事件类型过滤，不做信封文本启发——用户气泡的身份收敛（乐观回显 ↔
 *  权威落账按 WAL seq 配对）不再被外来「用户消息」帧打断（docs/sdk/DESIGN.md §3.5.1）。 */
export const SNAPSHOT_SOURCE = "context-snapshot";

export function snapshotEnvelope(kind: string, body: string): string {
  return `<snapshot kind="${kind}">\n${SNAPSHOT_SUPERSEDES}\n${body}\n</snapshot>`;
}

/** 信封形态快照事件（append op ∧ user/message ∧ 单 text 块 ∧ 信封首行 + 作废次行）。
 *  历史 WAL 的落盘形态：读既有会话（标题派生、切点对齐）时按此判据识别注入，
 *  禁止本地字面量匹配。新写入一律 agent/message(SNAPSHOT_SOURCE)——本谓词不是
 *  新数据的身份判据，客户端不得据此渲染注入内容。 */
export function isEnvelopeSnapshotEvent(event: SessionEvent): boolean {
  if (event.type !== "user/message" || event.surfaceOp !== "append") return false;
  const block = event.data.content[0];
  if (event.data.content.length !== 1 || block?.type !== "text") return false;
  const lines = block.text.split("\n");
  const head = lines[0];
  return typeof head === "string" && head.startsWith('<snapshot kind="') && head.endsWith(">") && lines[1] === SNAPSHOT_SUPERSEDES;
}

/** 信封形态快照节点：即事件谓词（单一实现——两份字面量会漂移） */
export function isEnvelopeSnapshotNode(node: SurfaceNode): boolean {
  return isEnvelopeSnapshotEvent(node.event);
}

function singleTextBlock(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined;
  const block = content[0];
  return block?.type === "text" ? block.text : undefined;
}

/** 注入快照文本（两种落盘形态同一读取口）：agent/message(SNAPSHOT_SOURCE) 与信封形态 user/message。 */
function injectedSnapshotText(event: SessionEvent): string | undefined {
  if (event.type === "agent/message") {
    return event.data.source === SNAPSHOT_SOURCE ? singleTextBlock(event.data.content) : undefined;
  }
  if (event.type !== "user/message" || !isEnvelopeSnapshotEvent(event)) return undefined;
  return singleTextBlock(event.data.content);
}

function envelopeKindOf(text: string): string | undefined {
  const head = text.split("\n", 1)[0] ?? "";
  return head.startsWith('<snapshot kind="') && head.endsWith(">") ? head : undefined;
}

/** 同 kind 的最新一条在场即不再注入（信封次行声明「本类快照以最新一条为准」：
 *  回摆重注入必须发生——旧的同 kind 条在场不能当作当前值）。 */
function snapshotPresent(session: Session, text: string): boolean {
  const head = envelopeKindOf(text);
  const surface = session.surface();
  for (let i = surface.length - 1; i >= 0; i -= 1) {
    const node = surface[i];
    const nodeText = node === undefined ? undefined : injectedSnapshotText(node.event);
    if (nodeText === undefined) continue;
    if (head !== undefined && envelopeKindOf(nodeText) !== head) continue;
    return nodeText === text;
  }
  return false;
}

function appendSnapshot(session: Session, text: string): string | undefined {
  const appended = session.append(
    "agent/message",
    agentMessageData({ turn: 0, step: 0, source: SNAPSHOT_SOURCE, kind: "content", content: [{ type: "text", text }] }),
    { surfaceOp: "append" },
  );
  return appended.ok ? undefined : appended.reason;
}

export interface TailSnapshotSpec {
  readonly id: string;
  readonly render: (session: SessionId) => string;
  readonly onWarn?: (message: string) => void;
}

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
      text = spec.render(payload.session);
    } catch (error) {
      spec.onWarn?.(`snapshot(${spec.id}): render failed (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (text === "") return;
    if (snapshotPresent(session, text)) return;
    const reason = appendSnapshot(session, text);
    if (reason !== undefined) spec.onWarn?.(`snapshot(${spec.id}): append failed for session ${String(payload.session)} (${reason})`);
  });
}

export interface RequestSnapshotSpec {
  readonly id: string;
  readonly render: (dial: Dial) => string;
  readonly onWarn?: (message: string) => void;
}

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
        const reason = appendSnapshot(session, text);
        if (reason !== undefined) spec.onWarn?.(`snapshot(${spec.id}): append failed for session ${String(payload.session)} (${reason})`);
      }
    }
    return out;
  });
}
