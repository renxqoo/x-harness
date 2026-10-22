import { createHost as sourceHost } from "../core/src/index";
import { createToolPlugin as sourceTool, tools as sourceTools } from "../plugins/tools/src/index";
import type { Result } from "../core/src/index";
const built = (await import(
  new URL("../plugins/tools/dist/index.js", import.meta.url).href
)) as typeof import("../plugins/tools/src/index");
const core = (await import(
  new URL("../core/dist/index.js", import.meta.url).href
)) as typeof import("../core/src/index");

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

if (built.tools !== sourceTools) throw new Error("Token identity split");

let cancelled = 0;
let connected!: () => void;
const connection = new Promise<void>((resolve) => {
  connected = resolve;
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/hang")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("pending"));
            connected();
          },
          cancel() {
            cancelled++;
          },
        }),
      );

    return new Response("http-tool-result");
  },
});

try {
  for (const [hostFactory, toolFactory] of [
    [core.createHost, sourceTool],
    [sourceHost, built.createToolPlugin],
  ] as const) {
    const host = value(hostFactory({ limits: { callTimeoutMs: 2000 } }));

    try {
      const tool = value(
        toolFactory({
          name: "fetch",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          async execute(input, call) {
            const response = await fetch(new URL(input.path, server.url), { signal: call.signal });
            const text = await response.text();
            return { ok: true, value: { content: [{ type: "text", text }] } };
          },
        }),
      );
      value(await host.install([value(built.createToolsPlugin({ access: "allow" })), tool]));
      const service = value(host.use(built.tools));
      const result = value(
        await service.execute({ name: "fetch", callId: "network", input: { path: "/ok" } }),
      );

      if (result.content[0]?.type !== "text" || result.content[0].text !== "http-tool-result")
        throw new Error("HTTP result lost");

      if (hostFactory === sourceHost) {
        const abort = new AbortController();
        const pending = service.execute({
          name: "fetch",
          callId: "cancel",
          input: { path: "/hang" },
          signal: abort.signal,
        });
        await connection;
        abort.abort();

        if ((await pending).ok) throw new Error("Cancellation accepted late success");

        for (let i = 0; i < 100 && (host.inspect().activeTasks || !cancelled); i++)
          await Bun.sleep(5);

        if (!cancelled || host.inspect().activeTasks)
          throw new Error("HTTP cancellation did not drain");
      }
    } finally {
      value(await host.close());
    }
  }
} finally {
  await server.stop(true);
}

process.stdout.write("tools HTTP build passed\n");
