// parked/dead 直读（DESIGN §3.4）：get_entries/get_state 免唤醒应答（WAL 折叠）；
// 围栏 = 绝对路径 + realpath 落 sessions 根之下（与 resume 同一围栏——register 与
// 内部唤醒复检共用）；一切不可用 fail-open 回落唤醒（返回 undefined）；文件内游标
// 错误是真命令失败（entries-window 判定）。get_state 投影：dial/messageCount 从
// WAL 折叠（与 resume 后重放同源）。
import { realpath } from "node:fs/promises";
import { isSafeSessionId } from "@x-harness/session";
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import type { SessionEvent } from "@x-harness/session";
import { projectEntries } from "../shared/entries-project.ts";
import { foldQueue } from "../shared/inbox-fold.ts";
import { foldDial } from "../shared/meta-fold.ts";
import { titleOf } from "../worker/meta-state.ts";
import { entryWindow, type EntryLine } from "../worker/entries-window.ts";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { DIRECT_READ_MAX_BYTES } from "../shared/limits.ts";

export interface FenceResult {
  ok: true;
  threadId: string;
  sessionPath: string;
}

/** 路径围栏：绝对 + 布局（<id>/events.jsonl）+ id 词法（内核 isSafeSessionId）+
 *  realpath 圈内——resume/register/唤醒共用 */
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

  /** 档案读取（直读上限保护——超限 undefined 走 fail-open；坏卷 undefined） */
  async function load(threadId: string): Promise<LoadedArchive | undefined> {
    const snapshot = await reader.read(threadId as never).catch(() => undefined);
    if (snapshot === undefined || !snapshot.ok) return undefined; // fail-open：回落唤醒
    const events = snapshot.value.events;
    let sizeBytes = 0;
    for (const event of events) sizeBytes += JSON.stringify(event).length;
    if (sizeBytes > DIRECT_READ_MAX_BYTES) return undefined;
    return { events, sizeBytes };
  }

  return {
    /** get_entries 直读：档案行 + 窗口；档案缺失/超限 → undefined（回落唤醒）。
     *  窗口拒绝 = 游标/limit 输入校验族（entries-window 单真相，与唤醒路径同码） */
    async readEntries(threadId: string, query: { since?: number; before?: number; limit?: number }): Promise<{ entries: EntryLine[]; leafSeq: number; hasMore: boolean } | { error: HubErrorShape } | undefined> {
      const loaded = await load(threadId);
      if (loaded === undefined || loaded.events.length === 0) return undefined;
      const window = entryWindow(projectEntries(loaded.events), query);
      return window.ok ? { entries: window.entries, leafSeq: window.leafSeq, hasMore: window.hasMore } : { error: hubError("invalid_input", window.reason) };
    },
    /** get_state 直读投影（与唤醒路径形状闭合——queue 经 WAL 折叠，未消费 inbox
     *  push 不因离线而「假空」；dial 双源折叠，无任何事实时 provider 空串） */
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
    /** 会话头直读（resume 预检/唤醒 cwd 复核面） */
    async readHeader(threadId: string): Promise<{ cwd?: string } | undefined> {
      const headers = await reader.listHeaders().catch(() => undefined);
      return headers?.find((header) => String(header.id) === threadId);
    },
  };
}

export type DirectRead = ReturnType<typeof createDirectRead>;
