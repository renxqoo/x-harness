import { afterEach, describe, expect, it } from "vitest";
import { defineChain } from "../../index";
import type { Result, Host } from "../../index";
import { clock, flush, number, root, text, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.close(); });
const setup = (options?: Parameters<typeof root>[0]) => { const item = root(options); roots.push(item); return item; };

describe("settlement, observation and deadline regressions", () => {
  it("a child failure handled after actual settlement does not poison its parent result", async () => {
    const host = setup();
    const parent = value(host.startTask({ label: "parent", async run(call) {
      const child = value(call.spawn({ label: "child", run(): Result<void> { throw new Error("child"); } }));
      await flush(); expect(child.state).toBe("settled");
      expect((await call.wait(child)).ok).toBe(false);
      return { ok: true, value: "handled" };
    } }));
    expect(value(await host.wait(parent))).toBe("handled");
  });
  it("sequential settled children do not consume the active task budget", async () => {
    const host = setup({ limits: { maxActiveTasks: 2 } });
    const parent = value(host.startTask({ label: "parent", async run(call) {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const child = value(call.spawn({ label: "child", run: () => ({ ok: true, value: iteration }) }));
        expect(value(await call.wait(child))).toBe(iteration);
      }
      return { ok: true, value: undefined };
    } }));
    value(await host.wait(parent));
    expect(host.inspect().activeTasks).toBe(0);
  });
  it("expired next never enters its terminal even before a delayed timer fires", async () => {
    const time = clock(); const host = setup({ scheduler: time.scheduler });
    const token = value(defineChain({ name: "deadline", input: text, output: number }));
    let entered = 0;
    value(host.register(token, () => { entered += 1; return { ok: true, value: 1 }; }));
    value(host.middleware(token, async (input, next) => { time.jump(11); return await next(input); }));
    expect(await host.dispatch(token, "a", { timeoutMs: 10 })).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(entered).toBe(0);
  });
  it("a synchronous result completed after its deadline cannot publish success", async () => {
    const time = clock(); const host = setup({ scheduler: time.scheduler });
    const task = value(host.startTask({ label: "expired", timeoutMs: 10, run() { time.jump(11); return { ok: true, value: 1 }; } }));
    expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(task.state).toBe("settled");
  });
});
