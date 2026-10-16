import { definePlugin } from "../../../index";
import type { ServiceToken, EventToken, Result, Disposer } from "../../../index";

export function ok<T>(value: T): Result<T>;
export function ok(): Result<void>;
export function ok(value?: unknown): Result<unknown> { return { ok: true, value }; }

interface GreetingService {
  greet(input: { name: string }): Promise<Result<string>>;
}

interface UserStoreService {
  findUser(input: { id: string }): Promise<Result<string, { kind: "unavailable" }>>;
}

interface UsersService {
  find(input: { id: string }): Promise<Result<string, { kind: "unavailable" }>>;
}

interface DatabaseService {
  read(input: { key: string }): Promise<Result<string | null>>;
}

interface Connection {
  read(input: { key: string }, signal: AbortSignal): Promise<Result<string | null>>;
  close(signal: AbortSignal): Promise<Result<void>>;
}

export declare const greeting: ServiceToken<GreetingService>;
export declare const userStore: ServiceToken<UserStoreService>;
export declare const users: ServiceToken<UsersService>;
export declare const database: ServiceToken<DatabaseService>;
export declare const changed: EventToken<{ path: string }>;
export declare const narrow: ServiceToken<{ run(input: "only"): Promise<Result<string>> }>;
export declare const wide: ServiceToken<{ run(input: string): Promise<Result<string>> }>;
export type NarrowManifest = { requires: { source: typeof narrow } };
export type WideManifest = { requires: { source: typeof wide } };
export type NarrowProvider = { provides: { source: typeof narrow } };
export type WideProvider = { provides: { source: typeof wide } };
export declare function openConnection(signal: AbortSignal): Promise<Result<Connection>>;
export declare function updateIndex(path: string, signal: AbortSignal): Promise<void>;

export const greetingPlugin = definePlugin({
  name: "greeting",
  provides: { greeting },
  setup(ctx) {
    return ctx.service({
      greeting: {
        async greet(input) {
          return ok(`你好，${input.name}`);
        },
      },
    });
  },
});

export const usersPlugin = definePlugin({
  name: "users",
  requires: { userStore },
  provides: { users },
  setup(ctx) {
    return ctx.service({
      users: {
        async find(input, call) {
          return call.deps.userStore.findUser(input);
        },
      },
    });
  },
});

export const databasePlugin = definePlugin({
  name: "database",
  provides: { database },
  async setup(ctx) {
    const connected = await ctx.resource({
      open: (acquire) => openConnection(acquire.signal),
      close: (connection, cleanup) => connection.close(cleanup.signal),
    });
    if (!connected.ok) return connected;
    const connection = connected.value;
    return ctx.service({
      database: {
        async read(input, call) {
          return connection.read(input, call.signal);
        },
      },
    });
  },
});

export const indexPlugin = definePlugin({
  name: "index",
  requires: { changed },
  setup(ctx) {
    const listening = ctx.on("changed", async (event, _origin, call) => {
      await updateIndex(event.path, call.signal);
    });
    if (!listening.ok) return listening;
    return ok();
  },
});

export const setupDependencyPlugin = definePlugin({
  name: "setup-consumer",
  requires: { greeting },
  async setup(ctx) {
    const result = await ctx.deps.greeting.greet({ name: "小明" });
    if (!result.ok) return result;
    return ok();
  },
});

export const acquireFailurePlugin = definePlugin({
  name: "acquire-failure",
  async setup(ctx) {
    const result = await ctx.resource<Connection, { kind: "disconnected" }>({
      open: () => ({ ok: false, error: { kind: "disconnected" } }),
      close: (connection, cleanup) => connection.close(cleanup.signal),
    });
    if (!result.ok) return result;
    return ok();
  },
});

export const providerReceiptPlugin = definePlugin({
  name: "provider-receipt",
  provides: { greeting },
  setup(ctx) {
    const provided = ctx.service({
      greeting: {
        async greet(input) {
          return ok(input.name);
        },
      },
    });
    if (!provided.ok) return provided;
    const revoke: Disposer = provided.value.greeting;
    void revoke;
    return ok();
  },
});

export const acquireDependencyPlugin = definePlugin({
  name: "acquire-dependency",
  requires: { greeting },
  async setup(ctx) {
    return ctx.resource({
      open: (acquire) => acquire.deps.greeting.greet({ name: "初始化" }),
      close: () => ok(),
    });
  },
});

export function dynamicServicePlugin(provides: Record<string, ServiceToken<GreetingService>>) {
  const implementations = Object.fromEntries(Object.keys(provides).map((name) => [name, {
    async greet(input: { name: string }) { return ok(input.name); },
  }]));
  return definePlugin({ name: "dynamic-services", provides, setup(ctx) { return ctx.service(implementations); } });
}
