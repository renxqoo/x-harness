import { definePlugin } from "../../../index";
import type {
  ChainToken,
  EventToken,
  PluginContext,
  PluginDependencies,
  PluginImplementations,
  PluginInvocation,
  PluginResource,
  PluginSpec,
  PluginTask,
  Result,
} from "../../../index";
import { changed, greeting, users, userStore, ok } from "./authoring-positive";
import type {
  NarrowManifest,
  WideManifest,
  NarrowProvider,
  WideProvider,
} from "./authoring-positive";

export const manifest = {
  requires: { userStore, changed },
  provides: { users },
  optional: { greeting },
};
type Manifest = typeof manifest;

export function find(
  call: PluginInvocation<Manifest>,
  input: { id: string },
): Promise<Result<string, { kind: "unavailable" }>> {
  if (call.deps.greeting) void call.deps.greeting.greet({ name: input.id });

  return call.deps.userStore.findUser(input);
}

export const implementations: PluginImplementations<Manifest> = {
  users: {
    async find(input, call) {
      return find(call, input);
    },
  },
};

export const resource: PluginResource<string, { kind: "unavailable" }, Manifest> = {
  open: (call) => find(call, { id: "open" }),
  close: () => ok(),
};

export const task: PluginTask<string, { kind: "unavailable" }, Manifest> = {
  label: "refresh",
  run: (call) => find(call, { id: "task" }),
};

export function setup(ctx: PluginContext<Manifest>) {
  const dependencies: PluginDependencies<Manifest> = ctx.deps;
  const required: Promise<Result<string, { kind: "unavailable" }>> =
    dependencies.userStore.findUser({ id: "setup" });
  void required;
  const started = ctx.startTask(task);

  if (!started.ok) return started;

  const listening = ctx.on("changed", async (input, _origin, call) => {
    await find(call, { id: input.path });
  });

  if (!listening.ok) return listening;

  return ctx.service(implementations);
}

export const spec: PluginSpec<Manifest> = { name: "manifest", ...manifest, setup };
export const plugin = definePlugin(spec);

type ConditionalManifest = {
  requires?: typeof manifest.requires;
  provides?: typeof manifest.provides;
  optional?: typeof manifest.optional;
};
export const absentDependencies: PluginDependencies<ConditionalManifest> = {};
export const conditionalSpec: PluginSpec<ConditionalManifest> = {
  name: "conditional",
  setup() {
    return ok();
  },
};
export const conditionalPlugin = definePlugin<ConditionalManifest>(conditionalSpec);
export const undefinedSpec: PluginSpec<{ requires: typeof manifest.requires | undefined }> = {
  name: "undefined",
  requires: undefined,
  setup() {
    return ok();
  },
};

function subscribe(ctx: PluginContext<{ requires: { changed: typeof changed } }>) {
  return ctx.on("changed", async (payload) => {
    const path: string = payload.path;
    void path;
  });
}

export const subscription = definePlugin({
  name: "subscription",
  requires: { changed, userStore },
  setup: subscribe,
});
type UnionManifest =
  | { requires: { changed: typeof changed; userStore: typeof userStore } }
  | {
      requires: { changed: typeof changed; userStore: typeof userStore; greeting: typeof greeting };
    };
export const commonUnion = definePlugin<UnionManifest>({
  name: "common-union",
  requires: { changed, userStore },
  setup(ctx) {
    return ctx.deps.userStore.findUser({ id: "common" });
  },
});

declare const changedNumber: EventToken<number>;
declare const textChain: ChainToken<string, number>;
declare const numberChain: ChainToken<number, string>;
const multiple = { requires: { changed, changedNumber, textChain, numberChain } };
export const multiplePlugin = definePlugin({
  name: "multiple",
  ...multiple,
  setup(ctx) {
    const first = ctx.on("changed", async (payload) => {
      const path: string = payload.path;
      void path;
    });

    if (!first.ok) return first;

    const second = ctx.on("changedNumber", async (payload) => {
      const number: number = payload;
      void number;
    });

    if (!second.ok) return second;

    const text: Promise<Result<number>> = ctx.dispatch("textChain", "input");
    const number: Promise<Result<string>> = ctx.dispatch("numberChain", 42);
    void text;
    void number;
    return ctx.middleware("numberChain", (input, next) => {
      const value: number = input;
      return next(value);
    });
  },
});

function publish(ctx: Pick<PluginContext<{ provides: { changed: typeof changed } }>, "emit">) {
  return ctx.emit("changed", { path: "input" });
}

export const subsetPublisher = definePlugin({
  name: "subset-publisher",
  provides: { changed, changedNumber },
  setup: publish,
});

function dispatch(
  call: Pick<PluginInvocation<{ requires: { textChain: typeof textChain } }>, "dispatch">,
) {
  return call.dispatch("textChain", "input");
}

export const subsetTask = definePlugin({
  name: "subset-task",
  ...multiple,
  setup(ctx) {
    return ctx.startTask({ label: "subset", run: dispatch });
  },
});

declare const changedSecond: typeof changed;
declare const textChainSecond: typeof textChain;

export function dynamicPublisher(
  name: "first" | "second",
  ctx: PluginContext<{ provides: { first: typeof changed; second: typeof changedSecond } }>,
) {
  return ctx.emit(name, { path: "dynamic" });
}

export function dynamicListener(
  name: "first" | "second",
  ctx: PluginContext<{ requires: { first: typeof changed; second: typeof changedSecond } }>,
) {
  return ctx.on(name, async (payload) => {
    const path: string = payload.path;
    void path;
  });
}

export function dynamicDispatch(
  name: "first" | "second",
  call: PluginInvocation<{ requires: { first: typeof textChain; second: typeof textChainSecond } }>,
): Promise<Result<number>> {
  return call.dispatch(name, "dynamic");
}

declare const broadImplementation: PluginImplementations<WideProvider>;
export const acceptsNarrowInput: PluginImplementations<NarrowProvider> = broadImplementation;
declare const narrowTask: PluginTask<string, never, NarrowManifest>;
export const taskWithBroadSource: PluginTask<string, never, WideManifest> = narrowTask;
declare const narrowResource: PluginResource<string, never, NarrowManifest>;
export const resourceWithBroadSource: PluginResource<string, never, WideManifest> = narrowResource;
