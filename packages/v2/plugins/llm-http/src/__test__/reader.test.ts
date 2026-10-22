import { expect, it } from "vitest";
import { requestStream, readHttpOptions } from "../index";
import type { HttpRequest } from "../index";
import { readLlmLimits } from "../../../llm/src/provider";
import { createLlmControl } from "../../../llm/src/domain/create-control";
import type { LlmResult } from "../../../llm/src/contracts";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

function fixture(response: () => Response, signal = new AbortController().signal): HttpRequest {
  const limits = value(readLlmLimits({ timeoutMs: 100, idleTimeoutMs: 5 }));
  return {
    config: value(
      readHttpOptions({ baseUrl: "http://test", apiKey: "test", fetch: async () => response() }),
    ),
    protocol: "test",
    path: "/test",
    body: {},
    headers: {},
    limits,
    control: createLlmControl({ signals: [signal], timeoutMs: 100 }),
    decoder: {
      accept() {
        return { ok: true, value: { events: [], stop: true } };
      },
      finish() {
        return { ok: true, value: { reason: { kind: "stop" } } };
      },
    },
    async onEvent() {
      return { ok: true, value: undefined };
    },
  };
}

it.each([200, 400])(
  "stalled HTTP %i body read is woken by cancellation and releases reader ownership",
  async (status) => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const input = fixture(
      () => new Response(body, { status, headers: { "content-type": "text/event-stream" } }),
    );

    try {
      expect(await requestStream(input)).toMatchObject({
        ok: false,
        error: { code: "timeout", phase: "stream" },
      });
      expect(cancelled).toBe(1);
      expect(body.locked).toBe(false);
    } finally {
      input.control.close();
    }
  },
);
it("a content type containing the SSE token is not the actual SSE media type", async () => {
  const input = fixture(
    () =>
      new Response("data: {}\n\n", {
        headers: { "content-type": "application/text/event-stream" },
      }),
  );

  try {
    expect(await requestStream(input)).toMatchObject({
      ok: false,
      error: { code: "protocol-error", phase: "headers" },
    });
  } finally {
    input.control.close();
  }
});
it("reader cancellation failure cannot turn a successful decode into a successful request", async () => {
  let enqueued = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!enqueued) {
        enqueued = true;
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      }
    },
    cancel() {
      throw new Error("close-secret");
    },
  });
  const input = fixture(
    () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );

  try {
    const result = await requestStream(input);
    expect(result).toMatchObject({ ok: false, error: { code: "network-error", phase: "close" } });
    expect(JSON.stringify(result)).not.toContain("close-secret");
    expect(body.locked).toBe(false);
  } finally {
    input.control.close();
  }
});
it("slow consumers stop reads while cancellation wakes transport immediately and still waits for the actual consumer", async () => {
  let pulls = 0;
  let cancelled = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
    },
    cancel() {
      cancelled++;
    },
  });
  const input = fixture(
    () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    abort.signal,
  );
  let settled = false;
  const execution = requestStream({
    ...input,
    decoder: {
      accept() {
        return {
          ok: true,
          value: {
            events: [{ type: "provider-event", scope: "request", name: "test/event", data: null }],
            stop: true,
          },
        };
      },
      finish: () => input.decoder.finish(),
    },
    async onEvent() {
      entered();
      await gate;
      return { ok: true, value: undefined };
    },
  }).then((result) => {
    settled = true;
    return result;
  });

  try {
    await ready;
    expect(pulls).toBeLessThanOrEqual(2);
    abort.abort();
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(settled).toBe(false);
    release();
    expect(await execution).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(body.locked).toBe(false);
  } finally {
    release();
    await execution;
    input.control.close();
  }
});
