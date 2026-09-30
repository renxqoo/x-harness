import { join } from "node:path";
import { mintSessionId, isSafeSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { SdkEvent } from "./events.ts";
import { sdkError } from "./errors.ts";
import type { SdkErrorShape, SdkResult } from "./errors.ts";
import { mailboxRootOf, workflowRootOf } from "./dirs.ts";
import { startInprocess, sessionPathOf } from "./executor-inprocess/run.ts";
import type { InprocessRun } from "./executor-inprocess/run.ts";
import type { AssemblySpec } from "./executor-inprocess/assembly.ts";
import { createScriptAdapter, scriptFromEnv } from "./script-adapter.ts";
import type { ScriptAdapter } from "./script-adapter.ts";
import type { SdkClient, SdkClientOptions, ThreadInfo } from "./client.ts";

export interface StartThreadSpec {
  cwd: string;
  trusted?: boolean;
  dial?: { provider: string; model: string };
  thinkingLevel?: string;
  permissionMode?: string;
  prompt?: string;
  images?: readonly { base64: string; mediaType: string }[];
  sendId?: string;
  tools?: readonly string[];
  excludeTools?: readonly string[];
  systemPromptAppend?: string;
  apiKey?: string;
}

export interface SendOptions {
  images?: readonly { base64: string; mediaType: string }[];
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
  runCommand(line: string): Promise<SdkResult<string>>;
  retire(): Promise<SdkResult<void>>;
  stop(): Promise<void>;
}

interface LiveThread {
  run: InprocessRun;
  listeners: Map<string, Set<(event: SdkEvent) => void>>;
  birth: SdkEvent[];
  waiters: Map<string, { resolve: (report: SdkSendReport) => void; timer: ReturnType<typeof setTimeout> | undefined }>;
}

export function attachExecutor(client: SdkClient, options: SdkClientOptions) {
  const live = new Map<string, LiveThread>();

  function wire(run: InprocessRun, threadId: string): void {
    void run.onEvent((event) => dispatch(threadId, event));
  }

  function dispatch(threadId: string, event: SdkEvent): void {
    const thread = live.get(threadId);
    if (thread !== undefined) {
      thread.birth.push(event);
      const listeners = thread.listeners.get(event.kind);
      if (listeners !== undefined) for (const listener of listeners) listener(event);
      if (event.kind === "settled" && event.sendId !== "") {
        const waiter = thread.waiters.get(event.sendId);
        if (waiter !== undefined) {
          thread.waiters.delete(event.sendId);
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiter.resolve({ sendId: event.sendId, ok: event.ok, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
        }
      } else if (event.kind === "settled") {
        for (const [sendId, waiter] of thread.waiters) {
          thread.waiters.delete(sendId);
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiter.resolve({ sendId, ok: event.ok, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
        }
      }
    }
    client.internal.emit(event);
  }

  function assemblySpec(spec: StartThreadSpec, mainSessionId: SessionId, resumeId: SessionId | undefined): AssemblySpec {
    const script = options.env?.["HUB_WORKER_PROVIDER"] === "script";
    const adapters = script ? [createScriptAdapter(scriptFromEnv(client.internal.env)) as unknown as ScriptAdapter] : [];
    return {
      cwd: spec.cwd,
      trusted: spec.trusted === true,
      sessionsRoot: options.sessionsRoot,
      agentDir: options.agentDir,
      ...(resumeId !== undefined ? { resumeId } : {}),
      mailboxRoot: mailboxRootOf({ explicit: options.mailboxRoot, agentDir: options.agentDir, env: client.internal.env }),
      workflowRoot: workflowRootOf({ explicit: options.workflowRoot, agentDir: options.agentDir, env: client.internal.env }),
      skillsDirs: [],
      rgBinDir: join(options.agentDir, "bin"),
      adapters,
      agentOptions: {
        provider: "script",
        model: "script-1",
        ...(spec.dial !== undefined ? { provider: spec.dial.provider, model: spec.dial.model } : {}),
      },
      persistence: "durable",
      mainSessionId,
      onWarn: (message) => client.internal.log(message),
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
      on(kind: string, listener: (event: SdkEvent) => void): () => void {
        const thread = live.get(threadId);
        if (thread === undefined) return () => {};
        const set = thread.listeners.get(kind) ?? new Set();
        set.add(listener);
        thread.listeners.set(kind, set);
        return () => set.delete(listener);
      },
      async send(text: string, sendOptions?: SendOptions): Promise<SdkResult<SdkSendReport>> {
        return await drive({ threadId, text, sendOptions });
      },
      async steer(text: string, sendOptions?: SendOptions): Promise<SdkResult<SdkSendReport>> {
        const thread = live.get(threadId);
        if (thread === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
        try {
          thread.run.handle.agent.steer(text);
        } catch (error) {
          return { ok: false, reason: sdkError("thread_not_live", String(error instanceof Error ? error.message : error)) };
        }
        return await drive({ threadId, text: "", sendOptions });
      },
      async followup(text: string, sendOptions?: SendOptions): Promise<SdkResult<SdkSendReport>> {
        const thread = live.get(threadId);
        if (thread === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
        try {
          thread.run.handle.agent.followup(text);
        } catch (error) {
          return { ok: false, reason: sdkError("thread_not_live", String(error instanceof Error ? error.message : error)) };
        }
        return await drive({ threadId, text: "", sendOptions });
      },
      async abort(cause?: string): Promise<SdkResult<void>> {
        const thread = live.get(threadId);
        if (thread === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
        try {
          thread.run.handle.agent.cancel(cause ?? "aborted");
          await thread.run.handle.agent.whenIdle();
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, reason: sdkError("internal", String(error instanceof Error ? error.message : error)) };
        }
      },
      async command<T>(name: string, _args?: object): Promise<SdkResult<T>> {
        return { ok: false, reason: sdkError("unknown_command", `command surface lands in P1: ${name}`) };
      },
      async runCommand(line: string): Promise<SdkResult<string>> {
        return { ok: false, reason: sdkError("unknown_command", `command surface lands in P1: ${line}`) };
      },
      async retire(): Promise<SdkResult<void>> {
        return await retireThread(threadId, "retire");
      },
      async stop(): Promise<void> {
        await retireThread(threadId, "stop");
      },
    };
  }

  async function drive(input: { threadId: string; text: string; sendOptions?: SendOptions }): Promise<SdkResult<SdkSendReport>> {
    const { threadId, text, sendOptions } = input;
    const thread = live.get(threadId);
    if (thread === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
    const sendId = sendOptions?.sendId ?? `send-${String(Math.random()).slice(2, 10)}`;
    const agent = thread.run.handle.agent;
    const waiter = new Promise<SdkSendReport>((resolve) => {
      const timer = sendOptions?.timeoutMs !== undefined
        ? setTimeout(() => {
            thread.waiters.delete(sendId);
            resolve({ sendId, ok: false, reason: "timeout" });
          }, sendOptions.timeoutMs)
        : undefined;
      thread.waiters.set(sendId, { resolve, timer });
    });
    try {
      const running = agent.status === "running";
      thread.run.trackSend(1);
      if (running && text !== "") {
        agent.steer(text);
      } else if (text !== "") {
        agent.followup(text);
      }
      const waitIdle = agent.whenIdle().then(() => {
        thread.run.trackSend(-1);
        thread.run.rescanSettled();
      });
      void waitIdle;
    } catch (error) {
      thread.waiters.delete(sendId);
      return { ok: false, reason: sdkError("thread_not_live", String(error instanceof Error ? error.message : error)) };
    }
    const report = await waiter;
    return { ok: true, value: report };
  }

  async function startThread(spec: StartThreadSpec): Promise<SdkResult<ThreadHandle>> {
    if (!client.internal.threadBudgetAvailable()) {
      return { ok: false, reason: sdkError("thread_limit", "too many live threads (limit reached)") };
    }
    const mainSessionId = mintSessionId();
    try {
      const threadId = String(mainSessionId);
      const run = await startInprocess({ threadId, spec: assemblySpec(spec, mainSessionId, undefined) });
      const settledThreadId = String(run.handle.agent.session.id);
      const entry: LiveThread = { run, listeners: new Map(), birth: [], waiters: new Map() };
      live.set(settledThreadId, entry);
      wire(run, settledThreadId);
      client.internal.table.insert({
        threadId: settledThreadId,
        cwd: spec.cwd,
        sessionPath: sessionPathOf(options.sessionsRoot, settledThreadId),
        state: "live",
        trusted: spec.trusted === true,
        keepalive: false,
      });
      return { ok: true, value: makeHandle(settledThreadId) };
    } catch (error) {
      return { ok: false, reason: sdkError("internal", String(error instanceof Error ? error.message : error)) };
    }
  }

  async function resumeThread(spec: { threadId: string; cwd?: string; trusted?: boolean; dial?: { provider: string; model: string } }): Promise<SdkResult<ThreadHandle>> {
    if (!isSafeSessionId(spec.threadId)) {
      return { ok: false, reason: sdkError("session_unreadable", "Session file not readable") };
    }
    const sessionPath = sessionPathOf(options.sessionsRoot, spec.threadId);
    const holder = client.internal.table.holderOf(sessionPath);
    if (holder !== undefined) {
      return { ok: false, reason: sdkError("already_open", "already open") };
    }
    if (!client.internal.threadBudgetAvailable()) {
      return { ok: false, reason: sdkError("thread_limit", "too many live threads (limit reached)") };
    }
    try {
      const run = await startInprocess({
        threadId: spec.threadId,
        spec: assemblySpec(
          { cwd: spec.cwd ?? process.cwd(), trusted: spec.trusted, ...(spec.dial !== undefined ? { dial: spec.dial } : {}) },
          mintSessionId(),
          spec.threadId as SessionId,
        ),
      });
      const entry: LiveThread = { run, listeners: new Map(), birth: [], waiters: new Map() };
      live.set(spec.threadId, entry);
      wire(run, spec.threadId);
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
      return { ok: false, reason: sdkError("session_unreadable", `cannot resume session: ${String(error instanceof Error ? error.message : error)}`) };
    }
  }

  async function retireThread(threadId: string, intent: "retire" | "stop"): Promise<SdkResult<void>> {
    const thread = live.get(threadId);
    const entry = client.internal.table.get(threadId);
    if (thread === undefined || entry === undefined) return { ok: true, value: undefined };
    if (intent === "retire" && entry.sessionPath === null) {
      return { ok: false, reason: sdkError("state_conflict", "Session not persisted yet") };
    }
    try {
      await thread.run.dispose();
    } catch (error) {
      client.internal.log(`dispose error: ${String(error)}`);
    }
    for (const [sendId, waiter] of thread.waiters) {
      thread.waiters.delete(sendId);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve({ sendId, ok: false, reason: intent === "stop" ? "stopped" : "retired" });
    }
    live.delete(threadId);
    if (intent === "stop") client.internal.table.remove(threadId);
    else client.internal.table.update(threadId, { state: "parked" });
    client.internal.table.update(threadId, { sessionPath: null });
    client.internal.table.update(threadId, { sessionPath: entry.sessionPath });
    return { ok: true, value: undefined };
  }

  return {
    startThread,
    resumeThread,
    threadOf: (threadId: string): ThreadHandle | undefined => (live.has(threadId) ? makeHandle(threadId) : undefined),
    retireThread,
    internal: { dispatch, live },
  };
}

export type Executor = ReturnType<typeof attachExecutor>;
export type { SdkErrorShape };
