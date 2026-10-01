import { createThreadTable } from "./thread-table.ts";
import type { ThreadTable } from "./thread-table.ts";
import { readLimits } from "./limits.ts";
import type { SdkLimits } from "./limits.ts";
import { attachExecutor } from "./executor.ts";
import type { SdkEvent } from "./events.ts";
import type { SdkErrorShape, SdkResult } from "./errors.ts";
import { sdkError } from "./errors.ts";

export interface SdkClientOptions {
  mode: "in-process" | "worker";
  agentDir: string;
  sessionsRoot: string;
  delegation?: {
    builtinTypes?: readonly import("@x-harness/agent-delegation").InlineTypeResource[];
    resolveProviderOf?: (model: string) => string | undefined;
    fallbackDial?: { model?: string; provider?: string };
    dialable?: (ref: string) => boolean;
  };
  env?: Record<string, string | undefined>;
  mailboxRoot?: string;
  workflowRoot?: string;
  limits?: Partial<SdkLimits>;
  onEvent?: (event: SdkEvent) => void;
  onLog?: (message: string) => void;
}

export interface ThreadInfo {
  threadId: string;
  cwd: string;
  trusted: boolean;
  sessionPath: string | null;
  state: string;
  keepalive: boolean;
  idleMs: number;
  isStreaming: boolean;
}

const PENDING_PREFIX = "@pending-";

export type SdkClientCore = ReturnType<typeof createClientCore>;

export function createSdkClient(options: SdkClientOptions) {
  const core = createClientCore(options);
  const executor = options.mode === "in-process" ? attachExecutor(core, options) : undefined;

  async function shutdown(): Promise<SdkResult<void>> {
    if (executor !== undefined) await executor.shutdownAll();
    return await core.shutdown();
  }

  const lifecycle: ExecutorLifecycle =
    executor !== undefined
      ? { startThread: executor.startThread, resumeThread: executor.resumeThread, threadOf: executor.threadOf }
      : {
          startThread: async () => ({ ok: false, reason: { code: "internal", message: "worker-mode executor lands in P2; use in-process mode" } }),
          resumeThread: async () => ({ ok: false, reason: { code: "internal", message: "worker-mode executor lands in P2; use in-process mode" } }),
          threadOf: () => undefined,
        };

  return {
    ...core,
    shutdown,
    ...lifecycle,
  };
}

function createClientCore(options: SdkClientOptions) {
  const env: Record<string, string | undefined> = options.env !== undefined ? { ...options.env } : { ...process.env };
  const limits: SdkLimits = { ...readLimits(env), ...options.limits };
  const table: ThreadTable = createThreadTable();
  let started = false;
  let shutDown = false;
  let pendingSeq = 0;

  function log(message: string): void {
    options.onLog?.(message);
  }

  function emit(event: SdkEvent): void {
    options.onEvent?.(event);
  }

  function occupiedThreads(): number {
    return table.liveCount();
  }

  function threadBudgetAvailable(): boolean {
    return occupiedThreads() < limits.maxThreads;
  }

  function nextPendingId(): string {
    pendingSeq += 1;
    return `${PENDING_PREFIX}${pendingSeq}`;
  }

  function threadInfoOf(threadId: string): SdkResult<ThreadInfo> {
    const entry = table.get(threadId);
    if (entry === undefined) return { ok: false, reason: sdkError("unknown_thread", `Unknown threadId: ${threadId}`) };
    return {
      ok: true,
      value: {
        threadId: entry.threadId,
        cwd: entry.cwd,
        trusted: entry.trusted,
        sessionPath: entry.sessionPath,
        state: entry.state,
        keepalive: entry.keepalive,
        idleMs: entry.idleMs,
        isStreaming: entry.isStreaming,
      },
    };
  }

  function listThreads(): SdkResult<ThreadInfo[]> {
    return { ok: true, value: table.list().map((entry) => ({
      threadId: entry.threadId,
      cwd: entry.cwd,
      trusted: entry.trusted,
      sessionPath: entry.sessionPath,
      state: entry.state,
      keepalive: entry.keepalive,
      idleMs: entry.idleMs,
      isStreaming: entry.isStreaming,
    })) };
  }

  async function startup(): Promise<SdkResult<void>> {
    if (started) return { ok: true, value: undefined };
    started = true;
    shutDown = false;
    log(`sdk: startup agentDir=${options.agentDir}`);
    return { ok: true, value: undefined };
  }

  async function shutdown(): Promise<SdkResult<void>> {
    if (shutDown) return { ok: true, value: undefined };
    shutDown = true;
    started = false;
    log("sdk: shutdown");
    return { ok: true, value: undefined };
  }

  return {
    startup,
    shutdown,
    listThreads,
    threadInfo: threadInfoOf,
    limits: {
      setIdleRetireMs: (ms: number): void => {
        limits.idleRetireMs = Math.min(24 * 60 * 60 * 1000, Math.max(1_000, ms));
      },
      setRssRetireBytes: (n: number): void => {
        limits.rssRetireBytes = n === 0 ? 0 : Math.min(2 * 1024 * 1024 * 1024 * 1024, Math.max(256 * 1024 * 1024, n));
      },
      current: (): SdkLimits => ({ ...limits }),
    },
    internal: {
      table,
      env,
      limits,
      threadBudgetAvailable,
      nextPendingId,
      emit,
      log,
      isStarted: (): boolean => started,
      isShutDown: (): boolean => shutDown,
    },
  };
}

interface ExecutorLifecycle {
  startThread(spec: import("./executor.ts").StartThreadSpec): Promise<SdkResult<import("./executor.ts").ThreadHandle>>;
  resumeThread(spec: { threadId: string; cwd?: string; trusted?: boolean; dial?: { provider: string; model: string } }): Promise<SdkResult<import("./executor.ts").ThreadHandle>>;
  threadOf(threadId: string): import("./executor.ts").ThreadHandle | undefined;
}

export type SdkClient = ReturnType<typeof createClientCore> & { shutdown(): Promise<SdkResult<void>> } & ExecutorLifecycle;
export type { SdkErrorShape };
