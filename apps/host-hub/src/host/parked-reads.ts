// §3.4 矩阵 parked/dead 接管（DESIGN）：收敛读（get_inflight/get_subagents/
// get_pending_dialogs）直接空形态恒 success；get_state/get_entries 走直读
// （不可用 fail-open 回落池路由唤醒——仍是线程域，live/spawning/retiring 交池）。
import { responseFrame } from "../protocol/frames.ts";
import type { ThreadEntry, ThreadTable } from "./thread-table.ts";
import type { DirectRead } from "./read-history.ts";

/** §3.4 接管集（表项 parked/dead 时 host 免唤醒应答） */
export const PARKED_DIRECT_COMMANDS = new Set(["get_state", "get_entries", "get_inflight", "get_subagents", "get_pending_dialogs"]);

export interface ParkedReadDeps {
  table: ThreadTable;
  direct: DirectRead;
  emitClient: (line: string) => void;
}

export function createParkedReads(deps: ParkedReadDeps) {
  function respond(id: string | undefined, command: string, result: { data?: unknown; error?: string }): void {
    deps.emitClient(
      responseFrame({
        ...(id !== undefined && id !== "" ? { id } : {}),
        command,
        success: result.error === undefined,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      }),
    );
  }

  /** get_state 直读应答（附录 B 形状） */
  async function answerState(id: string | undefined, entry: ThreadEntry): Promise<boolean> {
    const state = await deps.direct.readState(entry.threadId);
    if (state === undefined) return false; // fail-open：回落池路由（唤醒）
    respond(id, "get_state", { data: state });
    return true;
  }

  /** get_entries 直读应答：档案缺失/空 fail-open；档案内游标错误 = 真命令失败 */
  async function answerEntries(
    id: string | undefined,
    entry: ThreadEntry,
    input: { [key: string]: unknown },
  ): Promise<boolean> {
    const query = {
      ...(typeof input.since === "number" ? { since: input.since } : {}),
      ...(typeof input.before === "number" ? { before: input.before } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    };
    const entries = await deps.direct.readEntries(entry.threadId, query);
    if (entries === undefined) return false;
    if ("error" in entries) {
      respond(id, "get_entries", { error: entries.error });
      return true;
    }
    respond(id, "get_entries", { data: entries });
    return true;
  }

  return {
    /** 尝试接管（表项 parked/dead）：true = 已应答；false = 交池路由 */
    async tryAnswer(type: string, input: { [key: string]: unknown }, id: string | undefined): Promise<boolean> {
      const threadId = typeof input.threadId === "string" ? input.threadId : "";
      const entry = threadId !== "" ? deps.table.get(threadId) : undefined;
      if (entry === undefined || (entry.state !== "parked" && entry.state !== "dead")) return false;
      if (type === "get_inflight") {
        respond(id, type, { data: { turnStartSeq: null, turnStartedAt: null, message: null, toolOutputs: [], bash: null } });
        return true;
      }
      if (type === "get_subagents") {
        respond(id, type, { data: { subagents: [] } });
        return true;
      }
      if (type === "get_pending_dialogs") {
        respond(id, type, { data: { dialogs: [] } });
        return true;
      }
      if (type === "get_state") return await answerState(id, entry);
      return await answerEntries(id, entry, input); // get_entries
    },
  };
}

export type ParkedReads = ReturnType<typeof createParkedReads>;
