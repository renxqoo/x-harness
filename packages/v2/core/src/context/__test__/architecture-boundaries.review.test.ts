import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineChain, defineGuard, defineService } from "../../index";
import type { Context, Invocation, Plugin, Result, Host, Validator } from "../../index";

const hosts: Host[] = [];

function take<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Unexpected failed Result");
  return result.value;
}

function host(options?: Parameters<typeof createHost>[0]): Host {
  const context = take(createHost(options));
  hosts.push(context);
  return context;
}

const text: Validator<string> = (input) => typeof input === "string"
  ? { ok: true, value: input }
  : { ok: false, error: { source: "core", code: "invalid-input", message: "Expected string" } };

function service(name: string) {
  return take(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));
}

afterEach(async () => {
  for (const context of hosts.splice(0)) take(await context.close());
});

describe("public plugin architecture boundaries", () => {
  it("external scoped agents compose policy, records, recovery and owned resources without core business knowledge", async () => {
    const root = host();
    const execution = take(defineChain<string, string>({ name: "review/execution", input: text, output: text }));
    const policy = take(defineGuard({ name: "review/policy", input: text }));
    const ledger = service("review/ledger");
    const entry = service("review/entry");
    const scopes = [take(root.createScope({ label: "first-agent" })), take(root.createScope({ label: "second-agent" }))];
    const records = new Map<string, string[]>();
    const released: string[] = [];
    const identities: Invocation[] = [];

    for (const scope of scopes) {
      const stream: string[] = [];
      records.set(scope.scopeId, stream);
      let attempts = 0;
      const plugins: Plugin[] = [
        {
          name: "ledger", provides: { ledger }, setup(ctx) {
            return ctx.register(ledger, { async run(input, call) {
              identities.push(call);
              const owned = call.effect(() => {
                released.push(scope.scopeId);
                return { ok: true, value: undefined };
              });
              if (!owned.ok) return owned;
              stream.push(input);
              return { ok: true, value: stream.join("|") };
            } });
          },
        },
        {
          name: "execution", provides: { execution }, requires: { ledger }, setup(ctx) {
            return ctx.register(execution, async (input, call) => {
              attempts += 1;
              if (attempts === 1) return { ok: false, error: { source: "core", code: "callback-failed", message: "Recoverable adapter failure" } };
              const bound = call.bind(ctx);
              if (!bound.ok) return bound;
              const log = bound.value.use(ledger);
              if (!log.ok) return log;
              return log.value.run(input);
            });
          },
        },
        {
          name: "recovery", requires: { execution }, setup(ctx) {
            return ctx.middleware(execution, async (input, next) => {
              const first = await next(input);
              if (first.ok) return first;
              return await next(input);
            });
          },
        },
        {
          name: "policy", provides: { policy }, setup(ctx) {
            return ctx.guard(policy, (input) => ({ ok: true, value: input === "denied"
              ? { kind: "deny", reason: "External policy rejected operation" }
              : { kind: "allow" } }));
          },
        },
        {
          name: "entry", provides: { entry }, requires: { policy, execution }, setup(ctx) {
            return ctx.register(entry, { async run(input, call) {
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
      take(await root.install(plugins, { scope }));
    }

    const first = take(scopes[0]!.use(entry));
    const second = take(scopes[1]!.use(entry));
    expect(take(await first.run("denied"))).toBe("denied");
    expect(records.get(scopes[0]!.scopeId)).toEqual([]);
    expect(take(await first.run("alpha"))).toBe("alpha");
    expect(take(await second.run("beta"))).toBe("beta");
    expect(records.get(scopes[0]!.scopeId)).toEqual(["alpha"]);
    expect(records.get(scopes[1]!.scopeId)).toEqual(["beta"]);
    expect(identities.map((call) => call.origin.pluginName)).toEqual(["execution", "execution"]);
    expect(identities.map((call) => call.executor.pluginName)).toEqual(["ledger", "ledger"]);
    expect(identities.map((call) => call.resourceOwner.scopeId)).toEqual(scopes.map((scope) => scope.scopeId));
    expect(identities.every((call) => call.resourceOwner.pluginName === undefined && call.parentId !== undefined)).toBe(true);
    take(await root.closeScope(scopes[0]!));
    expect(released).toEqual([scopes[0]!.scopeId]);
    expect(take(await second.run("gamma"))).toBe("beta|gamma");
    expect(await first.run("late")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
  });

  it("plugin created scopes preserve declared dependencies without adopting sibling plugin capabilities", async () => {
    const root = host();
    const visible = service("review/visible");
    const restricted = service("review/restricted");
    const entry = service("review/bound-entry");
    let own!: Context;
    let sibling!: Context;
    take(root.register(visible, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    take(root.register(restricted, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    take(await root.install([
      { name: "sibling", requires: { restricted }, setup(ctx) { sibling = ctx; return { ok: true, value: undefined }; } },
      { name: "consumer", requires: { visible }, provides: { entry }, setup(ctx) {
        own = take(ctx.createScope({ label: "owned" }));
        return ctx.register(entry, { async run(input, call) {
          expect(call.bind(sibling)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
          const bound = call.bind(own);
          if (!bound.ok) return bound;
          expect(bound.value.use(restricted)).toMatchObject({ ok: false, error: { code: "undeclared-dependency" } });
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
    take(await root.install([{ name: "provider", provides: { own }, setup(ctx) {
      const provided = ctx.register(own, { run: (input) => Promise.resolve({ ok: true, value: input }) });
      if (!provided.ok) return provided;
      expect(ctx.use(own).ok).toBe(true);
      child = take(ctx.createScope({ label: "owned" }));
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
    const loaded = await root.install([{ name: "consumer", optional: { first, second }, setup() { return { ok: true, value: undefined }; } }]);
    expect(loaded).toMatchObject({ ok: false, error: { code: "resource-limit" } });
  });

  it("absent optional definitions permit a conflicting definition identity with the same name", async () => {
    const root = host();
    const original = service("review/optional-identity");
    const conflicting = service("review/optional-identity");
    take(await root.install([{ name: "consumer", optional: { original }, setup() { return { ok: true, value: undefined }; } }]));
    expect(root.register(conflicting, { run: (input) => Promise.resolve({ ok: true, value: input }) }))
      .toMatchObject({ ok: false, error: { code: "definition-conflict" } });
  });
});
