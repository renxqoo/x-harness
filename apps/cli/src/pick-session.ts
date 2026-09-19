// 会话编号选择（docs/CLI.md §2.3）：/resume 与 --resume 共用；readline 提问注入。
// 列最新 N 条主会话，输入序号选择；空行/EOF = 取消（返回 undefined）。

import type { SessionHeader, SessionId } from "@x-harness/session";

const MAX_SHOWN = 15;

export function formatSessionList(headers: readonly SessionHeader[]): readonly string[] {
  return headers.slice(0, MAX_SHOWN).map((header, index) => {
    const when = new Date(header.createdAt).toISOString().replace("T", " ").slice(0, 16);
    const agent = header.agentId === undefined ? "" : ` [${header.agentType ?? "agent"}]`;
    return `${String(index + 1)}. ${header.id}  ${when}${agent}`;
  });
}

export interface QuestionFace {
  (prompt: string): Promise<string | undefined>;
}

/** 通用序号选择：合法序号（1..count）→ index-1；空行/垃圾/越界 → undefined */
export async function pickIndex(count: number, question: QuestionFace): Promise<number | undefined> {
  const answer = await question("number (enter to cancel): ");
  const trimmed = answer?.trim() ?? "";
  if (trimmed === "") return undefined;
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) return undefined;
  return index - 1;
}

/** 会话选择（列表展示归 formatSessionList，这里只做选择） */
export async function pickSession(headers: readonly SessionHeader[], question: QuestionFace): Promise<SessionId | undefined> {
  const shown = headers.slice(0, MAX_SHOWN);
  const index = await pickIndex(shown.length, question);
  return index === undefined ? undefined : shown[index]?.id;
}
