// 会话仓库：create/fork 共用 birth 路径（guard 否决 → 二次占用检查 → 落账 → created 广播），
// flush 屏障派发，dispose 封存写权（docs/SESSION.md §1.5、§3）。

import { deepFreeze, errorText } from "@x-harness/core";
import type { GuardDeny } from "@x-harness/core";
import { isSafeSessionId, validateSessionEvents } from "./gates.ts";
import { mintSessionId } from "./id.ts";
import { materializeJson } from "./snapshot.ts";
import type { SessionHandle } from "./session.ts";
import { createSession } from "./session.ts";
import type { Result } from "@x-harness/core";
import type {
  CreateSessionOptions,
  ForkSessionOptions,
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionStore,
} from "./types.ts";

export interface SessionStoreHooks {
  readonly onEvent: (session: SessionId, event: SessionEvent) => void;
  readonly onGuard: (header: SessionHeader) => Promise<GuardDeny | undefined>;
  readonly onCreated: (header: SessionHeader) => void;
  readonly onFlush: (session: SessionId) => Promise<void>;
  readonly onDisposed: (session: SessionId) => void;
}

export function createSessionStore(hooks: SessionStoreHooks): SessionStore {
  const sessions = new Map<SessionId, SessionHandle>();

  function resolveId(id: SessionId | undefined): Result<SessionId> {
    // 缺省铸号 = mintSessionId（时间戳-随机，跨进程唯一——持久目录撞名即永久拒写）
    if (id === undefined) return { ok: true, value: mintSessionId() };
    if (!isSafeSessionId(id)) return { ok: false, reason: `invalid-id:${id}` };
    return { ok: true, value: id };
  }

  function makeHeader(id: SessionId, parent: SessionId | undefined, agent: CreateSessionOptions["agent"]): SessionHeader {
    return deepFreeze({
      id,
      createdAt: Date.now(),
      cwd: process.cwd(),
      ...(parent !== undefined ? { parentSession: parent } : {}),
      ...(agent !== undefined ? { agentId: agent.id, agentType: agent.type, agentDepth: agent.depth, ...(agent.work !== undefined ? { agentWork: agent.work } : {}), ...(agent.worktree !== undefined ? { agentWorktree: agent.worktree } : {}) } : {}),
    }) as SessionHeader;
  }

  async function birth(header: SessionHeader, seed: readonly SessionEvent[], inherited: boolean): Promise<Result<Session>> {
    const deny = await hooks.onGuard(header);
    if (deny !== undefined) return { ok: false, reason: `denied:${deny.reason}` };
    // guard 是 await 点：并发同显式 id 在此二次检查，恰一个成功
    if (sessions.has(header.id)) return { ok: false, reason: `duplicate:${header.id}` };
    const handle = createSession({ header, seed, inherited, onAppend: hooks.onEvent });
    sessions.set(header.id, handle);
    hooks.onCreated(header);
    return { ok: true, value: handle.session };
  }

  /** create 的 id/header 解析：归档 header 原文（resume）或铸号 + 血缘（docs/SESSION-RESUME.md §1.3） */
  function resolveCreateHeader(options: CreateSessionOptions): Result<{ readonly header: SessionHeader | undefined; readonly id: SessionId }> {
    if (options.header !== undefined) {
      // id 以 header 为准，parent 忽略；形状门（id 合法 + JSON 安全）
      if (!isSafeSessionId(options.header.id)) {
        return { ok: false, reason: "invalid-header:shape" };
      }
      if (options.id !== undefined && options.id !== options.header.id) {
        return { ok: false, reason: "invalid-header:id-mismatch" };
      }
      let snapshot: unknown;
      try {
        snapshot = materializeJson(options.header); // 脱钩：调用方对象不被就地冻结
      } catch {
        return { ok: false, reason: "invalid-header:not-json" };
      }
      return { ok: true, value: { header: deepFreeze(snapshot) as SessionHeader, id: options.header.id } };
    }
    const idRes = resolveId(options.id);
    if (!idRes.ok) return idRes;
    if (options.parent !== undefined && !isSafeSessionId(options.parent)) {
      return { ok: false, reason: `invalid-parent:${options.parent}` };
    }
    return { ok: true, value: { header: undefined, id: idRes.value } };
  }

  return {
    create: async (options: CreateSessionOptions = {}) => {
      const resolved = resolveCreateHeader(options);
      if (!resolved.ok) return resolved;
      const { header, id } = resolved.value;
      if (sessions.has(id)) return { ok: false, reason: `duplicate:${id}` };
      let seed: readonly SessionEvent[] = [];
      if (options.seed !== undefined) {
        // 物化先行：信封整体脱钩定影，再整卷校验（门-账不可能发散；exotic 信封在此拒绝）
        try {
          seed = options.seed.map((event) => materializeJson(event) as SessionEvent);
        } catch {
          return { ok: false, reason: "corrupt-envelope:not-json" };
        }
        const seedErr = validateSessionEvents(seed);
        if (seedErr !== undefined) return { ok: false, reason: seedErr };
      }
      return birth(header ?? makeHeader(id, options.parent, options.agent), seed, false);
    },

    fork: async (source: SessionId, options: ForkSessionOptions = {}) => {
      const parentHandle = sessions.get(source);
      if (parentHandle === undefined) return { ok: false, reason: `no-session:${source}` };
      const snapshot = parentHandle.session.events();
      const cut = options.untilSeq ?? snapshot.length - 1;
      if (!Number.isInteger(cut) || cut < 0 || cut >= snapshot.length) {
        return { ok: false, reason: `bad-cut:${cut}` };
      }
      const idRes = resolveId(options.id);
      if (!idRes.ok) return idRes;
      if (sessions.has(idRes.value)) return { ok: false, reason: `duplicate:${idRes.value}` };
      // seed 是自身维护不变量日志的冻结切片（append 逐条过门），无需重验
      const seed = snapshot.slice(0, cut + 1);
      return birth(makeHeader(idRes.value, source, undefined), seed, true);
    },

    get: (id) => sessions.get(id)?.session,

    list: () => Object.freeze([...sessions.keys()]),

    flush: async (id) => {
      if (!sessions.has(id)) return { ok: false, reason: `no-session:${id}` };
      try {
        await hooks.onFlush(id);
        return { ok: true, value: true };
      } catch (error) {
        return { ok: false, reason: `flush-failed:${errorText(error)}` };
      }
    },

    dispose: (id) => {
      const handle = sessions.get(id);
      if (handle === undefined) return { ok: false, reason: `no-session:${id}` };
      sessions.delete(id);
      handle.seal();
      hooks.onDisposed(id);
      return { ok: true, value: true };
    },
  };
}
