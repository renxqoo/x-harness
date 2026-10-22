import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createHost } from "../core/src/index";
import type { Result } from "../core/src/index";
import { createLlmPlugin, defineLlmProvider } from "../plugins/llm/src/index";
import { createLlmProviderPlugin } from "../plugins/llm/src/provider";
import type { ProviderEvent, ProviderEnd, LlmResult } from "../plugins/llm/src/index";
import { createToolsPlugin, createToolPlugin } from "../plugins/tools/src/index";
import { createToolSchedulerPlugin } from "../plugins/tool-scheduler/src/index";
import { createAgentLoopPlugin, agentLoop } from "../plugins/agent-loop/src/index";
const root = resolve(import.meta.dir, ".."),
  hash = createHash("sha256"),
  files: string[] = [];

for (const packageName of [
  "core",
  "plugins/agent-loop",
  "plugins/llm",
  "plugins/tools",
  "plugins/tool-scheduler",
])
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: resolve(root, packageName, "src") }))
    if (!file.split("/").includes("__test__")) files.push(`${packageName}/src/${file}`);

for (const file of files.sort()) {
  hash.update(file);
  hash.update(await readFile(resolve(root, file)));
}

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const samples: {
  kind: string;
  run: number;
  runs: number;
  milliseconds: number;
  modelRequests: number;
  toolCalls: number;
  peak: number;
  events: number;
}[] = [];

for (const width of [0, 1, 8]) {
  const host = value(createHost({ limits: { callTimeoutMs: 30000, maxCallDepth: 256 } })),
    provider = value(defineLlmProvider("benchmark"));
  let active = 0,
    peak = 0,
    models = 0,
    delivered = 0;

  try {
    const llmProvider = value(
      createLlmProviderPlugin({
        token: provider,
        models: {
          m: {
            model: "m",
            protocol: "benchmark",
            input: ["text"],
            developer: false,
            tools: true,
            citations: false,
            output: ["text"],
            providerTools: [],
          },
        },
        async run(input): Promise<LlmResult<ProviderEnd>> {
          models++;
          const toolRound = width > 0 && input.request.messages.at(-1)?.role !== "tool",
            events: ProviderEvent[] = [];

          if (toolRound) {
            for (let i = 0; i < width; i++) {
              const id = `block${i}`;
              events.push(
                { type: "block-start", block: { id, kind: "tool-call" } },
                { type: "tool-call-delta", id, field: "callId", delta: `call${i}` },
                { type: "tool-call-delta", id, field: "name", delta: "operation" },
                { type: "tool-call-delta", id, field: "input", delta: "{}" },
                { type: "block-end", id, status: "complete" },
              );
            }
          } else
            events.push(
              { type: "block-start", block: { id: "text", kind: "text" } },
              { type: "text-delta", id: "text", delta: "done" },
              { type: "block-end", id: "text", status: "complete" },
            );

          for (const event of events) {
            const sent = await input.onEvent(event);

            if (!sent.ok) return sent;
          }

          return { ok: true, value: { reason: { kind: toolRound ? "tool-calls" : "stop" } } };
        },
      }),
    );
    value(
      await host.install([
        llmProvider,
        value(
          createLlmPlugin({ providers: { benchmark: provider }, defaultProvider: "benchmark" }),
        ),
        value(createToolsPlugin({ access: "allow" })),
        value(createToolSchedulerPlugin({ access: "allow" })),
        value(
          createToolPlugin({
            name: "operation",
            concurrency: 8,
            inputSchema: { type: "object" },
            async execute() {
              active++;
              peak = Math.max(peak, active);
              await new Promise((resolve) => setTimeout(resolve, 1));
              active--;
              return { ok: true, value: { content: [{ type: "text", text: "result" }] } };
            },
          }),
        ),
        value(createAgentLoopPlugin({ access: "allow" })),
      ]),
    );
    const service = value(host.use(agentLoop));

    for (let run = 0; run < 4; run++) {
      peak = 0;
      const beforeModels = models,
        beforeEvents = delivered,
        start = performance.now();

      for (let i = 0; i < 10; i++) {
        const result = value(
          await service.run({
            model: "m",
            messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
            onEvent() {
              delivered++;
            },
          }),
        );

        if (
          result.steps !== (width ? 2 : 1) ||
          result.toolCalls !== width ||
          result.stopReason !== "model"
        )
          throw new Error("Agent result invariant failed");
      }

      const milliseconds = performance.now() - start;

      if (host.inspect().activeCalls || host.inspect().activeTasks || (width && peak !== width))
        throw new Error("Agent work or concurrency invariant failed");

      if (run)
        samples.push({
          kind: width ? `tools-${width}` : "text",
          run,
          runs: 10,
          milliseconds,
          modelRequests: models - beforeModels,
          toolCalls: width * 10,
          peak,
          events: delivered - beforeEvents,
        });
    }
  } finally {
    value(await host.close());
  }
}

await mkdir(resolve(root, "plugins/agent-loop/reviews"), { recursive: true });
await writeFile(
  resolve(root, "plugins/agent-loop/reviews/benchmark.json"),
  JSON.stringify(
    {
      command: "bun run benchmark:agent",
      timestamp: new Date().toISOString(),
      runtime: Bun.version,
      platform: process.platform,
      arch: process.arch,
      sourceSha256: hash.digest("hex"),
      hashedProductionFiles: files.length,
      warmupBatches: 1,
      runsPerBatch: 10,
      samples,
      interpretation:
        "Local complete public provider, model, event, tool and scheduler path. Tools use 1ms simulated work. Samples are total elapsed time for ten sequential runs; no per-request tail latency, remote model latency, cross-framework superiority or distributed availability claim.",
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`${samples.length} complete agent batch samples passed\n`);
