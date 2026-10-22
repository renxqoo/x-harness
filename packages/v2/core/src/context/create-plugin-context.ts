import type { PluginContext, PluginManifest, TokenMap } from "../contracts/plugin-types";
import type { Context } from "../contracts/types";
import { createFault } from "../contracts/create-fault";
import { registerPluginHandler } from "./register-plugin-handler";
import { readCapability } from "./read-capability";
import { retainRevocation } from "./retain-revocation";

interface PluginCell {
  current?: { context: Context; declaration: PluginManifest; definitions: TokenMap };
}

export function createPluginContext<M extends PluginManifest>(
  context: Context,
  declaration: PluginManifest,
): PluginContext<M> {
  const cell: PluginCell = {
    current: {
      context,
      declaration,
      definitions: Object.freeze({
        ...declaration.requires,
        ...declaration.optional,
        ...declaration.provides,
      }),
    },
  };
  retainRevocation(context, () => {
    cell.current = undefined;
  });
  return facade(cell, {
    scopeId: context.scopeId,
    signal: context.signal,
    deps: context.deps,
  }) as unknown as PluginContext<M>;
}

function facade(cell: PluginCell, metadata: Pick<Context, "scopeId" | "signal" | "deps">) {
  return Object.freeze({
    ...metadata,
    get scopeState() {
      return cell.current?.context.scopeState ?? "closed";
    },
    service: (...args: Parameters<Context["service"]>) =>
      cell.current ? cell.current.context.service(...args) : createFault("scope-closed"),
    resource: (...args: Parameters<Context["resource"]>) =>
      cell.current
        ? cell.current.context.resource(...args)
        : Promise.resolve(createFault("scope-closed")),
    createScope: (...args: Parameters<Context["createScope"]>) =>
      cell.current ? cell.current.context.createScope(...args) : createFault("scope-closed"),
    addCleanup: (...args: Parameters<Context["addCleanup"]>) =>
      cell.current ? cell.current.context.addCleanup(...args) : createFault("scope-closed"),
    startTask: (...args: Parameters<Context["startTask"]>) =>
      cell.current ? cell.current.context.startTask(...args) : createFault("scope-closed"),
    requestClose: () =>
      cell.current ? cell.current.context.requestClose() : createFault("scope-closed"),
    handle(
      name: unknown,
      terminal: unknown,
      options?: import("../contracts/types").RegistrationOptions,
    ) {
      if (!cell.current) return createFault("scope-closed");

      const { context, declaration } = cell.current;
      const token = readCapability(declaration.provides ?? {}, name);

      if (!token.ok) return token;

      if (token.value.kind !== "chain") return createFault("invalid-definition");

      return context.handle(token.value as never, terminal as never, options);
    },
    on(name: unknown, handler: unknown) {
      if (!cell.current) return createFault("scope-closed");

      return registerPluginHandler(cell.current.context, cell.current.definitions, {
        kind: "event",
        name,
        handler,
      });
    },
    middleware(name: unknown, handler: unknown) {
      if (!cell.current) return createFault("scope-closed");

      return registerPluginHandler(cell.current.context, cell.current.definitions, {
        kind: "chain",
        name,
        handler,
      });
    },
    guard(name: unknown, handler: unknown) {
      if (!cell.current) return createFault("scope-closed");

      return registerPluginHandler(cell.current.context, cell.current.definitions, {
        kind: "guard",
        name,
        handler,
      });
    },
    dispatch(name: unknown, input: unknown, options?: import("../contracts/types").CallOptions) {
      if (!cell.current) return Promise.resolve(createFault("scope-closed"));

      const { context, definitions } = cell.current;
      const token = readCapability(definitions, name);

      if (!token.ok) return Promise.resolve(token);

      if (token.value.kind !== "chain" && token.value.kind !== "guard")
        return Promise.resolve(createFault("undeclared-dependency"));

      return context.dispatch(token.value as never, input, options);
    },
    emit(name: unknown, payload: unknown) {
      if (!cell.current) return createFault("scope-closed");

      const { context, declaration } = cell.current;
      const token = readCapability(declaration.provides ?? {}, name);

      if (!token.ok) return token;

      if (token.value.kind !== "event") return createFault("undeclared-dependency");

      return context.emit(token.value as never, payload);
    },
  });
}
