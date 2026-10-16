import { afterEach, describe, expect, it } from "vitest";
import { defineEvent } from "../../../index";
import type { Limits, Host } from "../../../index";
import { flush, root, value } from "../../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.close(); });
const setup = (limits?: Partial<Limits>) => {
  const host = root({ limits }); roots.push(host);
  const token = value(defineEvent<unknown>({ name: "data", payload: (input) => ({ ok: true, value: input }) }));
  value(host.register(token)); return { host, token };
};

describe("bounded JSON snapshot", () => {
  it("arrays and repeated references are copied without being treated as cycles", async () => {
    const { host, token } = setup(); const shared = { item: 1 }; const input = [shared, shared];
    let received: unknown;
    value(host.on(token, (payload) => { received = payload; })); value(host.emit(token, input)); shared.item = 2; await flush();
    expect(received).toEqual([{ item: 1 }, { item: 1 }]); expect(Object.isFrozen(received)).toBe(true);
  });
  it.each([Object.assign([], { length: 2 }), [undefined], Object.assign([1], { extra: 1 })].map((input) => ({ input })))("rejects sparse or non-JSON arrays", ({ input }) => {
    const { host, token } = setup(); expect(host.emit(token, input).ok).toBe(false);
  });
  it("depth and node limits reject oversized traversal", () => {
    const depth = setup({ maxEventDepth: 1 });
    expect(depth.host.emit(depth.token, { nested: { item: 1 } })).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    const nodes = setup({ maxEventNodes: 2 });
    expect(nodes.host.emit(nodes.token, [1, 2])).toMatchObject({ ok: false, error: { code: "resource-limit" } });
  });
  it("UTF-8 and escaped JSON bytes are included in the exact boundary", () => {
    const { host, token } = setup({ maxEventBytes: 6 });
    expect(host.emit(token, "你").ok).toBe(true);
    expect(host.emit(token, "你好")).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(host.emit(token, '"""')).toMatchObject({ ok: false, error: { code: "resource-limit" } });
  });
  it("symbol keys and abnormal prototypes cannot enter notifications", () => {
    const { host, token } = setup();
    expect(host.emit(token, { [Symbol("key")]: 1 }).ok).toBe(false);
    expect(host.emit(token, Object.create({ item: 1 })).ok).toBe(false);
  });
  it("payload validator exceptions fail without exposing the thrown message", () => {
    const host = root(); roots.push(host);
    const token = value(defineEvent({ name: "validator", payload() { throw new Error("private-data"); } }));
    value(host.register(token));
    const result = host.emit(token, "input"); expect(result).toMatchObject({ ok: false, error: { code: "callback-failed" } });
    expect(JSON.stringify(result)).not.toContain("private-data");
  });
});
