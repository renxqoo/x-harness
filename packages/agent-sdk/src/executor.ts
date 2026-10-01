import { join } from "node:path";
import { mintSessionId, isSafeSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { SdkEvent } from "./events.ts";
import { sdkError } from "./errors.ts";
import type { SdkResult } from "./errors.ts";
import { mailboxRootOf, workflowRootOf } from "./dirs.ts";
import { startInprocess, sessionPathOf } from "./executor-inprocess/run.ts";
import { loadCatalogSnapshot, scriptSnapshotOf } from "./catalog.ts";
import type { CatalogSnapshot } from "./catalog.ts";
import { WORLD_TEARDOWN_TIMEOUT_MS } from "./limits.ts";
import { permissionBroker } from "@x-harness/permission";
import { anchorTurnOf as anchorTurnOfSdk, anchorVerdictOf } from "./executor-worker/settle-anchor.ts";
import { delegationView } from "@x-harness/agent-delegation";
import type { InprocessRun } from "./executor-inprocess/run.ts";
import type { AssemblySpec } from "./executor-inprocess/assembly.ts";
import type { AgentOptions } from "@x-harness/agent-loop";
import type { ThreadInfo, SdkClientCore } from "./client.ts";
import type { SdkClientOptions } from "./client.ts";

export interface StartThreadSpec {
  cwd: string;
  trusted?: boolean;
  dial?: { provider: string; model: string };
}

export interface SendOptions {
  sendId?: string;
  timeoutMs?: number;
}

export interface SdkSendReport {
  sendId: string;
  ok: boolean;
  reason?: string;
}

export interface ThreadHandle {
  readonly threadId: string;
  readonly state: string;
  readonly info: ThreadInfo;
  on(kind: string, listener: (event: SdkEvent) => void): () => void;
  send(text: string, options?: SendOptions): Promise<SdkResult<SdkSendReport>>;
  steer(text: string, options?: SendOptions): Promise<SdkResult<SdkSendReport>>;
  followup(text: string, options?: SendOptions): Promise<SdkResult<SdkSendReport>>;
  abort(cause?: string): Promise<SdkResult<void>>;
  command<T = unknown>(name: string, args?: object): Promise<SdkResult<T>>;
  readonly events: AsyncIterable<SdkEvent>;
  retire(): Promise<SdkResult<void>>;
  stop(): Promise<void>;
}

interface SendWaiter {
  resolve: (report: SdkSendReport) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  anchorTurn: number;
  scannedSeq: number;
}

interface LiveThread {
  run: InprocessRun;
  listeners: Map<string, Set<(event: SdkEvent) => void>>;
  waiters: Map<string, SendWaiter>;
  eventBuffer: SdkEvent[];
  eventWaiters: Array<() => void>;
}

export function attachExecutor(client: SdkClientCore, options: SdkClientOptions) {
  const paths = options;
  const live = new Map<string, LiveThread>();
  let catalogSnapshot: CatalogSnapshot | undefined = scriptSnapshotOf(client.internal.env);
  let catalogLoading: Promise<void> | undefined = undefined;

  function ensureCatalog(): Promise<void> {
    if (catalogSnapshot !== undefined || catalogLoading !== undefined) return catalogLoading ?? Promise.resolve();
    catalogLoading = (async () => {
      catalogSnapshot = (await loadCatalogSnapshot(options.agentDir, client.internal.env)) as CatalogSnapshot;
      if (catalogSnapshot.adapters.length === 0 && scriptSnapshotOf(client.internal.env) !== undefined) {
        catalogSnapshot = scriptSnapshotOf(client.internal.env);
      }
    })();
    return catalogLoading;
  }

  function dispatch(threadId: string, event: SdkEvent): void {
    const thread = live.get(threadId);
    if (thread !== undefined) {
      thread.eventBuffer.push(event);
      if (thread.eventBuffer.length > 4096) thread.eventBuffer.splice(0, thread.eventBuffer.length - 4096);
      const listeners = thread.listeners.get(event.kind);
      if (listeners !== undefined) for (const listener of listeners) listener(event);
      for (const wake of thread.eventWaiters.splice(0)) wake();
      if (event.kind === "settled" && event.sendId !== "") {
        const waiter = thread.waiters.get(event.sendId);
        if (waiter !== undefined) {
          thread.waiters.delete(event.sendId);
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiter.resolve({ sendId: event.sendId, ok: event.ok, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
        }
      }
    }
    client.internal.emit(event);
  }

  function settleWaiters(threadId: string, verdict: { ok: boolean; reason: string }): void {
    const thread = live.get(threadId);
    if (thread === undefined) return;
    const pending = Array.from(thread.waiters.entries());
    for (const [sendId, waiter] of pending) {
      thread.waiters.delete(sendId);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve({ sendId, ok: verdict.ok, reason: verdict.reason });
      dispatch(threadId, { kind: "settled", threadId, sendId, ok: verdict.ok, reason: verdict.reason });
    }
  }

  async function drive(input: { threadId: string; text: string; mode: "auto" | "steer" | "followup"; sendOptions?: SendOptions }): Promise<SdkResult<SdkSendReport>> {
    const { threadId, text, mode, sendOptions } = input;
    if (text === "") return { ok: false, reason: sdkError("invalid_input", "send text must not be empty") };
    const thread = live.get(threadId);
    if (thread === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
    const sendId = sendOptions?.sendId ?? `send-${String(Math.random()).slice(2, 10)}`;
    if (thread.waiters.has(sendId)) {
      return { ok: false, reason: sdkError("state_conflict", `sendId already in flight: ${sendId}`) };
    }
    const agent = thread.run.handle.agent;
    const session = agent.session;
    const anchorTurn = anchorTurnOfSdk(session.events(), mode === "steer");
    const scannedSeq = session.events().length - 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveWaiter: (report: SdkSendReport) => void = () => {};
    const waiter = new Promise<SdkSendReport>((resolve) => {
      resolveWaiter = resolve;
      if (sendOptions?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          thread.waiters.delete(sendId);
          resolve({ sendId, ok: false, reason: "timeout" });
        }, sendOptions.timeoutMs);
        timer.unref?.();
      }
      thread.waiters.set(sendId, { resolve, timer, anchorTurn, scannedSeq });
    });
    try {
      thread.run.markBusy();
      if (mode === "steer") agent.steer(text);
      else agent.followup(text);
    } catch (error) {
      thread.run.markIdle();
      if (timer !== undefined) clearTimeout(timer);
      thread.waiters.delete(sendId);
      return { ok: false, reason: sdkError("thread_not_live", String(error instanceof Error ? error.message : error)) };
    }
    void agent.whenIdle().then(() => {
      thread.run.markIdle();
      settleFromAnchor(threadId, sendId);
    }).catch((error: unknown) => {
      thread.waiters.delete(sendId);
      if (timer !== undefined) clearTimeout(timer);
      resolveWaiter({ sendId, ok: false, reason: "settle-failed" });
      dispatch(threadId, { kind: "settled", threadId, sendId, ok: false, reason: "settle-failed" });
      client.internal.emit({ kind: "error", code: "internal", message: `settle failed: ${String(error instanceof Error ? error.message : error)}` });
    });
    return { ok: true, value: await waiter };
  }

  function settleFromAnchor(threadId: string, sendId: string): void {
    const thread = live.get(threadId);
    if (thread === undefined) return;
    const wait = thread.waiters.get(sendId);
    if (wait === undefined) return;
    const verdict = anchorVerdictOf(thread.run.handle.agent.session.events(), { anchorTurn: wait.anchorTurn, fromSeq: wait.scannedSeq, agent: thread.run.handle.agent });
    thread.waiters.delete(sendId);
    if (wait.timer !== undefined) clearTimeout(wait.timer);
    wait.resolve({ sendId, ...verdict });
    dispatch(threadId, { kind: "settled", threadId, sendId, ...verdict });
  }

  function defaultDelegationOf(snapshot: CatalogSnapshot | undefined): { resolveProviderOf: (model: string) => string | undefined; fallbackDial?: { model: string; provider: string }; dialable: (ref: string) => boolean } | undefined {
    if (snapshot === undefined) return undefined;
    return {
      resolveProviderOf: snapshot.resolveProviderOf,
      ...(snapshot.fallbackDial !== undefined ? { fallbackDial: snapshot.fallbackDial } : {}),
      dialable: snapshot.dialable,
    };
  }

  function assemblySpec(spec: StartThreadSpec, mainSessionId: SessionId, resumeId: SessionId | undefined): AssemblySpec {
    const snapshot = catalogSnapshot;
    const adapters = snapshot?.adapters ?? [];
    let agentOptions: AgentOptions = {};
    if (spec.dial !== undefined) agentOptions = { provider: spec.dial.provider, model: spec.dial.model };
    else if (snapshot !== undefined) agentOptions = { provider: snapshot.dial.provider, model: snapshot.dial.model };
    return {
      cwd: spec.cwd,
      trusted: spec.trusted === true,
      sessionsRoot: paths.sessionsRoot,
      agentDir: paths.agentDir,
      ...(resumeId !== undefined ? { resumeId } : {}),
      mailboxRoot: mailboxRootOf({ explicit: paths.mailboxRoot, agentDir: paths.agentDir }),
      workflowRoot: workflowRootOf({ explicit: paths.workflowRoot, agentDir: paths.agentDir }),
      skillsDirs: [],
      rgBinDir: join(paths.agentDir, "bin"),
      adapters,
      agentOptions,
      persistence: "durable",
      mainSessionId: resumeId ?? mainSessionId,
      ...((options.delegation ?? defaultDelegationOf(snapshot)) !== undefined ? { delegation: options.delegation ?? defaultDelegationOf(snapshot) } : {}),
      env: client.internal.env,
      onWarn: (message) => client.internal.log(message),
    };
  }

  function abortChainOf(thread: LiveThread, cause: string): void {
    const world = thread.run.world;
    const broker = world?.ctx.tryUse(permissionBroker) as { denyAll(): void } | undefined;
    broker?.denyAll();
    const delegation = world?.ctx.tryUse(delegationView) as { stopAll(id: never, cause: string): Promise<void> } | undefined;
    if (delegation !== undefined) void delegation.stopAll(thread.run.handle.agent.session.id as never, cause);
  }

  function threadEventsIterable(threadId: string): AsyncIterable<SdkEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<SdkEvent> {
        const thread = live.get(threadId);
        if (thread === undefined) {
          return (async function* (): AsyncIterator<SdkEvent> {})();
        }
        let cursor = 0;
        const liveRef = thread;
        return {
          async next(): Promise<IteratorResult<SdkEvent>> {
            for (;;) {
              if (cursor < liveRef.eventBuffer.length) {
                const value = liveRef.eventBuffer[cursor];
                cursor += 1;
                return { value: value as SdkEvent, done: false };
              }
              if (!live.has(threadId)) return { value: undefined, done: true };
              await new Promise<void>((resolve) => {
                liveRef.eventWaiters.push(resolve);
              });
            }
          },
          async return(): Promise<IteratorResult<SdkEvent>> {
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  function makeHandle(threadId: string): ThreadHandle {
    return {
      get threadId(): string {
        return threadId;
      },
      get state(): string {
        return client.internal.table.get(threadId)?.state ?? "dead";
      },
      get info(): ThreadInfo {
        const entry = client.internal.table.get(threadId);
        return {
          threadId,
          cwd: entry?.cwd ?? "",
          trusted: entry?.trusted ?? false,
          sessionPath: entry?.sessionPath ?? null,
          state: entry?.state ?? "dead",
          keepalive: entry?.keepalive ?? false,
          idleMs: entry?.idleMs ?? 0,
          isStreaming: entry?.isStreaming ?? false,
        };
      },
      get events(): AsyncIterable<SdkEvent> {
        return threadEventsIterable(threadId);
      },
      on(kind: string, listener: (event: SdkEvent) => void): () => void {
        const thread = live.get(threadId);
        if (thread === undefined) return () => {};
        const set = thread.listeners.get(kind) ?? new Set();
        set.add(listener);
        thread.listeners.set(kind, set);
        return () => set.delete(listener);
      },
      async send(text: string, options?: SendOptions): Promise<SdkResult<SdkSendReport>> {
        return await drive({ threadId, text, mode: "auto", sendOptions: options });
      },
      async steer(text: string, options?: SendOptions): Promise<SdkResult<SdkSendReport>> {
        return await drive({ threadId, text, mode: "steer", sendOptions: options });
      },
      async followup(text: string, options?: SendOptions): Promise<SdkResult<SdkSendReport>> {
        return await drive({ threadId, text, mode: "followup", sendOptions: options });
      },
      async abort(cause?: string): Promise<SdkResult<void>> {
        const thread = live.get(threadId);
        if (thread === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
        try {
          abortChainOf(thread, cause ?? "aborted");
          thread.run.handle.agent.cancel(cause ?? "aborted");
          await thread.run.handle.agent.whenIdle();
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, reason: sdkError("internal", String(error instanceof Error ? error.message : error)) };
        }
      },
      async command<T>(name: string, _args?: object): Promise<SdkResult<T>> {
        return { ok: false, reason: sdkError("unknown_command", `command surface lands with the command-domain batches: ${name}`) };
      },
      async retire(): Promise<SdkResult<void>> {
        return await retireThread(threadId, "retire");
      },
      async stop(): Promise<void> {
        await retireThread(threadId, "stop");
      },
    };
  }

  async function startThread(spec: StartThreadSpec): Promise<SdkResult<ThreadHandle>> {
    try {
      await ensureCatalog();
    } catch (error) {
      return { ok: false, reason: sdkError("io_failed", `catalog load failed: ${String(error instanceof Error ? error.message : error)}`) };
    }
    if (!client.internal.threadBudgetAvailable()) {
      return { ok: false, reason: sdkError("thread_limit", "too many live threads (limit reached)") };
    }
    const slot = client.internal.nextPendingId();
    const mainSessionId = mintSessionId();
    client.internal.table.insert({
      threadId: slot,
      cwd: spec.cwd,
      sessionPath: null,
      state: "spawning",
      trusted: spec.trusted === true,
      keepalive: false,
    });
    try {
      const run = await startInprocess({ threadId: String(mainSessionId), spec: assemblySpec(spec, mainSessionId, undefined) });
      const threadId = String(run.handle.agent.session.id);
      const entry: LiveThread = { run, listeners: new Map(), waiters: new Map(), eventBuffer: [], eventWaiters: [] };
      live.set(threadId, entry);
      void run.onEvent((event) => dispatch(threadId, event));
      client.internal.table.remove(slot);
      client.internal.table.insert({
        threadId,
        cwd: spec.cwd,
        sessionPath: sessionPathOf(paths.sessionsRoot, threadId),
        state: "live",
        trusted: spec.trusted === true,
        keepalive: false,
      });
      return { ok: true, value: makeHandle(threadId) };
    } catch (error) {
      client.internal.table.remove(slot);
      return { ok: false, reason: sdkError("internal", String(error instanceof Error ? error.message : error)) };
    }
  }

  async function resumeThread(spec: { threadId: string; cwd?: string; trusted?: boolean; dial?: { provider: string; model: string } }): Promise<SdkResult<ThreadHandle>> {
    try {
      await ensureCatalog();
    } catch (error) {
      return { ok: false, reason: sdkError("io_failed", `catalog load failed: ${String(error instanceof Error ? error.message : error)}`) };
    }
    if (!isSafeSessionId(spec.threadId)) {
      return { ok: false, reason: sdkError("session_unreadable", "Session file not readable") };
    }
    const sessionPath = sessionPathOf(paths.sessionsRoot, spec.threadId);
    if (client.internal.table.holderOf(sessionPath) !== undefined || client.internal.table.get(spec.threadId)?.state === "spawning") {
      return { ok: false, reason: sdkError("already_open", "already open") };
    }
    if (!client.internal.threadBudgetAvailable()) {
      return { ok: false, reason: sdkError("thread_limit", "too many live threads (limit reached)") };
    }
    const slot = client.internal.nextPendingId();
    client.internal.table.insert({
      threadId: slot,
      cwd: spec.cwd ?? process.cwd(),
      sessionPath,
      state: "spawning",
      trusted: spec.trusted === true,
      keepalive: false,
    });
    try {
      const run = await startInprocess({
        threadId: spec.threadId,
        spec: assemblySpec(
          { cwd: spec.cwd ?? process.cwd(), trusted: spec.trusted, ...(spec.dial !== undefined ? { dial: spec.dial } : {}) },
          spec.threadId as SessionId,
          spec.threadId as SessionId,
        ),
      });
      const entry: LiveThread = { run, listeners: new Map(), waiters: new Map(), eventBuffer: [], eventWaiters: [] };
      live.set(spec.threadId, entry);
      void run.onEvent((event) => dispatch(spec.threadId, event));
      client.internal.table.remove(slot);
      client.internal.table.insert({
        threadId: spec.threadId,
        cwd: spec.cwd ?? process.cwd(),
        sessionPath,
        state: "live",
        trusted: spec.trusted === true,
        keepalive: false,
      });
      return { ok: true, value: makeHandle(spec.threadId) };
    } catch (error) {
      client.internal.table.remove(slot);
      return { ok: false, reason: sdkError("session_unreadable", `cannot resume session: ${String(error instanceof Error ? error.message : error)}`) };
    }
  }

  async function retireThread(threadId: string, intent: "retire" | "stop"): Promise<SdkResult<void>> {
    const thread = live.get(threadId);
    const entry = client.internal.table.get(threadId);
    if (thread === undefined || entry === undefined) return { ok: true, value: undefined };
    if (intent === "retire" && thread.waiters.size > 0) {
      return { ok: false, reason: sdkError("thread_not_live", "thread has in-flight sends") };
    }
    if (intent === "retire" && entry.sessionPath === null) {
      return { ok: false, reason: sdkError("state_conflict", "Session not persisted yet") };
    }
    settleWaiters(threadId, { ok: false, reason: intent === "stop" ? "stopped" : "retired" });
    try {
      await thread.run.dispose();
    } catch (error) {
      client.internal.log(`dispose error: ${String(error)}`);
    }
    live.delete(threadId);
    const from = entry.state;
    if (intent === "stop") {
      client.internal.table.remove(threadId);
      client.internal.emit({ kind: "thread_state", threadId, from: from, to: "dead", cause: intent });
    } else {
      const sessionPath = entry.sessionPath;
      client.internal.table.update(threadId, { state: "parked", sessionPath: null });
      client.internal.table.update(threadId, { sessionPath });
      client.internal.table.releaseOccupancy(threadId);
      client.internal.emit({ kind: "thread_state", threadId, from: from, to: "parked", cause: intent });
    }
    return { ok: true, value: undefined };
  }

  async function shutdownAll(): Promise<void> {
    const deadline = Date.now() + client.internal.limits.shutdownBudgetMs;
    for (const threadId of live.keys()) {
      const entry = client.internal.table.get(threadId);
      settleWaiters(threadId, { ok: false, reason: "shutdown" });
      const thread = live.get(threadId);
      if (thread !== undefined) {
        const perWorld = Math.max(1_000, Math.min(WORLD_TEARDOWN_TIMEOUT_MS, deadline - Date.now()));
        await Promise.race([
          thread.run.dispose().catch(() => undefined),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, perWorld);
            t.unref?.();
          }),
        ]);
      }
      live.delete(threadId);
      if (thread !== undefined) for (const wake of thread.eventWaiters.splice(0)) wake();
      const sessionPath = entry?.sessionPath ?? null;
      client.internal.table.update(threadId, { state: "parked", sessionPath: null });
      if (sessionPath !== null) client.internal.table.update(threadId, { sessionPath });
      client.internal.table.releaseOccupancy(threadId);
      if (Date.now() >= deadline) break;
    }
  }

  return {
    startThread,
    resumeThread,
    threadOf: (threadId: string): ThreadHandle | undefined => (live.has(threadId) ? makeHandle(threadId) : undefined),
    retireThread,
    shutdownAll,
    internal: { dispatch, live, settleWaiters },
  };
}

export type Executor = ReturnType<typeof attachExecutor>;
