import type { AnyToken, Context, Disposer, EventToken, ServiceToken } from "@x-harness/core";
import { defineEvent, defineService } from "@x-harness/core";

export const META_TOKEN_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    "plugin-manager",
    "service/provided",
    "plugin/loaded",
    "plugin/unloaded",
    "plugin/error",
    "context/disposing",
    "plugin/event",
  ]),
);

export class CapabilityNameError extends Error {
  constructor(name: string) {
    super(`capability not available: "${name}"`);
  }
}

const serviceTokens = new Map<string, ServiceToken<unknown>>();
const eventTokens = new Map<string, EventToken<unknown>>();

export function syntheticServiceToken(name: string): ServiceToken<unknown> {
  const found = serviceTokens.get(name);
  if (found !== undefined) return found;
  const token = defineService<unknown>(name);
  serviceTokens.set(name, token);
  return token;
}

export function syntheticEventToken(name: string): EventToken<unknown> {
  const found = eventTokens.get(name);
  if (found !== undefined) return found;
  const token = defineEvent<unknown>(name);
  eventTokens.set(name, token);
  return token;
}

export interface PluginCapabilities {
  use<T = unknown>(name: string): T;
  tryUse<T = unknown>(name: string): T | undefined;
  waitFor<T = unknown>(name: string): Promise<T>;
  provide<T = unknown>(name: string, impl: T): Disposer;
  on(name: string, listener: (payload: unknown) => void): Disposer;
  emit(name: string, payload: unknown): void;
}

export interface CapabilitiesDeps {
  readonly resolveToken: (name: string) => AnyToken | undefined;
  readonly useToken: (token: ServiceToken<unknown>) => unknown;
  readonly tryUseToken: (token: ServiceToken<unknown>) => unknown | undefined;
  readonly waitForToken: (token: ServiceToken<unknown>) => Promise<unknown>;
  readonly provideToken: (token: ServiceToken<unknown>, impl: unknown) => Disposer;
  readonly onToken: (token: EventToken<unknown>, listener: (payload: unknown) => void) => Disposer;
  readonly emitToken: (token: EventToken<unknown>, payload: unknown) => void;
}

const isMeta = (name: string): boolean => META_TOKEN_NAMES.has(name);

export function createCapabilities(deps: CapabilitiesDeps): PluginCapabilities {
  return {
    use<T>(name: string): T {
      if (isMeta(name)) throw new CapabilityNameError(name);
      const token = deps.resolveToken(name);
      if (token === undefined || token.kind !== "service") throw new CapabilityNameError(name);
      return deps.useToken(token as ServiceToken<unknown>) as T;
    },
    tryUse<T>(name: string): T | undefined {
      if (isMeta(name)) return undefined;
      const token = deps.resolveToken(name);
      if (token === undefined || token.kind !== "service") return undefined;
      return deps.tryUseToken(token as ServiceToken<unknown>) as T | undefined;
    },
    waitFor<T>(name: string): Promise<T> {
      if (isMeta(name)) return Promise.reject(new CapabilityNameError(name));
      const token = deps.resolveToken(name);
      if (token === undefined || token.kind !== "service") {
        return Promise.reject(new CapabilityNameError(name));
      }
      return deps.waitForToken(token as ServiceToken<unknown>) as Promise<T>;
    },
    provide<T>(name: string, impl: T): Disposer {
      if (isMeta(name)) throw new CapabilityNameError(name);
      if (name.length === 0) throw new CapabilityNameError(name);
      return deps.provideToken(syntheticServiceToken(name), impl as unknown);
    },
    on(name: string, listener: (payload: unknown) => void): Disposer {
      if (isMeta(name)) throw new CapabilityNameError(name);
      return deps.onToken(syntheticEventToken(name), listener);
    },
    emit(name: string, payload: unknown): void {
      if (isMeta(name)) throw new CapabilityNameError(name);
      deps.emitToken(syntheticEventToken(name), payload);
    },
  };
}

export function createProcessCapabilities(
  platform: Context,
  tokenTable: Map<string, AnyToken>,
  onToken: (token: AnyToken) => void,
): PluginCapabilities {
  return createCapabilities({
    resolveToken: (name) => tokenTable.get(name),
    useToken: (token) => platform.use(token),
    tryUseToken: (token) => platform.tryUse(token),
    waitForToken: (token) => platform.waitFor(token),
    provideToken: (token, impl) => {
      onToken(token);
      return platform.provide(token, impl);
    },
    onToken: (token, listener) =>
      (platform.on as (t: AnyToken, f: unknown) => Disposer)(token, listener),
    emitToken: (token, payload) => platform.emit(token, payload),
  });
}
