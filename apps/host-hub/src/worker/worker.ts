// worker 引导（DESIGN §5/§7）：stdout 接管 → hello 首帧（先于心跳）→ 心跳 1Hz
// （worker 侧真相：idleMs/streaming/sessionPath/rssBytes——busy 含在跑直执行与子代
// 理在飞）→ 命令循环（failure 单点 emit；全部响应经 responseFrame id-first 序）→
// 优雅退出（子代理 stopAll → 手动压缩 abortAll → 弹窗 denyAll → bash abort →
// dispose → flush → exit 0；一次性跑完）。stdin EOF / EPIPE = host 亡 → 同径退出。
import { CONFIRM_TIMEOUT_MS, WORKER_LINE_LIMIT, readLimits } from "../shared/limits.ts";
import { OBSERVER_COMMANDS, WORKER_BACKEND_ID, WORKER_PROTOCOL_VERSION } from "../protocol/internal.ts";
import { responseFrame, hubErrorFrame } from "../protocol/frames.ts";
import { takeOverStdout } from "../shared/stdout-guard.ts";
import { createJsonlSplitter } from "../shared/jsonl.ts";
import { createDialogBroker } from "./dialogs.ts";
import { createInflightRegistry, createInflightState } from "./inflight.ts";
import { createEventBridge } from "./event-bridge.ts";
import { createBashExec, installDetachExitSweep } from "./bash-exec.ts";
import { createWorkerCommands } from "./worker-commands.ts";
import type { WorkerRuntime, WorkerState } from "./worker-commands.ts";
import type { FrameWriter } from "../shared/stdout-guard.ts";
import { hubLog } from "../shared/hub-log.ts";

export interface WorkerBoot {
  agentDir: string;
  sessionsRoot: string;
  env?: Record<string, string | undefined>;
  /** 测试注入：命令到达流（缺省 stdin） */
  input?: NodeJS.ReadStream | { on(event: "data", cb: (chunk: Buffer) => void): void; on(event: "end", cb: () => void): void; on(event: "error", cb: (err: Error) => void): void };
  /** 测试注入：帧出口断言（缺省接管 stdout） */
  writerOverride?: FrameWriter;
  /** 测试注入：退出动作（缺省 process.exit） */
  exit?: (code: number) => void;
}

export async function runWorker(boot: WorkerBoot): Promise<void> {
  const env = boot.env ?? process.env;
  const limits = readLimits(env);
  const writer =
    boot.writerOverride ??
    takeOverStdout({
      onBroken: () => {
        void shutdown("stdout-broken");
      },
    });
  let shuttingDown = false;

  // hello 必须是首帧（先于心跳挂载——串行 writer 保序）
  void writer.write(`{"type":"hello","protocolVersion":${WORKER_PROTOCOL_VERSION},"backendId":"${WORKER_BACKEND_ID}"}`);

  const state: WorkerState = {
    handle: undefined,
    world: undefined,
    catalog: { providers: [], default: { provider: "", model: "" }, modelMeta: {} },
    dial: { provider: "", model: "" },
    thinking: undefined,
    permissionService: undefined,
    delegation: undefined,
    threadId: "",
    sessionPath: "",
    cwd: env["HUB_WORKER_CWD"] ?? process.cwd(),
    trusted: false,
    compacting: false,
    skillsDirs: [],
    skillsDisabled: new Set(),
    scriptAdapter: undefined,
  };

  const broker = createDialogBroker({
    confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
    sendFrame: (line) => void writer.write(line),
  });
  const inflight = createInflightRegistry();
  const inflightState = createInflightState();
  const bridge = createEventBridge({
    emitLine: (line) => void writer.write(line),
    threadId: () => state.threadId,
    inflight: inflightState,
  });
  const bash = createBashExec({
    session: () => {
      const handle = state.handle;
      if (handle === undefined || state.world === undefined) return undefined;
      return {
        session: handle.agent.session,
        flush: async (): Promise<void> => {
          await state.world?.store.flush(handle.agent.session.id);
        },
      };
    },
    cwd: () => state.cwd,
    confirm: (fields) => broker.confirm(state.threadId, fields),
    emitEvent: (name, payload) => {
      if (state.threadId !== "") {
        void writer.write(`{"type":"event","threadId":${JSON.stringify(state.threadId)},"name":${JSON.stringify(name)},"payload":${JSON.stringify(payload)}}`);
      }
    },
    agentDir: boot.agentDir,
    defaultTimeoutMs: limits.bashTimeoutMs,
    onStateChange: () => {},
  });

  const rt: WorkerRuntime = {
    state,
    emitLine: (line) => void writer.write(line),
    agentDir: boot.agentDir,
    sessionsRoot: boot.sessionsRoot,
    broker,
    bash,
    inflight,
    inflightState,
    bridge,
    triggerShutdown: () => {
      void shutdown("session-replaced");
    },
    env,
    pendingSends: 0,
  };
  const handlers = createWorkerCommands(rt);

  // 暴毙兜底：exit 时同步 SIGKILL detached 登记簿全集——兜住 uncaughtException 等
  // 不走优雅停机的路径（幂等，多 worker 同进程一次）
  installDetachExitSweep();

  let lastBusyAt = Date.now();
  // busy = send 在飞 ∨ streaming ∨ 手动压缩 ∨ 弹窗挂起 ∨ 直执行在跑 ∨ 子代理在飞
  const busy = (): boolean =>
    rt.pendingSends > 0 || bridge.isStreaming() || state.compacting || broker.pendingCount() > 0 || bash.isRunning() || bridge.childBusy();

  const heartbeat = setInterval(() => {
    void writer.write(
      `{"type":"heartbeat","idleMs":${busy() ? 0 : Date.now() - lastBusyAt},"streaming":${bridge.isStreaming()},"sessionPath":${JSON.stringify(state.sessionPath === "" ? null : state.sessionPath)},"rssBytes":${process.memoryUsage().rss}}`,
    );
  }, 1_000);

  const markBusy = (): void => {
    lastBusyAt = Date.now();
  };

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    try {
      // 关闭序：子代理 stopAll → 手动压缩 abortAll → 弹窗 settleAll → bash abort →
      // dispose（内含 flush）→ world 收殓
      const delegation = state.delegation;
      if (delegation !== undefined && state.threadId !== "") {
        await delegation.stopAll(state.threadId as never, "worker-shutdown");
      }
      await inflight.abortAll();
      broker.denyAll();
      bash.abortAdmissions();
      bash.abortRunning(undefined);
      if (state.handle !== undefined) {
        bridge.unsubscribe();
        await state.handle.dispose();
      }
      if (state.world !== undefined) {
        const { teardownWorld } = await import("./assembly.ts");
        await teardownWorld(state.world);
      }
    } catch (error) {
      hubLog(`worker: shutdown error: ${String(error)}`);
    }
    await writer.idle(); // 末帧冲刷完成再退出（防截断）；detached 残留由 exit sweep 清场
    void reason;
    (boot.exit ?? ((code: number) => process.exit(code)))(0);
  }

  const input = boot.input ?? process.stdin;
  input.on("error", (error: Error) => {
    hubLog(`worker: stdin error: ${String(error)}`);
  });
  process.on("SIGTERM", () => {
    void shutdown("sigterm");
  });
  process.on("SIGINT", () => {
    void shutdown("sigint");
  });

  return new Promise<void>((resolve) => {
    const splitter = createJsonlSplitter({ maxLineBytes: WORKER_LINE_LIMIT });
    input.on("data", (chunk: Buffer) => {
      const { lines, oversize } = splitter.feed(chunk);
      if (oversize > 0) {
        hubLog("worker: parse failure: line exceeds limit");
        void writer.write(responseFrame({ command: "parse", success: false, error: "parse failure" }));
      }
      for (const line of lines) {
        let input_: { type?: unknown; id?: unknown };
        try {
          input_ = JSON.parse(line) as { type?: unknown; id?: unknown };
        } catch (error) {
          hubLog(`worker: parse failure: invalid JSON (${String(error)})`);
          void writer.write(responseFrame({ command: "parse", success: false, error: "parse failure" }));
          continue;
        }
        if (typeof input_ !== "object" || input_ === null || typeof input_.type !== "string") {
          hubLog(`worker: parse failure: not an object (${line.slice(0, 200)})`);
          void writer.write(responseFrame({ command: "parse", success: false, error: "parse failure" }));
          continue;
        }
        const typed = input_ as { type: string; id?: string };
        if (shuttingDown) {
          void writer.write(responseFrame({ ...(typed.id !== undefined ? { id: typed.id } : {}), command: typed.type, success: false, error: "shutting down" }));
          continue;
        }
        const handler = handlers.get(typed.type);
        if (handler === undefined) {
          void writer.write(responseFrame({ ...(typed.id !== undefined ? { id: typed.id } : {}), command: typed.type, success: false, error: "unknown command" }));
          continue;
        }
        if (!OBSERVER_COMMANDS.has(typed.type)) markBusy(); // 观察者不重置 idle（§3）
        void handler(typed as { id?: string; [key: string]: unknown }).catch((error: unknown) => {
          void writer.write(hubErrorFrame(String(error), state.threadId === "" ? undefined : state.threadId));
        });
      }
    });
    input.on("end", () => {
      const tail = splitter.flush();
      // 尾行处理 await 完成后再 shutdown（末命令的响应/事件不因退出竞输）
      void (async () => {
        for (const line of tail.lines) {
          try {
            const parsed = JSON.parse(line) as { type: string; id?: string };
            const handler = handlers.get(parsed.type);
            if (handler !== undefined) await handler(parsed);
          } catch {
            // 尾行坏 JSON：flush 尾不补 parse failure（进程正在退出）
          }
        }
        await shutdown("stdin-end");
      })().then(
        () => resolve(),
        () => resolve(),
      );
    });
  });
}
