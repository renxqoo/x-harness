import { describe, expect, it } from "vitest";
import { createHost, defineChain, defineEvent, defineGuard, defineService } from "../../index";
import type { Result } from "../../index";

const valid = (input: unknown): Result<unknown> => ({ ok: true, value: input });

describe("definition and input boundaries", () => {
  it.each(["", "A", "a//b", "/a", "core/internal", "a_", "a".repeat(161)])(
    "rejects invalid name %s",
    (name) => {
      expect(defineEvent({ name, payload: valid }).ok).toBe(false);
    },
  );
  it.each(
    [null, undefined, [], 4, { name: "test" }, { name: "test", payload: 1 }].map((input) => ({
      input,
    })),
  )("invalid definitions do not throw: %j", ({ input }) => {
    expect(() => defineEvent(input as unknown as Parameters<typeof defineEvent>[0])).not.toThrow();
    expect(defineEvent(input as unknown as Parameters<typeof defineEvent>[0]).ok).toBe(false);
  });
  it("does not evaluate accessors while reading a definition", () => {
    let calls = 0;
    const definition = {
      get name() {
        calls += 1;
        return "test";
      },
      payload: valid,
    };
    expect(defineEvent(definition).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("converts proxy descriptor failures without exposing their error", () => {
    const definition = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("secret");
        },
      },
    );
    const result = defineEvent(definition as Parameters<typeof defineEvent>[0]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("all four factories return frozen identity tokens", () => {
    const factories = [
      defineService<{ run(input: unknown): Promise<Result<unknown>> }>({
        name: "service",
        methods: { run: {} },
      }),
      defineChain({ name: "chain", input: valid, output: valid }),
      defineGuard({ name: "guard", input: valid }),
      defineEvent({ name: "event", payload: valid }),
    ];
    expect(factories.every((result) => result.ok && Object.isFrozen(result.value))).toBe(true);
  });
  it.each([{ maxScopes: 0 }, { unknown: 1 }, { maxScopes: 1.5 }, { callTimeoutMs: Infinity }])(
    "rejects invalid limits: %j",
    (limits) => {
      expect(createHost({ limits } as Parameters<typeof createHost>[0]).ok).toBe(false);
    },
  );
});
