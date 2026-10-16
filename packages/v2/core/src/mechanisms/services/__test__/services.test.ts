import { afterEach, describe, expect, it } from "vitest";
import { defineService } from "../../../index";
import type { Context, Disposer, Result, Host } from "../../../index";
import { clock, deferred, flush, number, root, text, value } from "../../../__test__/helpers";

type Echo = { run: (input: string) => Promise<Result<string>> };
const echo = () => value(defineService<Echo>({ name: "echo", methods: { run: { input: text, output: text } } }));
const roots: Host[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.close(); });
const setup = (options?: Parameters<typeof root>[0]) => { const item = root(options); roots.push(item); return item; };

describe("managed services and scopes", () => {
  it("installs, extracts a method, unloads and revokes its old facade", async () => {
    const host = setup();
    const token = echo();
    const installed = value(await host.install([{ name: "echo-provider", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: (input) => Promise.resolve({ ok: true, value: input }) });
    } }]));
    const { run } = value(host.use(token));
    expect(value(await run("hello"))).toBe("hello");
    expect((await host.uninstall(installed.plugins[0]!)).ok).toBe(true);
    expect((await run("again")).ok).toBe(false);
    expect((await host.close()).ok).toBe(true);
    expect(host.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0, pendingEvents: 0, effects: 0, scopes: 0 });
  });
  it("a later batch binds providers already published in the same scope", async () => {
    const host = setup();
    const token = echo();
    value(host.register(token, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    expect((await host.install([{ name: "consumer", requires: { token }, setup(ctx) {
      expect(ctx.use(token).ok).toBe(true);
      expect("dispose" in ctx).toBe(false);
      return { ok: true, value: undefined };
    } }])).ok).toBe(true);
  });
  it("unloading a required provider is protected and cascade stops its consumers first", async () => {
    const host = setup();
    const token = echo();
    const cleanup: string[] = [];
    const installed = value(await host.install([
      { name: "consumer", requires: { token }, setup(ctx) { return ctx.addCleanup(() => { cleanup.push("consumer"); return { ok: true, value: undefined }; }); } },
      { name: "provider", provides: { token }, setup(ctx) {
        value(ctx.addCleanup(() => { cleanup.push("provider"); return { ok: true, value: undefined }; }));
        return ctx.register(token, { run: (input) => Promise.resolve({ ok: true, value: input }) });
      } },
    ]));
    const provider = installed.plugins.find((entry) => entry.name === "provider")!;
    expect(await host.uninstall(provider)).toMatchObject({ ok: false, error: { code: "plugin-in-use" } });
    expect((await host.uninstall(provider, { cascade: true })).ok).toBe(true);
    expect(cleanup).toEqual(["consumer", "provider"]);
  });
  it("undeclared and initially absent optional dependencies remain inaccessible", async () => {
    const host = setup();
    const token = echo();
    let consumer!: Context;
    value(await host.install([{ name: "consumer", optional: { token }, setup(ctx) {
      consumer = ctx; return { ok: true, value: undefined };
    } }]));
    value(host.register(token, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    expect(consumer.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    const other = value(defineService<Echo>({ name: "other", methods: { run: {} } }));
    expect(consumer.use(other)).toMatchObject({ ok: false, error: { code: "undeclared-dependency" } });
  });
  it("explicit shadowing does not redirect existing parent facades or fall back after revocation", async () => {
    const host = setup();
    const token = echo();
    value(host.register(token, { run: () => Promise.resolve({ ok: true, value: "parent" }) }));
    const parent = value(host.use(token));
    const child = value(host.createScope({ label: "child" }));
    expect(child.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }).ok).toBe(false);
    value(child.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }, { shadow: true }));
    expect(value(await value(child.use(token)).run("a"))).toBe("child");
    expect(value(await parent.run("a"))).toBe("parent");
    value(await host.closeScope(child));
    expect(child.use(token).ok).toBe(false);
  });
  it("input and output validators prevent invalid success", async () => {
    const host = setup();
    const token = value(defineService<{ run(input: string): Promise<Result<number>> }>({ name: "numbers", methods: { run: { input: text, output: number } } }));
    let calls = 0;
    value(host.register(token, { run() { calls += 1; return Promise.resolve({ ok: true, value: "bad" as unknown as number }); } }));
    const service = value(host.use(token));
    expect((await service.run(1 as unknown as string)).ok).toBe(false);
    expect(calls).toBe(0);
    expect(await service.run("valid")).toMatchObject({ ok: false, error: { code: "invalid-result" } });
  });
  it("timeout retains the real work until its actual result arrives", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } });
    const token = echo();
    const delayed = deferred<Result<string>>();
    value(host.register(token, { run: () => delayed.promise }));
    const pending = value(host.use(token)).run("a");
    await flush();
    time.advance(10);
    expect(await pending).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(host.inspect().activeCalls).toBe(1);
    delayed.resolve({ ok: true, value: "late" });
    await flush();
    expect(host.inspect().activeCalls).toBe(0);
    value(await host.close());
    expect(time.timers.size).toBe(0);
  });
  it("resource cleanup uses the creator dependency permissions while lifetime belongs to the consumer", async () => {
    const host = setup();
    const dependency = echo();
    const service = value(defineService<{ subscribe(input: void): Promise<Result<Disposer>> }>({ name: "subscribe", methods: { subscribe: {} } }));
    const cleanup: string[] = [];
    const installed = value(await host.install([
      { name: "dependency", provides: { dependency }, setup(ctx) { return ctx.register(dependency, { run(input) { cleanup.push(input); return Promise.resolve({ ok: true, value: input }); } }); } },
      { name: "provider", requires: { dependency }, provides: { service }, setup(ctx) {
        return ctx.register(service, { subscribe(_input, call) {
          return Promise.resolve(call.effect(async (closing) => {
            const dep = closing.context.use(dependency);
            if (!dep.ok) return dep;
            const result = await dep.value.run("released");
            if (!result.ok) return result;
            return { ok: true, value: undefined };
          }));
        } });
      } },
      { name: "consumer", requires: { service }, async setup(ctx) {
        const endpoint = ctx.use(service);
        if (!endpoint.ok) return endpoint;
        return endpoint.value.subscribe(undefined);
      } },
    ]));
    expect((await host.uninstall(installed.plugins.find((entry) => entry.name === "consumer")!)).ok).toBe(true);
    expect(cleanup).toEqual(["released"]);
    expect((await host.close()).ok).toBe(true);
  });
  it("different definition identities cannot occupy the same public name", () => {
    const host = setup();
    value(host.register(echo(), { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    expect(host.register(echo(), { run: (input) => Promise.resolve({ ok: true, value: input }) })).toMatchObject({ ok: false, error: { code: "definition-conflict" } });
  });
});
