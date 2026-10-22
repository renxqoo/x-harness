import { describe, expect, it } from "vitest";
import { readCallOptions } from "../read-call-options";

describe("default call options", () => {
  it("null and undefined share an immutable result with no inherited signal or deadline", () => {
    const result = readCallOptions(undefined);
    expect(result).toBe(readCallOptions(null));
    expect(Object.isFrozen(result)).toBe(true);

    if (!result.ok) throw new Error("Expected options");

    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Reflect.set(result.value, "timeoutMs", 1)).toBe(false);
    expect(result.value.timeoutMs).toBeUndefined();
  });
  it("explicit empty objects and hostile shapes still use complete data validation", () => {
    expect(readCallOptions({})).toEqual({ ok: true, value: {} });
    let evaluated = 0;
    const getter = {
      get timeoutMs() {
        evaluated++;
        return 1;
      },
    };

    for (const input of [
      false,
      0,
      [],
      "",
      getter,
      { [Symbol("key")]: 1 },
      { timeoutMs: Infinity },
      { signal: {} },
    ])
      expect(readCallOptions(input).ok).toBe(false);

    expect(evaluated).toBe(0);
    const original = { timeoutMs: 10 };
    const result = readCallOptions(original);
    original.timeoutMs = 100;
    expect(result).toEqual({ ok: true, value: { timeoutMs: 10 } });
  });
});
