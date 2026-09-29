import type { AgentMessageKind, ContentBlock, InboxEntry, InboxTarget, SessionEvent, SessionId } from "@x-harness/session";

export interface InboxState {
  readonly nextTurn: readonly InboxEntry[];
  readonly nextStep: readonly InboxEntry[];
}

function queueOf(state: InboxState, target: "next-turn" | "next-step"): InboxEntry[] {
  return target === "next-turn" ? (state.nextTurn as InboxEntry[]) : (state.nextStep as InboxEntry[]);
}

function dropEntries(state: InboxState, data: { readonly target: "next-turn" | "next-step"; readonly dropped: readonly string[] }): void {
  const queue = queueOf(state, data.target);
  for (const id of data.dropped) {
    const at = queue.findIndex((entry) => entry.id === id);
    if (at >= 0) queue.splice(at, 1);
  }
}

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

/** 前导 origin 同批领取上限（超出留队下轮——零丢失，只防单批材料化撑爆） */
export const LEADING_ORIGIN_BATCH_LIMIT = 8;

/** 条目是否携带内部注入标记（origin 在场 = harness 注入，非用户输入） */
export function isOriginEntry(entry: InboxEntry): boolean {
  return entry.origin !== undefined;
}

/** next-turn 侧领取批：前导 origin 条目（≤上限）+ 首条非 origin 条目；无非 origin 存货时不领 next-turn 侧。
 *  next-step 侧语义不变（全领）。纯函数，供 claimTurnBatch 与 blocked 回灌共用同一规则。 */
export function turnClaimBatch(nextTurn: readonly InboxEntry[]): readonly InboxEntry[] {
  const batch: InboxEntry[] = [];
  let originCount = 0;
  for (const entry of nextTurn) {
    if (isOriginEntry(entry)) {
      if (originCount >= LEADING_ORIGIN_BATCH_LIMIT) continue;
      originCount += 1;
      batch.push(entry);
      continue;
    }
    batch.push(entry);
    break;
  }
  if (batch.length > 0 && !batch.some((entry) => !isOriginEntry(entry))) return [];
  return batch;
}

export function claimTurnBatch(state: InboxState): { readonly entries: readonly InboxEntry[]; readonly claimed: readonly string[] } {
  const entries = [...turnClaimBatch(state.nextTurn), ...state.nextStep];
  return { entries, claimed: entries.map((entry) => entry.id) };
}

export function claimStepBatch(state: InboxState): { readonly entries: readonly InboxEntry[]; readonly claimed: readonly string[] } {
  return { entries: [...state.nextStep], claimed: state.nextStep.map((entry) => entry.id) };
}

export type { SessionId };
