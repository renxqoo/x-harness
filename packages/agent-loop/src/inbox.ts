// 收件箱投影（docs/AGENT-LOOP-DRIVER.md §1.3）：agent/inbox/spliced 事件的纯函数折叠。
// 判重按「当前在场」——claim 移除后同 id 再 insert 重新入队（repair 回灌依赖）。

import type { AgentMessageKind, ContentBlock, InboxEntry, InboxTarget, SessionEvent, SessionId } from "@x-harness/session";

export interface InboxState {
  readonly nextTurn: readonly InboxEntry[];
  readonly nextStep: readonly InboxEntry[];
}

/** 目标队列名 → 可变数组引用（fold 内部队列寻址）。 */
function queueOf(state: InboxState, target: "next-turn" | "next-step"): InboxEntry[] {
  return target === "next-turn" ? (state.nextTurn as InboxEntry[]) : (state.nextStep as InboxEntry[]);
}

/** 单条移除：仅目标队列（未知 id 幂等忽略）。 */
function dropEntries(state: InboxState, data: { readonly target: "next-turn" | "next-step"; readonly dropped: readonly string[] }): void {
  const queue = queueOf(state, data.target);
  for (const id of data.dropped) {
    const at = queue.findIndex((entry) => entry.id === id);
    if (at >= 0) queue.splice(at, 1);
  }
}

/** 单条改道：entry 本体与 id 原样在双队列间移动（未知 id 幂等忽略）。 */
function retargetEntry(state: InboxState, data: { readonly id: string; readonly to: "next-turn" | "next-step" }): void {
  let from: InboxEntry[] | undefined;
  if (state.nextTurn.some((entry) => entry.id === data.id)) from = queueOf(state, "next-turn");
  else if (state.nextStep.some((entry) => entry.id === data.id)) from = queueOf(state, "next-step");
  if (from === undefined) return;
  const at = from.findIndex((entry) => entry.id === data.id);
  const [entry] = from.splice(at, 1);
  if (entry !== undefined) queueOf(state, data.to).push(entry);
}

export function foldInbox(events: readonly SessionEvent[]): InboxState {
  const nextTurn: InboxEntry[] = [];
  const nextStep: InboxEntry[] = [];
  const state: InboxState = { nextTurn, nextStep };
  const present = (id: string): boolean => nextTurn.some((e) => e.id === id) || nextStep.some((e) => e.id === id);
  const remove = (id: string): void => {
    for (let i = nextTurn.length - 1; i >= 0; i--) if (nextTurn[i]?.id === id) nextTurn.splice(i, 1);
    for (let i = nextStep.length - 1; i >= 0; i--) if (nextStep[i]?.id === id) nextStep.splice(i, 1);
  };
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced") continue;
    const data = event.data;
    if (data.op === "insert") {
      for (const entry of data.entries) if (!present(entry.id)) queueOf(state, data.target).push(entry);
    } else if (data.op === "claim") {
      for (const id of data.claimed) remove(id);
    } else if (data.op === "drop") {
      dropEntries(state, data);
    } else if (data.op === "retarget") {
      retargetEntry(state, data);
    } else {
      nextTurn.length = 0;
      nextStep.length = 0;
    }
  }
  return state;
}

/** insert 事件 data 构造（id 铸 uuid；每次 splice 单 entry 全块——图文必须同 entry
 *  同轮消费：claimTurnBatch 的 next-turn 只领队首，逐块分目会把后续块拆到链式后续轮）。
 *  origin 在场 = 材料化标记：领取时落 agent/message（docs/AGENT-MESSAGE.md §4 场景 C），
 *  排队/唤醒语义与普通条目一致 */
export function insertData(
  target: InboxTarget,
  contents: readonly ContentBlock[],
  origin?: { readonly source: string; readonly kind: AgentMessageKind },
): {
  readonly op: "insert";
  readonly target: InboxTarget;
  readonly entries: InboxEntry[];
} {
  return {
    op: "insert",
    target,
    entries: contents.length === 0 ? [] : [{ id: crypto.randomUUID(), content: contents, ...(origin !== undefined ? { origin } : {}) }],
  };
}

/** step0 领取：next-turn 队首 + next-step 全部 */
export function claimTurnBatch(state: InboxState): { readonly entries: readonly InboxEntry[]; readonly claimed: readonly string[] } {
  const entries = [...(state.nextTurn.length > 0 ? [state.nextTurn[0] as InboxEntry] : []), ...state.nextStep];
  return { entries, claimed: entries.map((entry) => entry.id) };
}

/** 后续步领取：next-step 全部 */
export function claimStepBatch(state: InboxState): { readonly entries: readonly InboxEntry[]; readonly claimed: readonly string[] } {
  return { entries: [...state.nextStep], claimed: state.nextStep.map((entry) => entry.id) };
}

export type { SessionId };
