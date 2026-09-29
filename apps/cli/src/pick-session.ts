import type { SessionHeader, SessionId } from "@x-harness/session";

const MAX_SHOWN = 15;

export function formatSessionList(headers: readonly SessionHeader[]): readonly string[] {
  return headers.slice(0, MAX_SHOWN).map((header, index) => {
    const when = new Date(header.createdAt).toISOString().replace("T", " ").slice(0, 16);
    return `${String(index + 1)}. ${header.id}  ${when}`;
  });
}

export interface QuestionFace {
  (prompt: string): Promise<string | undefined>;
}

export async function pickIndex(count: number, question: QuestionFace): Promise<number | undefined> {
  const answer = await question("number (enter to cancel): ");
  const trimmed = answer?.trim() ?? "";
  if (trimmed === "") return undefined;
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) return undefined;
  return index - 1;
}

export async function pickSession(headers: readonly SessionHeader[], question: QuestionFace): Promise<SessionId | undefined> {
  const shown = headers.slice(0, MAX_SHOWN);
  const index = await pickIndex(shown.length, question);
  return index === undefined ? undefined : shown[index]?.id;
}
