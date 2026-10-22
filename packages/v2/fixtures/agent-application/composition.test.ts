import { expect, it } from "vitest";
import { createHost, defineChain, defineGuard, defineService } from "../../core/src/index";
import type { Disposer, Plugin, Result } from "../../core/src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const invalid = (): Result<never> => ({
  ok: false,
  error: { source: "core", code: "invalid-input", message: "invalid-input" },
});

const text = (input: unknown): Result<string> =>
  typeof input === "string" ? { ok: true, value: input } : invalid();

const messages = (input: unknown): Result<readonly string[]> =>
  Array.isArray(input) && input.every((entry: unknown) => typeof entry === "string")
    ? { ok: true, value: input as readonly string[] }
    : invalid();

it("external prompt, skill, compression and retry plugins compose without kernel business types", async () => {
  const host = value(createHost());
  const materials = value(
    defineService<{ put(input: { key: string; text: string }): Promise<Result<Disposer>> }>({
      name: "app/context-material",
      methods: { put: {} },
    }),
  );
  const compose = value(
    defineChain({ name: "app/context-compose", input: text, output: messages }),
  );
  const model = value(
    defineChain<readonly string[], string, { kind: "transient" }>({
      name: "app/model",
      input: messages,
      output: text,
    }),
  );
  const agent = value(
    defineService<{ run(input: string): Promise<Result<string, { kind: "transient" }>> }>({
      name: "app/agent",
      methods: { run: {} },
    }),
  );
  const records = value(
    defineService<{
      append(input: { type: "agent/message"; content: string }): Promise<Result<void>>;
    }>({ name: "app/records", methods: { append: {} } }),
  );
  const stored = new Map<string, string>();
  const facts: { type: "agent/message"; content: string }[] = [];
  const requests: (readonly string[])[] = [];
  const plugins: Plugin[] = [
    {
      name: "context-provider",
      provides: { materials, compose },
      setup(ctx) {
        const provided = ctx.register(materials, {
          put(input, call) {
            const key = `${call.origin.scopeId}/${call.origin.pluginName}/${input.key}`;
            stored.set(key, input.text);
            return Promise.resolve(
              call.effect(() => {
                stored.delete(key);
                return { ok: true, value: undefined };
              }),
            );
          },
        });

        if (!provided.ok) return provided;

        return ctx.register(compose, (prompt) => ({
          ok: true,
          value: [...stored.values(), prompt],
        }));
      },
    },
    {
      name: "records",
      provides: { records },
      setup(ctx) {
        return ctx.register(records, {
          append(input) {
            facts.push(Object.freeze({ ...input }));
            return Promise.resolve({ ok: true, value: undefined });
          },
        });
      },
    },
    {
      name: "model",
      provides: { model },
      setup(ctx) {
        return ctx.register(model, (input) => {
          requests.push(input);
          return requests.length === 1
            ? { ok: false, error: { kind: "transient" } }
            : { ok: true, value: input.join("|") };
        });
      },
    },
    {
      name: "prompt",
      requires: { materials },
      async setup(ctx) {
        const registry = ctx.use(materials);

        if (!registry.ok) return registry;

        return registry.value.put({ key: "system", text: "system instruction" });
      },
    },
    {
      name: "skills",
      requires: { materials },
      async setup(ctx) {
        const registry = ctx.use(materials);

        if (!registry.ok) return registry;

        return registry.value.put({ key: "skills", text: "available: search" });
      },
    },
    {
      name: "compression",
      requires: { compose },
      setup(ctx) {
        return ctx.middleware(compose, async (input, next) =>
          next(input.length > 10 ? "summary" : input),
        );
      },
    },
    {
      name: "recovery",
      requires: { model },
      setup(ctx) {
        return ctx.middleware(model, async (input, next) => {
          const first = await next(input);
          return !first.ok && "kind" in first.error && first.error.kind === "transient"
            ? await next(input)
            : first;
        });
      },
    },
    {
      name: "agent",
      requires: { compose, model, records },
      provides: { agent },
      setup(ctx) {
        return ctx.register(agent, {
          async run(input, call) {
            const bound = call.bind(ctx);

            if (!bound.ok) return bound;

            const assembled = await bound.value.dispatch(compose, input);

            if (!assembled.ok) return assembled;

            const response = await bound.value.dispatch(model, assembled.value);

            if (!response.ok) return response;

            const log = bound.value.use(records);

            if (!log.ok) return log;

            const appended = await log.value.append({
              type: "agent/message",
              content: response.value,
            });
            return appended.ok ? response : appended;
          },
        });
      },
    },
  ];

  try {
    const installed = value(await host.install(plugins));
    expect(value(await value(host.use(agent)).run("a very long prompt"))).toBe(
      "system instruction|available: search|summary",
    );
    expect(requests).toHaveLength(2);
    expect(facts).toEqual([
      { type: "agent/message", content: "system instruction|available: search|summary" },
    ]);
    const skills = installed.plugins.find((plugin) => plugin.name === "skills")!;
    value(await host.uninstall(skills));
    expect([...stored.values()]).toEqual(["system instruction"]);
    expect(value(await value(host.use(agent)).run("short"))).toBe("system instruction|short");
  } finally {
    value(await host.close());
  }

  expect(stored.size).toBe(0);
  expect(host.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0, effects: 0 });
});

it("external room and permission plugins support isolated bot scopes with trusted invocation identity", async () => {
  const host = value(createHost());
  const room = value(
    defineService<{
      join(input: { id: string; receive: (text: string) => void }): Promise<Result<Disposer>>;
      send(input: {
        from: string;
        to: string;
        text: string;
      }): Promise<Result<void, { kind: "denied" }>>;
    }>({ name: "room/router", methods: { join: {}, send: {} } }),
  );
  const bot = value(
    defineService<{
      send(input: {
        from: string;
        to: string;
        text: string;
      }): Promise<Result<void, { kind: "denied" }>>;
    }>({ name: "bot/commands", methods: { send: {} } }),
  );
  const permission = value(defineGuard<string>({ name: "room/permission", input: text }));
  const members = new Map<string, (text: string) => void>();
  const inboxes = new Map<string, string[]>();

  const botPlugin = (id: string): Plugin => ({
    name: id,
    requires: { room },
    provides: { bot },
    async setup(ctx) {
      const router = ctx.use(room);

      if (!router.ok) return router;

      const inbox: string[] = [];
      inboxes.set(id, inbox);
      const joined = await router.value.join({
        id,
        receive: (message) => {
          inbox.push(message);
        },
      });

      if (!joined.ok) return joined;

      return ctx.register(bot, {
        async send(input, call) {
          const bound = call.bind(ctx);

          if (!bound.ok) return bound;

          const service = bound.value.use(room);
          return service.ok ? service.value.send(input) : service;
        },
      });
    },
  });

  const first = value(host.createScope({ label: "first bot" }));
  const second = value(host.createScope({ label: "second bot" }));

  try {
    value(
      await host.install([
        {
          name: "permission",
          provides: { permission },
          setup(ctx) {
            return ctx.guard(permission, (sender) => ({
              ok: true,
              value:
                sender === "bot-a" ? { kind: "allow" } : { kind: "deny", reason: "sender denied" },
            }));
          },
        },
        {
          name: "room",
          requires: { permission },
          provides: { room },
          setup(ctx) {
            return ctx.register(room, {
              join(input, call) {
                if (input.id !== call.origin.pluginName) return Promise.resolve(invalid());

                members.set(input.id, input.receive);
                return Promise.resolve(
                  call.effect(() => {
                    members.delete(input.id);
                    return { ok: true, value: undefined };
                  }),
                );
              },
              async send(input, call) {
                if (input.from !== call.origin.pluginName)
                  return { ok: false, error: { kind: "denied" } };

                const bound = call.bind(ctx);

                if (!bound.ok) return bound;

                const allowed = await bound.value.dispatch(permission, input.from);

                if (!allowed.ok) return allowed;

                if (allowed.value.kind === "deny" || !members.has(input.to))
                  return { ok: false, error: { kind: "denied" } };

                members.get(input.to)!(input.text);
                return { ok: true, value: undefined };
              },
            });
          },
        },
      ]),
    );
    value(await host.install([botPlugin("bot-a")], { scope: first }));
    const b = value(await host.install([botPlugin("bot-b")], { scope: second }));
    const aService = value(first.use(bot));
    const bService = value(second.use(bot));
    value(await aService.send({ from: "bot-a", to: "bot-b", text: "hello" }));
    expect(inboxes.get("bot-b")).toEqual(["hello"]);
    expect(await bService.send({ from: "bot-a", to: "bot-a", text: "spoof" })).toEqual({
      ok: false,
      error: { kind: "denied" },
    });
    expect(await bService.send({ from: "bot-b", to: "bot-a", text: "denied" })).toEqual({
      ok: false,
      error: { kind: "denied" },
    });
    value(await host.uninstall(b.plugins[0]!));
    expect(members.has("bot-b")).toBe(false);
    expect(await bService.send({ from: "bot-b", to: "bot-a", text: "stale" })).toMatchObject({
      ok: false,
      error: { code: "service-unavailable" },
    });
    expect(await aService.send({ from: "bot-a", to: "bot-b", text: "gone" })).toEqual({
      ok: false,
      error: { kind: "denied" },
    });
  } finally {
    value(await host.close());
  }

  expect(members.size).toBe(0);
  expect(host.inspect()).toMatchObject({ scopes: 0, effects: 0, activeCalls: 0 });
});
