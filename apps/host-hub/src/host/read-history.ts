import { realpath } from "node:fs/promises";
import { isSafeSessionId } from "@x-harness/session";
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import type { SessionEvent } from "@x-harness/session";
import { foldQueue } from "../shared/inbox-fold.ts";
import { foldDial } from "../shared/meta-fold.ts";
import { titleOf } from "../worker/meta-state.ts";
import { entryWindowViewed, type EntryLine } from "../worker/entries-window.ts";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { DIRECT_READ_MAX_BYTES } from "../shared/limits.ts";

export interface FenceResult {
  ok: true;
  threadId: string;
  sessionPath: string;
}

export async function fenceSessionPath(sessionPath: string, sessionsRoot: string): Promise<FenceResult | { ok: false; reason: HubErrorShape }> {
  if (!sessionPath.startsWith("/")) {
    return { ok: false, reason: hubError("path_forbidden", "session path outside sessions dir: absolute path required") };
  }
  const parts = sessionPath.split("/");
  const file = parts.at(-1);
  const id = parts.at(-2) ?? "";
  if (file !== "events.jsonl" || !isSafeSessionId(id)) {
    return { ok: false, reason: hubError("path_forbidden", "session path outside sessions dir: malformed layout") };
  }
  const root = await realpath(sessionsRoot).catch(() => sessionsRoot);
  const real = await realpath(sessionPath).catch(() => undefined);
  if (real !== undefined && !real.startsWith(`${root}/`)) {
    return { ok: false, reason: hubError("path_forbidden", "session path outside sessions dir: symlink escape") };
  }
  return { ok: true, threadId: id, sessionPath };
}

export interface DirectReadDeps {
  sessionsRoot: string;
}

interface LoadedArchive {
  events: readonly SessionEvent[];
  sizeBytes: number;
}

export function createDirectRead(deps: DirectReadDeps) {
  const reader = createArchiveReader(deps.sessionsRoot);

  async function load(threadId: string): Promise<LoadedArchive | undefined> {
    const snapshot = await reader.read(threadId as never).catch(() => undefined);
    if (snapshot === undefined || !snapshot.ok) return undefined;
    const events = snapshot.value.events;
    let sizeBytes = 0;
    for (const event of events) sizeBytes += JSON.stringify(event).length;
    if (sizeBytes > DIRECT_READ_MAX_BYTES) return undefined;
    return { events, sizeBytes };
  }

  return {
    async readEntries(threadId: string, query: { since?: number; before?: number; limit?: number; view?: unknown }): Promise<{ entries: EntryLine[]; leafSeq: number; hasMore: boolean } | { error: HubErrorShape } | undefined> {
      const loaded = await load(threadId);
      if (loaded === undefined || loaded.events.length === 0) return undefined;
      const window = entryWindowViewed(loaded.events, query);
      return window.ok ? { entries: window.entries, leafSeq: window.leafSeq, hasMore: window.hasMore } : { error: hubError(window.code, window.reason) };
    },
    async readState(threadId: string) {
      const loaded = await load(threadId);
      if (loaded === undefined) return undefined;
      const events = loaded.events;
      const dial = foldDial(events, { provider: "", model: "" });
      let messageCount = 0;
      for (const event of events) {
        if (event.type === "user/message" || event.type === "assistant/message") messageCount += 1;
      }
      return {
        model: dial,
        isStreaming: false,
        isCompacting: false,
        sessionId: threadId,
        sessionName: titleOf(events) ?? "",
        sessionFile: `${deps.sessionsRoot}/${threadId}/events.jsonl`,
        messageCount,
        queue: foldQueue(events),
      };
    },
    async readHeader(threadId: string): Promise<{ cwd?: string } | undefined> {
      const headers = await reader.listHeaders().catch(() => undefined);
      return headers?.find((header) => String(header.id) === threadId);
    },
  };
}

export type DirectRead = ReturnType<typeof createDirectRead>;
