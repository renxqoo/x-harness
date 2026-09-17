// worker 侧宿主（docs/PLUGIN-MANAGER.md §4 worker/host.ts）：
// 在 worker 内启动真实内核 → 动态加载用户插件（磁盘 TS，query 缓存 bust）→
// capture 桥把插件的注册面折算为协议消息（provide/listening），并代理平台服务的反向调用。
// 同步死循环/OOM 崩溃由 main 侧超时 terminate / exit 事件收殓——本文件不做任何自救。

import { parentPort } from "node:worker_threads";
import {
  createContext,
  loadPlugins,
} from "@x-harness/core";
import type {
  AnyToken,
  Chain,
  ChainMiddleware,
  Context,
  Disposer,
  EventToken,
  ScopeFilter,
  ServiceToken,
} from "@x-harness/core";
import type { MainToWorker, WorkerToMain } from "./protocol.ts";

const port = parentPort;
if (port === null) throw new Error("plugin host must run as a worker thread");
const send = (message: WorkerToMain): void => {
  port.postMessage(message);
};

const ctx = createContext();
const tokenByName = new Map<string, AnyToken>();
const providedImpls = new Map<string, unknown>();
let svcCallId = 0;
const pendingSvcCalls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

port.on(
  "message",
  (message: MainToWorker) => {
    void handle(message).catch((error: unknown) => {
      send({ t: "apply-error", error: String(error) });
    });
  },
);

async function handle(message: MainToWorker): Promise<void> {
  if (message.t === "boot") {
    const mod = (await import(`${message.pluginPath}?t=${Date.now()}`)) as {
      default?: unknown;
      plugin?: unknown;
    };
    const plugin = (mod.default ?? mod.plugin) as
      | { name?: unknown; apply?: unknown; apiVersion?: unknown }
      | undefined;
    if (
      plugin === undefined ||
      typeof plugin !== "object" ||
      typeof plugin.name !== "string" ||
      plugin.name.length === 0 ||
      typeof plugin.apply !== "function"
    ) {
      send({ t: "apply-error", error: "module default export is not a Plugin" });
      return;
    }
    send({
      t: "ready",
      pluginName: plugin.name,
      apiVersion: plugin.apiVersion as number | undefined,
      inject: [...((plugin as { inject?: readonly string[] }).inject ?? [])],
    });
    await loadPlugins(ctx, [bridged(plugin as Parameters<typeof loadPlugins>[1][number])]);
    send({ t: "apply-done" });
    return;
  }
  if (message.t === "call") {
    const impl = providedImpls.get(message.service) as Record<string, unknown> | undefined;
    if (impl === undefined || typeof impl[message.method] !== "function") {
      send({ t: "call-result", id: message.id, ok: false, error: `no such service method ${message.service}.${message.method}` });
      return;
    }
    try {
      const value = await (impl[message.method] as (...args: unknown[]) => unknown)(
        ...message.args,
      );
      send({ t: "call-result", id: message.id, ok: true, value });
    } catch (error) {
      send({ t: "call-result", id: message.id, ok: false, error: String(error) });
    }
    return;
  }
  if (message.t === "svc-result") {
    const pending = pendingSvcCalls.get(message.id);
    if (pending === undefined) return;
    pendingSvcCalls.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error ?? "service call failed"));
    return;
  }
  if (message.t === "emit") {
    const token = tokenByName.get(message.token) as EventToken<unknown> | undefined;
    if (token !== undefined) ctx.emit(token, message.payload);
    return;
  }
  if (message.t === "shutdown") {
    await ctx.dispose();
    send({ t: "shutdown-ack" });
    return;
  }
}

/** 插件的 Context 视图：真实注册落在 worker 内核 + 协议镜像给 main */
function bridged(plugin: Parameters<typeof loadPlugins>[1][number]): Parameters<typeof loadPlugins>[1][number] {
  const wrapper = {
    provide<T>(token: ServiceToken<T>, impl: T): Disposer {
      tokenByName.set(token.name, token);
      providedImpls.set(token.name, impl);
      send({ t: "provided", service: token.name });
      return ctx.provide(token, impl);
    },
    use<T>(token: ServiceToken<T>): T {
      const local = ctx.tryUse(token);
      if (local !== undefined) return local; // worker 内自给的服务直取
      // 平台服务在 main：异步 RPC 代理（一切方法调用经 svc-call 往返）
      return new Proxy({} as Record<string, unknown>, {
        get: (_target, method) =>
          (...args: unknown[]) =>
            new Promise<unknown>((resolve, reject) => {
              svcCallId += 1;
              const id = svcCallId;
              pendingSvcCalls.set(id, { resolve, reject });
              send({ t: "svc-call", id, service: token.name, method: String(method), args });
            }),
      }) as T;
    },
    tryUse<T>(token: ServiceToken<T>): T | undefined {
      return ctx.tryUse(token);
    },
    waitFor<T>(token: ServiceToken<T>): Promise<T> {
      return ctx.waitFor(token);
    },
    on(token: AnyToken, fn: unknown, opts?: { readonly prepend?: boolean }): Disposer {
      tokenByName.set(token.name, token);
      send({ t: "listening", token: token.name, mode: "mode" in token ? token.mode : "unknown" });
      const wrapped = (payload: unknown): unknown => {
        const out = (fn as (p: unknown) => unknown)(payload);
        send({ t: "heard", token: token.name, payload });
        return out;
      };
      return (ctx.on as (t: AnyToken, f: unknown, o?: { readonly prepend?: boolean }) => Disposer)(
        token,
        wrapped,
        opts,
      );
    },
    emit<T>(token: EventToken<T>, payload: T): void {
      tokenByName.set(token.name, token);
      ctx.emit(token, payload);
    },
    dispatch(token: AnyToken, payloadOrInput: unknown, final?: unknown): Promise<unknown> {
      return (ctx.dispatch as (t: AnyToken, i: unknown, f?: unknown) => Promise<unknown>)(
        token,
        payloadOrInput,
        final,
      );
    },
    createChain<I, O>(final: (input: I) => Promise<O>): Chain<I, O> {
      return ctx.createChain(final);
    },
    onChain<I, O>(
      chain: Chain<I, O>,
      middleware: ChainMiddleware<I, O>,
      opts?: { readonly prepend?: boolean },
    ): Disposer {
      return (ctx.onChain as (
        c: Chain<I, O>,
        m: ChainMiddleware<I, O>,
        o?: { readonly prepend?: boolean },
      ) => Disposer)(chain, middleware, opts);
    },
    effect(disposer: Disposer): void {
      ctx.effect(disposer);
    },
    dispose(): Promise<void> {
      return ctx.dispose();
    },
    scope(filter: ScopeFilter): Context {
      return ctx.scope(filter);
    },
  } as unknown as Context;
  // inject 刻意丢弃：跨插件依赖语义归 main 侧 plugin-manager
  return { name: plugin.name, apply: () => plugin.apply(wrapper) };
}
