import { parentPort } from "node:worker_threads";
import { createContext, loadPlugins } from "@x-harness/core";
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
import { createCapabilities, META_TOKEN_NAMES, syntheticServiceToken } from "../capabilities.ts";

const port = parentPort;
if (port === null) throw new Error("plugin host must run as a worker thread");
const send = (message: WorkerToMain): void => {
  port.postMessage(message);
};

const ctx = createContext({
  onListenerError: (error, token) => {
    send({ t: "log", entry: { where: `${token.name}@worker`, message: String(error) } });
  },
});
const tokenByName = new Map<string, AnyToken>();
const providedImpls = new Map<string, unknown>();
let rpcId = 0;
const pendingRpc = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

port.on("message", (message: MainToWorker) => {
  void handle(message).catch((error: unknown) => {
    send({ t: "apply-error", error: String(error) });
  });
});

async function handle(message: MainToWorker): Promise<void> {
  switch (message.t) {
    case "boot":
      await handleBoot(message);
      return;
    case "proceed":
      await handleProceed();
      return;
    case "call":
      await handleCall(message);
      return;
    case "svc-result":
      handleSvcResult(message);
      return;
    case "emit":
      handleEmit(message);
      return;
    case "shutdown":
      await handleShutdown();
      return;
  }
}

async function handleBoot(message: Extract<MainToWorker, { t: "boot" }>): Promise<void> {
  const mod = (await import(message.pluginPath)) as {
    default?: unknown;
    plugin?: unknown;
  };
  const plugin = (mod.default ?? mod.plugin) as
    | { name?: unknown; apply?: unknown; apiVersion?: unknown; inject?: readonly string[] }
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
  pendingPlugin = {
    name: plugin.name,
    apply: plugin.apply as (ctx: Context, capabilities?: unknown) => unknown,
  };
  send({
    t: "ready",
    pluginName: plugin.name,
    apiVersion: plugin.apiVersion as number | undefined,
    inject: [...(plugin.inject ?? [])],
  });
}

async function handleProceed(): Promise<void> {
  const current = pendingPlugin;
  if (current === undefined) {
    send({ t: "apply-error", error: "proceed without boot" });
    return;
  }
  await loadPlugins(ctx, [bridged(current)]);
  send({ t: "apply-done" });
}

async function handleCall(message: Extract<MainToWorker, { t: "call" }>): Promise<void> {
  const impl = providedImpls.get(message.service) as Record<string, unknown> | undefined;
  if (impl === undefined || typeof impl[message.method] !== "function") {
    send({
      t: "call-result",
      id: message.id,
      ok: false,
      error: `no such service method ${message.service}.${message.method}`,
    });
    return;
  }
  try {
    const value = await (impl[message.method] as (...args: unknown[]) => unknown)(...message.args);
    send({ t: "call-result", id: message.id, ok: true, value });
  } catch (error) {
    send({ t: "call-result", id: message.id, ok: false, error: String(error) });
  }
}

function handleSvcResult(message: Extract<MainToWorker, { t: "svc-result" }>): void {
  const pending = pendingRpc.get(message.id);
  if (pending === undefined) return;
  pendingRpc.delete(message.id);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new Error(message.error ?? "service call failed"));
}

function handleEmit(message: Extract<MainToWorker, { t: "emit" }>): void {
  const token = tokenByName.get(message.token) as EventToken<unknown> | undefined;
  if (token !== undefined) ctx.emit(token, message.payload);
}

async function handleShutdown(): Promise<void> {
  await ctx.dispose();
  send({ t: "shutdown-ack" });
}

let pendingPlugin: { name: string; apply: (ctx: Context, capabilities?: unknown) => unknown } | undefined;

function bridged(plugin: { name: string; apply: (ctx: Context, capabilities?: unknown) => unknown }): Parameters<typeof loadPlugins>[1][number] {
  const wrapper = {
    provide<T>(token: ServiceToken<T>, impl: T): Disposer {
      tokenByName.set(token.name, token);
      providedImpls.set(token.name, impl);
      send({ t: "provided", service: token.name });
      return ctx.provide(token, impl);
    },
    use<T>(token: ServiceToken<T>): T {
      const local = ctx.tryUse(token);
      if (local !== undefined) return local;
      return new Proxy({} as Record<string, unknown>, {
        get: (_target, method) => {
          if (method === "then" || method === "catch") return undefined;
          return (...args: unknown[]) =>
            new Promise<unknown>((resolve, reject) => {
              rpcId += 1;
              const id = rpcId;
              pendingRpc.set(id, { resolve, reject });
              send({ t: "svc-call", id, service: token.name, method: String(method), args });
            });
        },
      }) as T;
    },
    tryUse<T>(token: ServiceToken<T>): T | undefined {
      return ctx.tryUse(token);
    },
    waitFor<T>(token: ServiceToken<T>): Promise<T> {
      const local = ctx.tryUse<T>(token);
      if (local !== undefined) return Promise.resolve(local);
      return new Promise<T>((resolve, reject) => {
        rpcId += 1;
        const id = rpcId;
        pendingRpc.set(id, {
          resolve: () => {
            resolve(
              new Proxy({} as Record<string, unknown>, {
                get: (_target, method) => {
                  if (method === "then" || method === "catch") return undefined;
                  return (...args: unknown[]) =>
                    new Promise<unknown>((resolveCall, rejectCall) => {
                      rpcId += 1;
                      const callId = rpcId;
                      pendingRpc.set(callId, { resolve: resolveCall, reject: rejectCall });
                      send({ t: "svc-call", id: callId, service: token.name, method: String(method), args });
                    });
                },
              }) as T,
            );
          },
          reject,
        });
        send({ t: "svc-wait", id, service: token.name });
      });
    },
    on(token: AnyToken, fn: unknown, opts?: { readonly prepend?: boolean }): Disposer {
      if (META_TOKEN_NAMES.has(token.name)) {
        throw new Error(`listening on meta token not allowed in worker mode: ${token.name}`);
      }
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
  const capabilities = createCapabilities({
    resolveToken: (name) => syntheticServiceToken(name),
    useToken: (token) => wrapper.use(token as ServiceToken<unknown>),
    tryUseToken: (token) => wrapper.tryUse(token as ServiceToken<unknown>),
    waitForToken: (token) => wrapper.waitFor(token as ServiceToken<unknown>),
    provideToken: (token, impl) => wrapper.provide(token as ServiceToken<unknown>, impl),
    onToken: (token, listener) =>
      (wrapper.on as (t: AnyToken, f: unknown) => Disposer)(token, listener),
    emitToken: (token, payload) => wrapper.emit(token as EventToken<unknown>, payload),
  });
  return {
    name: plugin.name,
    apply: (): void | Disposer | Promise<void | Disposer> => {
      const out = plugin.apply(wrapper, capabilities);
      if (out === undefined || out === null) return undefined;
      return out as Disposer;
    },
  };
}
