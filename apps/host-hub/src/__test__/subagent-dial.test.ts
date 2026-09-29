import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

async function startDualServer(): Promise<{ baseUrl: string; server: Server; hits: Array<{ path: string; model: string }> }> {
  const hits: Array<{ path: string; model: string }> = [];
  const seenA = { count: 0 };
  const seenB = { count: 0 };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as { model?: string };
      const model = body.model ?? "";
      hits.push({ path: req.url ?? "", model });
      if ((req.url ?? "").includes("/v1/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        seenA.count += 1;
        if (seenA.count === 1) {
          const args = JSON.stringify({ description: "cross dial", prompt: "do work", subagent_type: "cross-model" });
          res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"${model}","usage":{"input_tokens":1,"output_tokens":0}}}\n\n`);
          res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"agent_spawn"}}\n\n`);
          res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"${args.replace(/"/g, '\\"')}"}}\n\n`);
          res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
          res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n`);
          res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          res.end();
          return;
        }
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"m2","model":"${model}","usage":{"input_tokens":1,"output_tokens":0}}}\n\n`);
        res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
        res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"parent wraps up"}}\n\n`);
        res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
        res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
        return;
      }
      seenB.count += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"content":"child done via b"},"finish_reason":null}]}\n\n`);
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(port)}`, server, hits };
}

const hosts: HostHandle[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("子代理跨模型拨号（真 adapter 路由）", () => {
  test("类型 .md 指定另一 provider 的模型 → 子请求打到 provider B 端点并完成", async () => {
    const dual = await startDualServer();
    servers.push(dual.server);
    const home = await tempDir("hub-sub-home-");
    const host = await startHost({
      script: [],
      env: { HOME: home, HUB_WORKER_PROVIDER: "real", HUB_WORKER_SCRIPT: "" },
    });
    hosts.push(host);
    host.send({ type: "models/add", id: "model-a", provider: "a", protocol: "anthropic", baseUrl: dual.baseUrl });
    const m1 = await host.response("model-a");
    expect(m1.error).toBeUndefined();
    host.send({ type: "models/add", id: "model-b", provider: "b", protocol: "openai", baseUrl: dual.baseUrl });
    const m2 = await host.response("model-b");
    expect(m2.error).toBeUndefined();
    host.send({ type: "auth/set_api_key", id: "k1", provider: "a", apiKey: "k" });
    const k1 = await host.response("k1");
    expect(k1.error).toBeUndefined();
    host.send({ type: "auth/set_api_key", id: "k2", provider: "b", apiKey: "k" });
    const k2 = await host.response("k2");
    expect(k2.error).toBeUndefined();
    host.send({ type: "agents/create", id: "ag1", name: "cross-model", description: "dial override probe", model: "model-b", systemPrompt: "you are a cross model child" });
    const ag = await host.response("ag1");
    expect(ag.error).toBeUndefined();
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir, modelId: "model-a" });
    const started = await host.response("s1");
    expect(started.error).toBeUndefined();
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "prompt", id: "p1", threadId, message: "spawn cross model child" });
    const ack = await host.response("p1");
    expect(ack.error).toBeUndefined();
    const finished = await host.event("agent/finished", undefined, 60_000);
    const payload = finished.payload as { outcome: string; detail: string };
    expect(payload.outcome).toBe("completed");
    expect(payload.detail).toBe("completed");
    expect(dual.hits.some((hit) => hit.model === "model-b" && !hit.path.includes("/v1/messages"))).toBe(true);
  }, 120_000);
});
