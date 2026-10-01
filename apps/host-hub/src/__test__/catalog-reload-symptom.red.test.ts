import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

let host: HostHandle;
let dir: string;
let sse: Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "k9-symptom-"));
  sse = createServer((req, res) => {
    hits.push(String(req.headers["host"] ?? ""));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"m1","usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n');
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => {
    sse.listen(0, "127.0.0.1", () => resolve());
  });
  port = (sse.address() as { port: number }).port;
  host = await startHost({
    script: [],
    env: { HUB_WORKER_PROVIDER: "real", HUB_WORKER_SCRIPT: "" },
  });
}, 30_000);

afterAll(async () => {
  host.end();
  await host.exited();
  sse.close();
  await rm(dir, { recursive: true, force: true });
});

describe("K9 已知限制症状回归：reload 换 baseUrl 对已装配线程不生效", () => {
  it("线程装配后 catalog/reload 换 baseUrl → 后续请求仍打旧 baseUrl（DESIGN K9 明文限制）", async () => {
    host.send({ type: "models/add", id: "m1", provider: "p1", protocol: "anthropic", baseUrl: `http://127.0.0.1:${String(port)}` });
    await host.response("m1", 15_000);
    host.send({ type: "auth/set_api_key", id: "ka", provider: "p1", apiKey: "k" });
    await host.response("ka", 15_000);
    host.send({ type: "thread/start", id: "s1", cwd: dir, modelId: "m1" });
    const started = await host.response("s1", 20_000);
    expect(started.success).toBe(true);
    const threadId = String((started.data as { threadId?: string }).threadId ?? "");
    host.send({
      type: "catalog/reload",
      id: "q2",
      catalog: {
        providers: [{ provider: "p1", protocol: "anthropic", baseUrl: "http://127.0.0.1:9", apiKey: "k", models: ["m1"] }],
        default: { provider: "p1", model: "m1" },
      },
    });
    await host.response("q2", 15_000);
    host.send({ type: "prompt", id: "q3", threadId, message: "go" });
    await host.response("q3", 15_000);
    await host.wait((frame) => frame.type === "event" && (frame as { name?: string }).name === "settled", "settled", 20_000);
    expect(hits.some((h) => h === `127.0.0.1:${String(port)}`)).toBe(true);
  }, 45_000);
});
