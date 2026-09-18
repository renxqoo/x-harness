// 收件箱投影（docs/AGENT-LOOP-DRIVER.md §1.3）：agent/inbox/spliced 事件的纯函数折叠。
// 判重按「当前在场」——claim 移除后同 id 再 insert 重新入队（repair 回灌依赖）。

import type { ContentBlock, InboxEntry, InboxTarget, SessionEvent, SessionId } from "@x-harness/session";

export interface InboxState {
  readonly nextTurn: readonly InboxEntry[];
  readonly nextStep: readonly InboxEntry[];
}

export function foldInbox(events: readonly SessionEvent[]): InboxState {
  const nextTurn: InboxEntry[] = [];
  const nextStep: InboxEntry[] = [];
  const present = (id: string): boolean => nextTurn.some((e) => e.id === id) || nextStep.some((e) => e.id === id);
  const remove = (id: string): void => {
    for (let i = nextTurn.length - 1; i >= 0; i--) if ((nextTurn[i] as InboxEntry).id === id) nextTurn.splice(i, 1);
    for (let i = nextStep.length - 1; i >= 0; i--) if ((nextStep[i] as InboxEntry).id === id) nextStep.splice(i, 1);
  };
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced") continue;
    const data = event.data;
    if (data.op === "insert") {
      for (const entry of data.entries) if (!present(entry.id)) (data.target === "next-turn" ? nextTurn : nextStep).push(entry);
    } else if (data.op === "claim") {
      for (const id of data.claimed) remove(id);
    } else {
      nextTurn.length = 0;
      nextStep.length = 0;
    }
  }
  return { nextTurn, nextStep };
}

/** insert 事件 data 构造（id 铸 uuid；单事件批量） */
export function insertData(target: InboxTarget, contents: readonly ContentBlock[]): {
  readonly op: "insert";
  readonly target: InboxTarget;
  readonly entries: InboxEntry[];
} {
  return {
    op: "insert",
    target,
    entries: contents.map((content) => ({ id: crypto.randomUUID(), content: [content] })),
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
