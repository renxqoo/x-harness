import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Result, Host } from "../../index";

const hosts: Host[] = [];

function take<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected successful Result");
  return result.value;
}

async function failWith(error: unknown): Promise<Result<string, unknown>> {
  const host = take(createHost());
  hosts.push(host);
  const token = take(defineService<{ run(input: void): Promise<Result<string, unknown>> }>({ name: "fault-boundary", methods: { run: {} } }));
  take(host.register(token, { run: () => Promise.resolve({ ok: false, error }) }));
  return take(host.use(token)).run(undefined);
}

afterEach(async () => { for (const host of hosts.splice(0)) take(await host.close()); });

const fault = (fields: Record<string, unknown>): Record<string, unknown> => ({ source: "core", code: "timeout", message: "Timed out", ...fields });

describe("reserved CoreFault boundary", () => {
  it.each(["scopeId", "pluginName", "callId", "diagnosticId"])("non-string %s cannot escape as a valid CoreFault", async (key) => {
    expect(await failWith(fault({ [key]: 123 }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
  });

  it.each([() => undefined, Symbol("invalid"), Infinity, NaN, new Date(), [undefined], { missing: undefined }])("non-JSON details cannot escape as a valid CoreFault: %s", async (details) => {
    expect(await failWith(fault({ details }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
  });

  it("cyclic or oversized details are rejected without exhausting validation", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(await failWith(fault({ details: cyclic }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
    expect(await failWith(fault({ details: "x".repeat(65537) }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
    let nested: unknown = null;
    for (let depth = 0; depth < 34; depth += 1) nested = { child: nested };
    expect(await failWith(fault({ details: nested }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
  });

  it("fault and nested details getters are rejected without executing the accessor", async () => {
    let getters = 0;
    const source = { get source() { getters += 1; return "core"; }, code: "timeout", message: "Timed out" };
    const details = { get hidden() { getters += 1; return "unsafe"; } };
    expect(await failWith(source)).toMatchObject({ ok: false, error: { code: "invalid-result" } });
    expect(await failWith(fault({ details }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
    expect(getters).toBe(0);
  });

  it("hostile or revoked proxies and inherited core branding cannot escape validation", async () => {
    const hostile = new Proxy({}, { ownKeys() { return ["unsafe"]; }, getOwnPropertyDescriptor() { throw new Error("trap"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const inherited: unknown = Object.create({ source: "core" });
    for (const error of [hostile, revoked.proxy, inherited]) {
      expect(await failWith(error)).toMatchObject({ ok: false, error: { code: "invalid-result" } });
    }
    expect(await failWith(fault({ details: hostile }))).toMatchObject({ ok: false, error: { code: "invalid-result" } });
  });

  it("valid fault metadata and details are delivered as an immutable snapshot", async () => {
    const details = { nested: [null, true, 3, "value"] };
    const error = fault({ scopeId: "scope", pluginName: "plugin", callId: "call", diagnosticId: "diagnostic", details });
    const result = await failWith(error);
    expect(result).toEqual({ ok: false, error });
    error.scopeId = "changed";
    details.nested.push("changed");
    expect(result).toMatchObject({ ok: false, error: { scopeId: "scope", details: { nested: [null, true, 3, "value"] } } });
    if (result.ok || !result.error || typeof result.error !== "object") throw new Error("Expected fault");
    expect(Object.isFrozen(result.error)).toBe(true);
    expect(Object.isFrozen((result.error as { details: unknown }).details)).toBe(true);
  });

  it("business failures preserve their original identity and non-JSON values", async () => {
    const error = { source: "domain", error: new Error("Business failure"), recover: () => true };
    const result = await failWith(error);
    expect(result).toEqual({ ok: false, error });
    if (result.ok) throw new Error("Expected business failure");
    expect(result.error).toBe(error);
  });
});
