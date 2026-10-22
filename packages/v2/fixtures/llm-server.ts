export interface LlmScene {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks: readonly (string | Uint8Array)[];
  readonly pause?: Promise<void>;
  readonly stall?: boolean;
}

export function createLlmServer() {
  const scenes: LlmScene[] = [];
  const requests: { readonly path: string; readonly headers: Headers; readonly body: unknown }[] =
    [];
  let cancelled = 0;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      });
      const scene = scenes.shift();

      if (!scene) return new Response("missing scene", { status: 500 });

      let index = 0;
      let ended = false;
      let owned: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          owned = controller;
          streams.add(controller);
        },
        async pull(controller) {
          if (scene.pause) await scene.pause;

          if (ended) return;

          if (index < scene.chunks.length) {
            const chunk = scene.chunks[index++]!;
            controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
          } else if (!scene.stall) {
            ended = true;
            owned = undefined;
            streams.delete(controller);
            controller.close();
          }
        },
        cancel() {
          cancelled++;
          ended = true;

          if (owned) streams.delete(owned);

          owned = undefined;
        },
      });
      return new Response(body, {
        status: scene.status ?? 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req-fixture",
          ...scene.headers,
        },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    get cancelled() {
      return cancelled;
    },
    scene(input: LlmScene) {
      scenes.push(input);
    },
    async close() {
      for (const stream of streams) {
        try {
          stream.close();
        } catch {}
      }

      streams.clear();
      await server.stop(true);
    },
  };
}

export function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}
