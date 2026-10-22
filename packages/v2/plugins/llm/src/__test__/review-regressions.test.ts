import { expect, it } from "vitest";
import { streamLlm } from "../index";
import type { LlmService, LlmEvent } from "../contracts";
import { runModel } from "../stream/run-model";
import { createSchemaCache } from "../domain/create-schema-cache";
import { readLlmLimits } from "../domain/read-limits";
const request = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as const;
const description = {
  protocol: "test",
  model: "m",
  input: ["text"],
  output: ["text", "json"],
  developer: false,
  tools: true,
  citations: false,
  providerTools: [],
} as const;

function limits() {
  const read = readLlmLimits();

  if (!read.ok) throw new Error("limits");

  return read.value;
}

it.each([true, false])(
  "unstarted iterator cancellation settles result without HTTP (preaborted=%s)",
  async (preaborted) => {
    const controller = new AbortController();

    if (preaborted) controller.abort();

    let calls = 0;
    const service = {
      async stream() {
        calls++;
        return { ok: false, error: {} };
      },
    } as unknown as LlmService;
    const stream = streamLlm(service, { ...request, signal: controller.signal });

    if (!preaborted) controller.abort();

    expect(
      await Promise.race([stream.result, new Promise((r) => setTimeout(() => r("pending"), 50))]),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(calls).toBe(0);
    expect(await stream[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
  },
);
it("double subscription before next settles rather than hanging", async () => {
  const stream = streamLlm({} as LlmService, request);
  stream[Symbol.asyncIterator]();
  stream[Symbol.asyncIterator]();
  expect(await stream.result).toMatchObject({ ok: false, error: { code: "consumer-failed" } });
});
it("total deadline includes slow describe and passes its abort signal", async () => {
  const schemas = createSchemaCache();
  let aborted = false;
  let calls = 0;

  try {
    const result = await runModel({
      input: { request: { ...request, timeoutMs: 5 }, collect: false, onEvent() {} },
      provider: "p",
      signal: new AbortController().signal,
      limits: limits(),
      schemas,
      service: {
        async describe({ signal }) {
          await new Promise((r) => setTimeout(r, 30));
          aborted = signal?.aborted ?? false;
          return { ok: true, value: description };
        },
        async stream() {
          calls++;
          return { ok: true, value: { reason: { kind: "stop" } } };
        },
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(aborted).toBe(true);
    expect(calls).toBe(0);
  } finally {
    schemas.close();
  }
});
it.each(["invalid-json", "terminal-consumer", "incomplete-stop"])(
  "stream failure preserves delivered output and rejects %s",
  async (scenario) => {
    const schemas = createSchemaCache();
    const events: LlmEvent[] = [];

    try {
      const result = await runModel({
        input: {
          request: {
            ...request,
            ...(scenario === "invalid-json" ? { output: { type: "json" as const } } : {}),
          },
          collect: true,
          onEvent(event) {
            events.push(event);

            if (scenario === "terminal-consumer" && event.type === "finish")
              throw new Error("failed");
          },
        },
        provider: "p",
        signal: new AbortController().signal,
        limits: limits(),
        schemas,
        service: {
          async describe() {
            return { ok: true, value: description };
          },
          async stream(input) {
            for (const event of [
              { type: "block-start", block: { kind: "text", id: "t" } },
              { type: "text-delta", id: "t", delta: "bad-json" },
              {
                type: "block-end",
                id: "t",
                status: scenario === "incomplete-stop" ? "incomplete" : "complete",
              },
            ] as const) {
              const sent = await input.onEvent(event);

              if (!sent.ok) return sent;
            }

            return { ok: true, value: { reason: { kind: "stop" } } };
          },
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          hasOutput: true,
          code: (
            {
              "invalid-json": "invalid-output",
              "terminal-consumer": "consumer-failed",
              "incomplete-stop": "protocol-error",
            } as const
          )[scenario],
        },
      });

      if (scenario === "invalid-json")
        expect(events.at(-1)).toMatchObject({ type: "error", error: { hasOutput: true } });
    } finally {
      schemas.close();
    }
  },
);
it("completed iterator releases request and service while the stream handle stays reachable", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./stream-retention.gc-case.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe", timeout: 4000 },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("released");
});
it("slow error callback retains its consumer deadline until actual delivery settles", async () => {
  const schemas = createSchemaCache();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const execution = runModel({
    input: {
      request: { ...request, output: { type: "json" } },
      collect: false,
      async onEvent(event) {
        if (event.type === "error") {
          entered();
          await gate;
        }
      },
    },
    provider: "p",
    signal: new AbortController().signal,
    limits: { ...limits(), consumerTimeoutMs: 5 },
    schemas,
    service: {
      async describe() {
        return { ok: true, value: description };
      },
      async stream(input) {
        for (const event of [
          { type: "block-start", block: { id: "t", kind: "text" } },
          { type: "text-delta", id: "t", delta: "bad" },
          { type: "block-end", id: "t", status: "complete" },
        ] as const) {
          const result = await input.onEvent(event);

          if (!result.ok) return result;
        }

        return { ok: true, value: { reason: { kind: "stop" } } };
      },
    },
  });

  try {
    await ready;
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect(await execution).toMatchObject({
      ok: false,
      error: { code: "timeout", phase: "consumer", hasOutput: true },
    });
  } finally {
    release();
    schemas.close();
  }
});
it("a description for another model cannot supply this request's capabilities", async () => {
  const schemas = createSchemaCache();
  let called = false;

  try {
    expect(
      await runModel({
        input: { request, collect: true, onEvent() {} },
        provider: "p",
        service: {
          async describe() {
            return { ok: true, value: { ...description, model: "other" } };
          },
          async stream() {
            called = true;
            return { ok: true, value: { reason: { kind: "stop" } } };
          },
        },
        signal: new AbortController().signal,
        limits: limits(),
        schemas,
      }),
    ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
    expect(called).toBe(false);
  } finally {
    schemas.close();
  }
});
it("output rejected by the public event budget is not reported as delivered content", async () => {
  const schemas = createSchemaCache();
  const events: LlmEvent[] = [];

  try {
    const result = await runModel({
      input: {
        request,
        collect: false,
        onEvent(event) {
          events.push(event);
        },
      },
      provider: "p",
      signal: new AbortController().signal,
      limits: { ...limits(), maxEvents: 3 },
      schemas,
      service: {
        async describe() {
          return { ok: true, value: description };
        },
        async stream(input) {
          for (const event of [
            { type: "block-start", block: { kind: "text", id: "t" } },
            { type: "text-delta", id: "t", delta: "never delivered" },
          ] as const) {
            const sent = await input.onEvent(event);

            if (!sent.ok) return sent;
          }

          return { ok: true, value: { reason: { kind: "length", limit: "output" } } };
        },
      },
    });
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded", hasOutput: false },
    });
    expect(events.at(-1)).toMatchObject({ type: "error", error: { hasOutput: false } });
  } finally {
    schemas.close();
  }
});
it("iterator retains the original core failure receipt when no event channel ever opens", async () => {
  const original = {
    ok: false,
    error: { source: "core", code: "invalid-input", message: "original core receipt" },
  } as const;
  const service: LlmService = {
    async stream() {
      return original;
    },
    async generate() {
      return original;
    },
    async describe() {
      return original;
    },
  };
  const stream = streamLlm(service, request);
  const events: LlmEvent[] = [];

  for await (const event of stream) events.push(event);

  expect(events).toEqual([]);
  expect(await stream.result).toBe(original);
});
