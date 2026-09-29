import { Worker } from "node:worker_threads";
import { defineService } from "@x-harness/core";
import type { AnyToken, Context, ServiceToken } from "@x-harness/core";
import type { MainToWorker, WorkerToMain } from "./worker/protocol.ts";
import type { Result } from "./types.ts";

export interface BridgeDeps {
  readonly pluginPath: string;
  readonly platform: Context;
  readonly tokenTable: Map<string, AnyToken>;
  readonly applyTimeoutMs: number;
  readonly runtimeTimeoutMs: number;
  readonly kernelApiVersion: number;
  readonly hostPath: string;
  readonly onRuntimeError: (where: string, message: string) => void;
  readonly onKilled: (reason: string) => void;
}

export interface ReadyInfo {
  readonly name: string;
  readonly inject: readonly string[];
}

export interface WorkerBridge {
  begin(): Promise<Result<ReadyInfo, string>>;
  proceed(): Promise<Result<undefined, string>>;
  callService(service: string, method: string, args: readonly unknown[]): Promise<Result<unknown, string>>;
  emitIn(token: string, payload: unknown): void;
  shutdown(): Promise<Result<undefined, string>>;
  kill(reason: string): Promise<void>;
  isDead(): boolean;
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
  const bridgedNames: string[] = [];
  let rpcId = 0;
  let intentional = false;
  let dead = false;
  let readyWaiter:
    | { resolve(r: Result<ReadyInfo, string>): void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  let proceedWaiter:
    | { resolve(r: Result<undefined, string>): void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  let readyInfo: ReadyInfo | undefined;
  let shutdownWaiter:
    | { resolve(r: Result<undefined, string>): void; timer: ReturnType<typeof setTimeout> }
    | undefined;

  const failReady = (reason: string): void => {
    if (readyWaiter === undefined) return;
    clearTimeout(readyWaiter.timer);
    const settle = readyWaiter;
    readyWaiter = undefined;
    settle.resolve({ ok: false, reason });
  };
  const failProceed = (reason: string): void => {
    if (proceedWaiter === undefined) return;
    clearTimeout(proceedWaiter.timer);
    const settle = proceedWaiter;
    proceedWaiter = undefined;
    settle.resolve({ ok: false, reason });
  };

  const settlePending = (cause: string): void => {
    for (const pending of rpcPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(cause));
    }
    rpcPending.clear();
  };

  const runTeardown = (): void => {
    for (const dispose of teardown.splice(0)) dispose();
    for (const name of bridgedNames.splice(0)) {
      if (deps.tokenTable.get(name) === bridgedTokens.get(name)) deps.tokenTable.delete(name);
    }
  };

  const kill = async (reason: string): Promise<void> => {
    if (dead) return;
    dead = true;
    intentional = true;
    failReady(`worker killed: ${reason}`);
    failProceed(`worker killed: ${reason}`);
    settlePending(`worker killed: ${reason}`);
    if (shutdownWaiter !== undefined) {
      clearTimeout(shutdownWaiter.timer);
      const settle = shutdownWaiter;
      shutdownWaiter = undefined;
      settle.resolve({ ok: false, reason: `worker killed: ${reason}` });
    }
    await worker.terminate();
    runTeardown();
    deps.onKilled(reason);
  };

  deps.platform.effect(() => kill("platform disposed"));

  function onReady(message: Extract<WorkerToMain, { t: "ready" }>): void {
    if (message.apiVersion !== undefined && message.apiVersion !== deps.kernelApiVersion) {
      failReady(`plugin apiVersion ${message.apiVersion} does not match kernel ${deps.kernelApiVersion}`);
      void kill(`apiVersion mismatch: ${message.apiVersion}`);
      return;
    }
    readyInfo = { name: message.pluginName, inject: message.inject };
    if (readyWaiter === undefined) return;
    clearTimeout(readyWaiter.timer);
    const settle = readyWaiter;
    readyWaiter = undefined;
    settle.resolve({ ok: true, value: readyInfo });
  }

  function onProvided(message: Extract<WorkerToMain, { t: "provided" }>): void {
    const token = deps.tokenTable.get(message.service) ?? defineService<unknown>(message.service);
    bridgedTokens.set(message.service, token as ServiceToken<unknown>);
    deps.tokenTable.set(message.service, token);
    bridgedNames.push(message.service);
    try {
      const dispose = deps.platform.provide(token as ServiceToken<unknown>, serviceProxy(message.service));
      teardown.push(dispose);
    } catch (error) {
      failProceed(`provided service "${message.service}" conflicts on platform: ${String(error)}`);
      void kill(`service conflict: ${message.service}`);
    }
  }

  function recordViolation(reason: string, where: string): void {
    violations.push(reason);
    if (proceedWaiter === undefined && readyInfo !== undefined) {
      deps.onRuntimeError(where, `constraint violation ignored: ${reason}`);
    }
  }

  function onListening(message: Extract<WorkerToMain, { t: "listening" }>): void {
    if (message.mode !== "emit") {
      recordViolation(
        `${message.mode} listener not supported in worker mode: ${message.token}`,
        `${message.token}@${message.mode}`,
      );
      return;
    }
    const token = deps.tokenTable.get(message.token);
    if (token === undefined) {
      recordViolation(`listening on unregistered token: ${message.token}`, `${message.token}@emit`);
      return;
    }
    deps.tokenTable.set(message.token, token);
    const dispose = (deps.platform.on as (t: AnyToken, f: unknown) => () => void)(
      token,
      forwardToWorker(message.token),
    );
    teardown.push(dispose);
  }

  function onApplyDone(): void {
    if (proceedWaiter === undefined) return;
    if (violations.length > 0) {
      const reason = `worker-mode constraint violated: ${violations.join("; ")}`;
      failProceed(reason);
      void kill(`constraint violation: ${reason}`);
      return;
    }
    clearTimeout(proceedWaiter.timer);
    const settle = proceedWaiter;
    proceedWaiter = undefined;
    settle.resolve({ ok: true, value: undefined });
  }

  function onCallResult(message: Extract<WorkerToMain, { t: "call-result" }>): void {
    const pending = rpcPending.get(message.id);
    if (pending === undefined) return;
    rpcPending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error ?? "service call failed"));
  }

  function onShutdownAck(): void {
    if (shutdownWaiter === undefined) return;
    clearTimeout(shutdownWaiter.timer);
    const settle = shutdownWaiter;
    shutdownWaiter = undefined;
    settle.resolve({ ok: true, value: undefined });
  }

  worker.on("message", (message: WorkerToMain) => {
    switch (message.t) {
      case "ready":
        onReady(message);
        return;
      case "provided":
        onProvided(message);
        return;
      case "listening":
        onListening(message);
        return;
      case "apply-done":
        onApplyDone();
        return;
      case "apply-error":
        failProceed(`apply failed in worker: ${message.error}`);
        void kill(`apply failed: ${message.error}`);
        return;
      case "call-result":
        onCallResult(message);
        return;
      case "svc-call":
        void handleServiceCall(message);
        return;
      case "svc-wait":
        void handleServiceWait(message);
        return;
      case "shutdown-ack":
        onShutdownAck();
        return;
      case "log":
        deps.onRuntimeError(message.entry.where, message.entry.message);
        return;
    }
  });

  worker.on("exit", () => {
    if (intentional && shutdownWaiter !== undefined) {
      clearTimeout(shutdownWaiter.timer);
      const settle = shutdownWaiter;
      shutdownWaiter = undefined;
      runTeardown();
      settle.resolve({ ok: false, reason: "worker exited during shutdown" });
      return;
    }
    if (intentional) return;
    failReady("worker exited unexpectedly");
    failProceed("worker exited unexpectedly");
    void kill("worker exited unexpectedly");
  });
  worker.on("error", (error: Error) => {
    failReady(`worker crashed: ${String(error)}`);
    failProceed(`worker crashed: ${String(error)}`);
    void kill(`worker crashed: ${String(error)}`);
  });

  async function lookupPlatformService(service: string): Promise<Record<string, unknown> | undefined> {
    const token = deps.tokenTable.get(service);
    if (token === undefined) return undefined;
    return deps.platform.tryUse(token as ServiceToken<unknown>) as Record<string, unknown> | undefined;
  }

  async function handleServiceCall(message: {
    id: number;
    service: string;
    method: string;
    args: readonly unknown[];
  }): Promise<void> {
    const impl = await lookupPlatformService(message.service);
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

  async function handleServiceWait(message: { id: number; service: string }): Promise<void> {
    const token = deps.tokenTable.get(message.service);
    if (token === undefined) {
      worker.postMessage({
        t: "svc-result",
        id: message.id,
        ok: false,
        error: `no platform service token ${message.service}`,
      });
      return;
    }
    try {
      await deps.platform.waitFor(token as ServiceToken<unknown>);
      worker.postMessage({ t: "svc-result", id: message.id, ok: true });
    } catch (error) {
      worker.postMessage({ t: "svc-result", id: message.id, ok: false, error: String(error) });
    }
  }

  function serviceProxy(service: string): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, method) => {
        if (method === "then" || method === "catch") return undefined;
        return (...args: unknown[]) =>
          callService(service, String(method), args).then((result) => {
            if (result.ok) return result.value;
            throw new Error(result.reason);
          });
      },
    });
  }

  function forwardToWorker(token: string): (payload: unknown) => void {
    return (payload: unknown) => {
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
        void kill(reason).then(() => resolve({ ok: false, reason }));
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
    begin() {
      return new Promise<Result<ReadyInfo, string>>((resolve) => {
        const timer = setTimeout(() => {
          failReady(`boot timeout after ${deps.applyTimeoutMs}ms`);
          void kill("boot timeout");
        }, deps.applyTimeoutMs);
        readyWaiter = { resolve, timer };
        worker.postMessage({ t: "boot", pluginPath: deps.pluginPath, kernelApiVersion: deps.kernelApiVersion });
      });
    },
    proceed() {
      return new Promise<Result<undefined, string>>((resolve) => {
        const timer = setTimeout(() => {
          failProceed(`apply timeout after ${deps.applyTimeoutMs}ms`);
          void kill("apply timeout");
        }, deps.applyTimeoutMs);
        proceedWaiter = { resolve, timer };
        worker.postMessage({ t: "proceed" } satisfies MainToWorker);
      });
    },
    callService,
    emitIn(token, payload) {
      worker.postMessage({ t: "emit", token, payload });
    },
    async shutdown() {
      if (dead) return { ok: false as const, reason: "already shut down" };
      if (shutdownWaiter !== undefined) return { ok: false as const, reason: "shutdown already in progress" };
      intentional = true;
      dead = true;
      failReady("worker shut down");
      failProceed("worker shut down");
      settlePending("worker shut down");
      const ack = new Promise<Result<undefined, string>>((resolve) => {
        const timer = setTimeout(() => {
          shutdownWaiter = undefined;
          resolve({ ok: false, reason: "shutdown ack timeout" });
        }, deps.runtimeTimeoutMs);
        shutdownWaiter = { resolve, timer };
      });
      worker.postMessage({ t: "shutdown" } satisfies MainToWorker);
      const result = await ack;
      await worker.terminate();
      runTeardown();
      return result;
    },
    kill,
    isDead() {
      return dead;
    },
    serviceToken(name) {
      return bridgedTokens.get(name);
    },
  };
}
