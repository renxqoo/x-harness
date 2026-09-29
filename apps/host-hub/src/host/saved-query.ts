import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import type { SessionEvent, SessionHeader } from "@x-harness/session";
import { foldDial, foldMeta } from "../shared/meta-fold.ts";
import { DIRECT_READ_MAX_BYTES } from "../shared/limits.ts";
import { hubLog } from "../shared/hub-log.ts";

export interface SavedSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  model?: string;
  cwd?: string;
  forkParent?: string;
  messageCount: number;
  lastSeq: number;
}

const TITLE_DERIVED_CAP = 80;

function derivedTitle(events: readonly SessionEvent[]): string {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const text = event.data.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim() !== "") return text.slice(0, TITLE_DERIVED_CAP);
  }
  return "";
}

function foldSummary(header: SessionHeader, events: readonly SessionEvent[]): SavedSession {
  const meta = foldMeta(events);
  const last = events[events.length - 1];
  const dial = foldDial(events, { provider: "", model: "" });
  return {
    id: String(header.id),
    createdAt: header.createdAt,
    updatedAt: last?.time ?? header.createdAt,
    title: typeof meta["title"] === "string" && meta["title"] !== "" ? meta["title"] : derivedTitle(events),
    ...(dial.model !== "" ? { model: dial.model } : {}),
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.parentSession !== undefined ? { forkParent: String(header.parentSession) } : {}),
    messageCount: events.filter((event) => event.type === "user/message" || event.type === "assistant/message").length,
    lastSeq: events.length - 1,
  };
}

function volumeBytes(events: readonly SessionEvent[]): number {
  let size = 0;
  for (const event of events) size += JSON.stringify(event).length;
  return size;
}

export async function listSavedSessions(sessionsRoot: string, query: { cwd?: string } = {}): Promise<SavedSession[]> {
  const reader = createArchiveReader(sessionsRoot);
  const headers = await reader.listHeaders().catch(() => []);
  const out: SavedSession[] = [];
  for (const header of headers) {
    if (header.agentId !== undefined) continue;
    if (query.cwd !== undefined && header.cwd !== query.cwd) continue;
    const snapshot = await reader.read(header.id).catch(() => undefined);
    if (snapshot === undefined || !snapshot.ok) {
      hubLog(`list_saved: unreadable archive skipped (${String(header.id)})`);
      continue;
    }
    if (volumeBytes(snapshot.value.events) > DIRECT_READ_MAX_BYTES) {
      hubLog(`list_saved: archive exceeds direct-read cap (${String(header.id)})`);
      continue;
    }
    out.push(foldSummary(header, snapshot.value.events));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
