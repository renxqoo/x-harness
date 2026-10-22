import { createHost } from "../core/src/index";
import type { Result } from "../core/src/index";
import { createToolPlugin, createToolsPlugin } from "../plugins/tools/src/index";
import {
  createToolSchedulerPlugin,
  toolScheduler,
  toolScheduleAccess,
} from "../plugins/tool-scheduler/src/index";
const built = (await import(
  new URL("../plugins/tool-scheduler/dist/index.js", import.meta.url).href
)) as typeof import("../plugins/tool-scheduler/src/index");
const core = (await import(
  new URL("../core/dist/index.js", import.meta.url).href
)) as typeof import("../core/src/index");

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

if (built.toolScheduler !== toolScheduler || built.toolScheduleAccess !== toolScheduleAccess)
  throw new Error("Scheduler identity split");

let active = 0,
  maximum = 0,
  cancelled = 0;
let connected!: () => void;
const connection = new Promise<void>((resolve) => {
  connected = resolve;
});
const paths: string[] = [],
  events: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    events.push(`start:${path}`);

    if (path === "/hang")
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

    active++;
    maximum = Math.max(maximum, active);
    await Bun.sleep(5);
    active--;
    events.push(`finish:${path}`);
    return new Response(path);
  },
});

try {
  for (const [factory, scheduler] of [
    [core.createHost, createToolSchedulerPlugin],
    [createHost, built.createToolSchedulerPlugin],
  ] as const) {
    const host = value(factory({ limits: { callTimeoutMs: 3000, maxCallDepth: 256 } }));

    try {
      value(
        await host.install([
          value(createToolsPlugin({ access: "allow" })),
          value(scheduler({ access: "allow", limits: { concurrency: 2 } })),
          value(
            createToolPlugin({
              name: "fetch",
              concurrency: 2,
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
              async execute(input, call) {
                const response = await fetch(new URL(input.path, server.url), {
                  signal: call.signal,
                });
                return {
                  ok: true,
                  value: { content: [{ type: "text", text: await response.text() }] },
                };
              },
            }),
          ),
        ]),
      );
      const service = value(host.use(toolScheduler));
      const eventOffset = events.length;
      const report = value(
        await service.batch({
          calls: [
            { name: "fetch", callId: "c", input: { path: "/c" }, dependsOn: ["a"] },
            { name: "fetch", callId: "b", input: { path: "/b" } },
            { name: "fetch", callId: "a", input: { path: "/a" } },
          ],
        }),
      );
      const observed = events.slice(eventOffset);

      if (
        observed.indexOf("finish:/a") < 0 ||
        observed.indexOf("start:/c") <= observed.indexOf("finish:/a")
      )
        throw new Error("HTTP child started before parent completion");

      if (
        report.results.map((r) => r.callId).join() !== "c,b,a" ||
        report.results.some((r) => !r.result.ok)
      )
        throw new Error("HTTP DAG result lost");

      if (maximum !== 2) throw new Error("HTTP concurrency not enforced");

      if (factory === createHost) {
        const abort = new AbortController();
        const pending = service.batch({
          calls: [
            { name: "fetch", callId: "hang", input: { path: "/hang" } },
            { name: "fetch", callId: "queued", input: { path: "/should-not-run" } },
          ],
          concurrency: 1,
          signal: abort.signal,
        });
        await connection;
        abort.abort();

        if ((await pending).ok) throw new Error("Cancellation accepted success");

        for (
          let i = 0;
          i < 200 && (host.inspect().activeTasks || host.inspect().activeCalls || !cancelled);
          i++
        )
          await Bun.sleep(5);

        if (
          !cancelled ||
          host.inspect().activeTasks ||
          host.inspect().activeCalls ||
          paths.includes("/should-not-run")
        )
          throw new Error("Actual HTTP cancellation or queue cleanup failed");

        const snapshot = value(await service.inspect({}));

        if (snapshot.running || snapshot.queued || snapshot.requests)
          throw new Error("Scheduler retained work");
      }
    } finally {
      value(await host.close());
    }
  }
} finally {
  await server.stop(true);
}

process.stdout.write("scheduler HTTP build passed\n");
