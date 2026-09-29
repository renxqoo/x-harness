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
    if (sessions.has(header.id)) return { ok: false, reason: `duplicate:${header.id}` };
    const handle = createSession({ header, seed, inherited, onAppend: hooks.onEvent });
    sessions.set(header.id, handle);
    hooks.onCreated(header);
    return { ok: true, value: handle.session };
  }

  function resolveCreateHeader(options: CreateSessionOptions): Result<{ readonly header: SessionHeader | undefined; readonly id: SessionId }> {
    if (options.header !== undefined) {
      if (!isSafeSessionId(options.header.id)) {
        return { ok: false, reason: "invalid-header:shape" };
      }
      if (options.id !== undefined && options.id !== options.header.id) {
        return { ok: false, reason: "invalid-header:id-mismatch" };
      }
      let snapshot: unknown;
      try {
        snapshot = materializeJson(options.header);
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
