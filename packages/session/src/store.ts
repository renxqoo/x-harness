// 会话仓库：create/fork 共用 birth 路径（guard 否决 → 二次占用检查 → 落账 → created 广播），
// flush 屏障派发，dispose 封存写权（docs/SESSION.md §1.5、§3）。

import { deepFreeze } from "@x-harness/core";
import type { GuardDeny } from "@x-harness/core";
import { isJsonSafe, isSafeSessionId, validateSessionEvents } from "./gates.ts";
import type { SessionHandle } from "./session.ts";
import { createSession } from "./session.ts";
import type {
  CreateSessionOptions,
  ForkSessionOptions,
  Result,
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
  let counter = 0;

  function mint(): SessionId {
    return `session-${counter++}` as SessionId;
  }

  function resolveId(id: SessionId | undefined): Result<SessionId> {
    if (id === undefined) return { ok: true, value: mint() };
    if (!isSafeSessionId(id)) return { ok: false, reason: `invalid-id:${id}` };
    return { ok: true, value: id };
  }

  function makeHeader(id: SessionId, parent: SessionId | undefined): SessionHeader {
    return deepFreeze({
      id,
      createdAt: Date.now(),
      cwd: process.cwd(),
      ...(parent !== undefined ? { parentSession: parent } : {}),
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
      if (!isJsonSafe(options.header)) {
        return { ok: false, reason: "invalid-header:not-json" };
      }
      return { ok: true, value: { header: deepFreeze(options.header), id: options.header.id } };
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
      if (options.seed !== undefined) {
        const seedErr = validateSessionEvents(options.seed);
        if (seedErr !== undefined) return { ok: false, reason: seedErr };
      }
      return birth(header ?? makeHeader(id, options.parent), options.seed ?? [], false);
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
      const seed = snapshot.slice(0, cut + 1);
      const seedErr = validateSessionEvents(seed);
      if (seedErr !== undefined) return { ok: false, reason: seedErr };
      return birth(makeHeader(idRes.value, source), seed, true);
    },

    get: (id) => sessions.get(id)?.session,

    list: () => Object.freeze([...sessions.keys()]),

    flush: async (id) => {
      if (!sessions.has(id)) return { ok: false, reason: `no-session:${id}` };
      try {
        await hooks.onFlush(id);
        return { ok: true, value: { flushed: true } as const };
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

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map((inner) => errorText(inner)).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}
