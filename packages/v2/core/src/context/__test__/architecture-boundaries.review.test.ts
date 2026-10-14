import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineChain, defineGuard, defineService } from "../../index";
import type { Context, Invocation, Plugin, Result, RootContext, Validator } from "../../index";

const hosts: RootContext[] = [];

function take<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Unexpected failed Result");
  return result.value;
}

function host(options?: Parameters<typeof createContext>[0]): RootContext {
  const context = take(createContext(options));
  hosts.push(context);
  return context;
}

const text: Validator<string> = (input) => typeof input === "string"
  ? { ok: true, value: input }
  : { ok: false, reason: { source: "core", code: "invalid-input", message: "Expected string" } };

function service(name: string) {
  return take(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));
}

afterEach(async () => {
  for (const context of hosts.splice(0)) take(await context.dispose());
});

describe("public plugin architecture boundaries", () => {
  it("external scoped agents compose policy, records, recovery and owned resources without core business knowledge", async () => {
    const root = host();
    const execution = take(defineChain<string, string>({ name: "review/execution", input: text, output: text }));
    const policy = take(defineGuard({ name: "review/policy", input: text }));
    const ledger = service("review/ledger");
    const entry = service("review/entry");
    const scopes = [take(root.scope({ label: "first-agent" })), take(root.scope({ label: "second-agent" }))];
    const records = new Map<string, string[]>();
    const released: string[] = [];
    const identities: Invocation[] = [];

    for (const scope of scopes) {
      const stream: string[] = [];
      records.set(scope.id, stream);
      let attempts = 0;
      const plugins: Plugin[] = [
        {
          name: "ledger", provides: [ledger], apply(ctx) {
            return ctx.provide(ledger, { async run(input, call) {
              identities.push(call);
              const owned = call.effect(() => {
                released.push(scope.id);
                return { ok: true, value: undefined };
              });
              if (!owned.ok) return owned;
              stream.push(input);
              return { ok: true, value: stream.join("|") };
            } });
          },
        },
        {
          name: "execution", provides: [execution], requires: [ledger], apply(ctx) {
            return ctx.provide(execution, async (input, call) => {
              attempts += 1;
              if (attempts === 1) return { ok: false, reason: { source: "core", code: "callback-failed", message: "Recoverable adapter failure" } };
              const bound = call.bind(ctx);
              if (!bound.ok) return bound;
              const log = bound.value.use(ledger);
              if (!log.ok) return log;
              return log.value.run(input);
            });
          },
        },
        {
          name: "recovery", requires: [execution], apply(ctx) {
            return ctx.on(execution, async (input, next) => {
              const first = await next(input);
              if (first.ok) return first;
              return await next(input);
            });
          },
        },
        {
          name: "policy", provides: [policy], apply(ctx) {
            const provided = ctx.provide(policy);
            if (!provided.ok) return provided;
            return ctx.on(policy, (input) => ({ ok: true, value: input === "denied"
              ? { kind: "deny", reason: "External policy rejected operation" }
              : { kind: "allow" } }));
          },
        },
        {
          name: "entry", provides: [entry], requires: [policy, execution], apply(ctx) {
            return ctx.provide(entry, { async run(input, call) {
              const bound = call.bind(ctx);
              if (!bound.ok) return bound;
              const allowed = await bound.value.dispatch(policy, input);
              if (!allowed.ok) return allowed;
              if (allowed.value.kind === "deny") return { ok: true, value: "denied" };
              return bound.value.dispatch(execution, input);
            } });
          },
        },
      ];
      take(await root.load(plugins, { scope }));
    }

    const first = take(scopes[0]!.use(entry));
    const second = take(scopes[1]!.use(entry));
    expect(take(await first.run("denied"))).toBe("denied");
    expect(records.get(scopes[0]!.id)).toEqual([]);
    expect(take(await first.run("alpha"))).toBe("alpha");
    expect(take(await second.run("beta"))).toBe("beta");
    expect(records.get(scopes[0]!.id)).toEqual(["alpha"]);
    expect(records.get(scopes[1]!.id)).toEqual(["beta"]);
    expect(identities.map((call) => call.origin.pluginName)).toEqual(["execution", "execution"]);
    expect(identities.map((call) => call.executor.pluginName)).toEqual(["ledger", "ledger"]);
    expect(identities.map((call) => call.resourceOwner.scopeId)).toEqual(scopes.map((scope) => scope.id));
    expect(identities.every((call) => call.resourceOwner.pluginName === undefined && call.parentId !== undefined)).toBe(true);
    take(await root.closeScope(scopes[0]!));
    expect(released).toEqual([scopes[0]!.id]);
    expect(take(await second.run("gamma"))).toBe("beta|gamma");
    expect(await first.run("late")).toMatchObject({ ok: false, reason: { code: "service-unavailable" } });
  });

  it("plugin created scopes preserve declared dependencies without adopting sibling plugin capabilities", async () => {
    const root = host();
    const visible = service("review/visible");
    const restricted = service("review/restricted");
    const entry = service("review/bound-entry");
    let own!: Context;
    let sibling!: Context;
    take(root.provide(visible, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    take(root.provide(restricted, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    take(await root.load([
      { name: "sibling", requires: [restricted], apply(ctx) { sibling = ctx; return { ok: true, value: undefined }; } },
      { name: "consumer", requires: [visible], provides: [entry], apply(ctx) {
        own = take(ctx.scope({ label: "owned" }));
        return ctx.provide(entry, { async run(input, call) {
          expect(call.bind(sibling)).toMatchObject({ ok: false, reason: { code: "invalid-input" } });
          const bound = call.bind(own);
          if (!bound.ok) return bound;
          expect(bound.value.use(restricted)).toMatchObject({ ok: false, reason: { code: "undeclared-dependency" } });
          const inherited = bound.value.use(visible);
          if (!inherited.ok) return inherited;
          return inherited.value.run(input);
        } });
      } },
    ]));
    expect(take(await take(root.use(entry)).run("delegated"))).toBe("delegated");
    expect(own).not.toHaveProperty("load");
    expect(own).not.toHaveProperty("dispose");
  });

  it("creating an owned scope loses access to the creator's already provided ancestor capability", async () => {
    const root = host();
    const own = service("review/own-capability");
    let child!: Context;
    take(await root.load([{ name: "provider", provides: [own], apply(ctx) {
      const provided = ctx.provide(own, { run: (input) => Promise.resolve({ ok: true, value: input }) });
      if (!provided.ok) return provided;
      expect(ctx.use(own).ok).toBe(true);
      child = take(ctx.scope({ label: "owned" }));
      return { ok: true, value: undefined };
    } }]));
    const inherited = child.use(own);
    expect(inherited).toEqual({ ok: true, value: expect.any(Object) });
    if (!inherited.ok) return;
    expect(take(await inherited.value.run("same-owner"))).toBe("same-owner");
  });

  it("absent optional definitions evade the root definition budget", async () => {
    const root = host({ limits: { maxDefinitions: 1 } });
    const first = service("review/optional-first");
    const second = service("review/optional-second");
    const loaded = await root.load([{ name: "consumer", optional: [first, second], apply() { return { ok: true, value: undefined }; } }]);
    expect(loaded).toMatchObject({ ok: false, reason: { code: "resource-limit" } });
  });

  it("absent optional definitions permit a conflicting definition identity with the same name", async () => {
    const root = host();
    const original = service("review/optional-identity");
    const conflicting = service("review/optional-identity");
    take(await root.load([{ name: "consumer", optional: [original], apply() { return { ok: true, value: undefined }; } }]));
    expect(root.provide(conflicting, { run: (input) => Promise.resolve({ ok: true, value: input }) }))
      .toMatchObject({ ok: false, reason: { code: "definition-conflict" } });
  });
});
