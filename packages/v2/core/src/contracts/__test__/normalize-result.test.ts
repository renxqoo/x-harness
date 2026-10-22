import { expect, it } from "vitest";
import { normalizeResult } from "../normalize-result";

it.each([
  { input: { ok: true, value: undefined }, expected: { ok: true, value: undefined } },
  { input: { value: 0, ok: true }, expected: { ok: true, value: 0 } },
  { input: { ok: false, error: null }, expected: { ok: false, error: null } },
  { input: { error: false, ok: false }, expected: { ok: false, error: false } },
  {
    input: Object.assign(Object.create(null) as object, { ok: true, value: "null prototype" }),
    expected: { ok: true, value: "null prototype" },
  },
  {
    input: Object.defineProperties({}, { value: { value: "hidden" }, ok: { value: true } }),
    expected: { ok: true, value: "hidden" },
  },
])(
  "data properties remain valid regardless of order, enumerability or null prototype: %j",
  ({ input, expected }) => {
    const result = normalizeResult(input);
    expect(result).toEqual(expected);
    expect(result).not.toBe(input);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  },
);

it.each([
  null,
  undefined,
  1,
  "result",
  true,
  [],
  new Date(),
  () => ({ ok: true, value: 1 }),
  { ok: true },
  { ok: false, error: undefined },
  { value: 1, error: 2 },
  { ok: 1, value: 1 },
  { ok: true, error: "wrong branch" },
  { ok: false, value: 1 },
  { ok: true, value: 1, extra: true },
  { ok: true, [Symbol("payload")]: 1 },
  { ok: true, value: 1, [Symbol("extra")]: 1 },
  Object.create({ ok: true, value: 1 }) as object,
  Object.assign(Object.create({ inherited: true }) as object, { ok: true, value: 1 }),
])("malformed result envelopes are rejected: %j", (input: unknown) => {
  expect(normalizeResult(input)).toMatchObject({ ok: false, error: { code: "invalid-result" } });
});

it.each(["ok", "value", "error"])("a %s accessor is rejected without executing it", (key) => {
  let reads = 0;
  const input = key === "error" ? { ok: false, error: "domain" } : { ok: true, value: 1 };
  Object.defineProperty(input, key, {
    configurable: true,
    get() {
      reads++;
      throw new Error("private accessor");
    },
  });
  expect(normalizeResult(input)).toMatchObject({ ok: false, error: { code: "invalid-result" } });
  expect(reads).toBe(0);
});

it("valid proxy results are read through descriptors without evaluating get traps", () => {
  let reads = 0;
  const input = new Proxy(
    { ok: true, value: "value" },
    {
      get() {
        reads++;
        throw new Error("private get");
      },
    },
  );
  expect(normalizeResult(input)).toEqual({ ok: true, value: "value" });
  expect(reads).toBe(0);
});

it("throwing and revoked proxy metadata cannot escape the result boundary", () => {
  const failed = () => {
    throw new Error("private metadata");
  };

  const revoked = Proxy.revocable({ ok: true, value: 1 }, {});
  revoked.revoke();
  const inputs = [
    new Proxy({}, { getPrototypeOf: failed }),
    new Proxy({}, { ownKeys: failed }),
    new Proxy({ ok: true, value: 1 }, { getOwnPropertyDescriptor: failed }),
    revoked.proxy,
    new Proxy({ ok: true, value: 1 }, { getOwnPropertyDescriptor: () => undefined }),
    new Proxy({}, { ownKeys: () => ["ok", "ok"] }),
  ];

  for (const input of inputs) {
    const result = normalizeResult(input);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-result" } });
    expect(JSON.stringify(result)).not.toContain("private");
  }
});

it.each([false, true])(
  "descriptor values are snapshotted in own-key order when reversed=%s",
  (reversed) => {
    const input = reversed ? { value: "initial", ok: true } : { ok: true, value: "initial" };
    const reads: PropertyKey[] = [];
    const proxy = new Proxy(input, {
      getOwnPropertyDescriptor(target, key) {
        reads.push(key);

        if (reads.length === 2) {
          if (reversed) target.value = "changed";
          else target.ok = false;
        }

        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(normalizeResult(proxy)).toEqual({ ok: true, value: "initial" });
    expect(reads).toEqual(reversed ? ["value", "ok"] : ["ok", "value"]);
  },
);

it("success payloads and business errors preserve identity while their envelopes are copied", () => {
  const payload = { nested: () => true };
  const error = { source: "domain", retry: () => true };
  const success = normalizeResult({ ok: true, value: payload });
  const failure = normalizeResult({ ok: false, error });
  expect(success.ok && success.value).toBe(payload);
  expect(!failure.ok && failure.error).toBe(error);
});
