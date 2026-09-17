// worker 模式 main 侧桥（docs/PLUGIN-MANAGER.md §4 bridge.ts）：
// 把切片验证过的手工机制产品化——boot/ready/apply 超时 terminate、监听桥（平台 root 落位）、
// provided 代理注册、双向服务 RPC 关联与运行期超时击杀、exit 收殓、优雅 shutdown。
// 落位纪律（裁决 9）：注册在平台 root（可见性向上），disposer 由本桥持有（回卷经 kill/shutdown）。

import { Worker } from "node:worker_threads";
import { defineService } from "@x-harness/core";
import type { AnyToken, Context, ServiceToken } from "@x-harness/core";
import type { MainToWorker, WorkerToMain } from "./worker/protocol.ts";
import type { Result } from "./types.ts";

export interface BridgeDeps {
  readonly pluginPath: string;
  readonly platform: Context; // 注册落位层（平台 root）
  readonly tokenTable: Map<string, AnyToken>;
  readonly applyTimeoutMs: number;
  readonly runtimeTimeoutMs: number;
  readonly hostPath: string;
  readonly onRuntimeError: (where: string, message: string) => void;
  readonly onKilled: (reason: string) => void;
}

export interface LaunchedPlugin {
  readonly name: string;
  readonly inject: readonly string[];
}

export interface WorkerBridge {
  launch(): Promise<Result<LaunchedPlugin, string>>;
  callService(service: string, method: string, args: readonly unknown[]): Promise<Result<unknown, string>>;
  emitIn(token: string, payload: unknown): void;
  shutdown(): Promise<Result<undefined, string>>;
  kill(reason: string): Promise<void>;
  serviceToken(name: string): ServiceToken<unknown> | undefined;
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createWorkerBridge(deps: BridgeDeps): WorkerBridge {
  const worker = new Worker(deps.hostPath);
  const rpcPending = new Map<number, PendingRpc>();
  const teardown: (() => void)[] = [];
  const violations: string[] = [];
  const bridgedTokens = new Map<string, ServiceToken<unknown>>();
  let rpcId = 0;
  let intentional = false;
  let killed = false;
  let launcher:
    | { resolve(r: Result<LaunchedPlugin, string>): void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  let readyInfo: LaunchedPlugin | undefined;
  let shutdownWaiter: { resolve(r: Result<undefined, string>): void; timer: ReturnType<typeof setTimeout> } | undefined;

  const failLaunch = (reason: string): void => {
    if (launcher === undefined) return;
    clearTimeout(launcher.timer);
    const settle = launcher;
    launcher = undefined;
    settle.resolve({ ok: false, reason });
  };

  const bridgedNames: string[] = [];
  const runTeardown = (): void => {
    for (const dispose of teardown.splice(0)) dispose();
    for (const name of bridgedNames.splice(0)) {
      if (deps.tokenTable.get(name) === bridgedTokens.get(name)) deps.tokenTable.delete(name);
    }
  };

  const kill = async (reason: string): Promise<void> => {
    if (killed) return;
    killed = true;
    intentional = true;
    for (const pending of rpcPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`worker killed: ${reason}`));
    }
    rpcPending.clear();
    await worker.terminate();
    runTeardown();
    deps.onKilled(reason);
  };

  worker.on("message", (message: WorkerToMain) => {
    if (message.t === "ready") {
      readyInfo = { name: message.pluginName, inject: message.inject };
      return;
    }
    if (message.t === "provided") {
      const token = deps.tokenTable.get(message.service) ?? defineService<unknown>(message.service);
      bridgedTokens.set(message.service, token as ServiceToken<unknown>);
      deps.tokenTable.set(message.service, token); // svc.token/serviceToken 消费面（裁决 10）
      bridgedNames.push(message.service);
      try {
        const dispose = deps.platform.provide(token as ServiceToken<unknown>, serviceProxy(message.service));
        teardown.push(dispose);
      } catch (error) {
        // 平台 root 同名服务冲突：fail-fast——装载失败路径收殓
        failLaunch(`provided service "${message.service}" conflicts on platform: ${String(error)}`);
        void kill(`service conflict: ${message.service}`);
      }
      return;
    }
    if (message.t === "listening") {
      const token = deps.tokenTable.get(message.token);
      if (message.mode === "waterfall") {
        violations.push(`waterfall middleware not supported in worker mode: ${message.token}`);
        return;
      }
      if (token === undefined) {
        violations.push(`listening on unregistered token: ${message.token}`);
        return;
      }
      deps.tokenTable.set(message.token, token);
      const dispose = (deps.platform.on as (t: AnyToken, f: unknown) => () => void)(
        token,
        forwardToWorker(message.token),
      );
      teardown.push(dispose);
      return;
    }
    if (message.t === "apply-done") {
      if (readyInfo === undefined) return;
      if (launcher === undefined) return;
      if (violations.length > 0) {
        const reason = violations.join("; ");
        failLaunch(`worker-mode constraint violated: ${reason}`);
        void kill(`constraint violation: ${reason}`);
        return;
      }
      clearTimeout(launcher.timer);
      const settle = launcher;
      launcher = undefined;
      settle.resolve({ ok: true, value: readyInfo });
      return;
    }
    if (message.t === "apply-error") {
      failLaunch(`apply failed in worker: ${message.error}`);
      void kill(`apply failed: ${message.error}`);
      return;
    }
    if (message.t === "call-result") {
      const pending = rpcPending.get(message.id);
      if (pending === undefined) return;
      rpcPending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error ?? "service call failed"));
      return;
    }
    if (message.t === "svc-call") {
      void handleServiceCall(message);
      return;
    }
    if (message.t === "shutdown-ack") {
      if (shutdownWaiter === undefined) return;
      clearTimeout(shutdownWaiter.timer);
      const settle = shutdownWaiter;
      shutdownWaiter = undefined;
      settle.resolve({ ok: true, value: undefined });
      return;
    }
    if (message.t === "log") {
      const entry = message.entry as { where?: string; message?: string } | null;
      if (entry !== null) {
        deps.onRuntimeError(entry.where ?? "worker", entry.message ?? String(message.entry));
      }
    }
  });

  worker.on("exit", () => {
    if (intentional) return;
    void kill("worker exited unexpectedly");
  });
  worker.on("error", (error: Error) => {
    failLaunch(`worker crashed: ${String(error)}`);
    void kill(`worker crashed: ${String(error)}`);
  });

  async function handleServiceCall(message: {
    id: number;
    service: string;
    method: string;
    args: readonly unknown[];
  }): Promise<void> {
    const token = deps.tokenTable.get(message.service);
    const impl =
      token !== undefined
        ? (deps.platform.tryUse(token as ServiceToken<unknown>) as Record<string, unknown> | undefined)
        : undefined;
    const method = impl?.[message.method];
    if (impl === undefined || typeof method !== "function") {
      worker.postMessage({
        t: "svc-result",
        id: message.id,
        ok: false,
        error: `no platform service ${message.service}.${message.method}`,
      });
      return;
    }
    try {
      const value = await (method as (...args: unknown[]) => unknown)(...message.args);
      worker.postMessage({ t: "svc-result", id: message.id, ok: true, value });
    } catch (error) {
      worker.postMessage({ t: "svc-result", id: message.id, ok: false, error: String(error) });
    }
  }

  function serviceProxy(service: string): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, method) =>
        (...args: unknown[]) =>
          callService(service, String(method), args).then((result) => {
            if (result.ok) return result.value;
            throw new Error(result.reason);
          }),
    });
  }

  function forwardToWorker(token: string): (payload: unknown) => void {
    return (payload: unknown) => {
      // 载荷必须结构化克隆安全（协议约束）；投递即忘——卡死由后续 RPC 超时/击杀兜底
      try {
        worker.postMessage({ t: "emit", token, payload });
      } catch (error) {
        deps.onRuntimeError(`${token}@bridge`, String(error));
      }
    };
  }

  function callService(
    service: string,
    method: string,
    args: readonly unknown[],
  ): Promise<Result<unknown, string>> {
    rpcId += 1;
    const id = rpcId;
    return new Promise<Result<unknown, string>>((resolve) => {
      const timer = setTimeout(() => {
        rpcPending.delete(id);
        const reason = `runtime rpc timeout: ${service}.${method}`;
        void kill(reason).then(() => resolve({ ok: false, reason })); // 击杀收殓完成后才让调用方获知
      }, deps.runtimeTimeoutMs);
      rpcPending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve({ ok: true, value });
        },
        reject: (error) => {
          clearTimeout(timer);
          resolve({ ok: false, reason: String(error) });
        },
        timer,
      });
      worker.postMessage({ t: "call", id, service, method, args });
    });
  }

  return {
    launch() {
      return new Promise<Result<LaunchedPlugin, string>>((resolve) => {
        const timer = setTimeout(() => {
          failLaunch(`apply timeout after ${deps.applyTimeoutMs}ms`);
          void kill("apply timeout");
        }, deps.applyTimeoutMs);
        launcher = { resolve, timer };
        worker.postMessage({ t: "boot", pluginPath: deps.pluginPath, kernelApiVersion: 1 });
      });
    },
    callService,
    emitIn(token, payload) {
      worker.postMessage({ t: "emit", token, payload });
    },
    async shutdown() {
      intentional = true;
      const ack = new Promise<Result<undefined, string>>((resolve) => {
        const timer = setTimeout(() => {
          shutdownWaiter = undefined;
          resolve({ ok: false, reason: "shutdown ack timeout" });
        }, deps.runtimeTimeoutMs);
        shutdownWaiter = { resolve, timer };
      });
      worker.postMessage({ t: "shutdown" } satisfies MainToWorker);
      const result = await ack;
      await worker.terminate(); // ack 或超时后都收尸
      runTeardown();
      return result;
    },
    kill,
    serviceToken(name) {
      return bridgedTokens.get(name);
    },
  };
}
