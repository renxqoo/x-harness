// 子代理跨模型拨号红测：父线程走 provider A 的模型，agent 类型 .md 指定 provider B
// 的模型 → spawn 的子必须路由到 B 的 adapter（真 compat adapter + SSE 假服务器——
// 按请求路径区分协议端点、按请求 model 区分剧本）并成功跑完。
// 症状：子代理模型只要与主 agent 不同模型（跨 provider）即报错。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

/**
 * 双端点 SSE 假服务（真 compat adapter 拨号目标）：
 * - /v1/messages（anthropic 协议）：model-a 首请求回 agent_spawn 工具调用，之后回文本
 * - 其余（openai completions）：model-b 回子代理完成文本
 * 命中记录（path+model）是断言面——子必须以 model-b 打到 openai 端点。
 */
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
          // 父首步：发起 agent_spawn（子类型 cross-model）
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
      // openai completions：子代理（model-b）
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
    // 真 host 进程（真 worker spawn + 真 compat adapter；剧本模式关闭）
    const host = await startHost({
      script: [],
      env: { HOME: home, HUB_WORKER_PROVIDER: "real", HUB_WORKER_SCRIPT: "" },
    });
    hosts.push(host);
    // ① 双 provider 目录：a = anthropic（父），b = openai（子类型指定）
    host.send({ type: "models/add", id: "model-a", provider: "a", protocol: "anthropic", baseUrl: dual.baseUrl });
    const m1 = await host.response("model-a");
    expect(m1.error).toBeUndefined();
    host.send({ type: "models/add", id: "model-b", provider: "b", protocol: "openai", baseUrl: dual.baseUrl });
    const m2 = await host.response("model-b");
    expect(m2.error).toBeUndefined();
    // ② auth/set_api_key 触发装配快照刷新（models/add 不刷快照——auth 族才刷）
    host.send({ type: "auth/set_api_key", id: "k1", provider: "a", apiKey: "k" });
    const k1 = await host.response("k1");
    expect(k1.error).toBeUndefined();
    host.send({ type: "auth/set_api_key", id: "k2", provider: "b", apiKey: "k" });
    const k2 = await host.response("k2");
    expect(k2.error).toBeUndefined();
    // ③ 类型 .md：model = model-b（provider b——与父不同）
    host.send({ type: "agents/create", id: "ag1", name: "cross-model", description: "dial override probe", model: "model-b", systemPrompt: "you are a cross model child" });
    const ag = await host.response("ag1");
    expect(ag.error).toBeUndefined();
    // ④ 起线程（父显式 model-a）→ prompt → 父 spawn 子（类型 model-b）→ 子经 b 完成
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir, modelId: "model-a" });
    const started = await host.response("s1");
    expect(started.error).toBeUndefined();
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "prompt", id: "p1", threadId, message: "spawn cross model child" });
    const ack = await host.response("p1");
    expect(ack.error).toBeUndefined();
    const finished = await host.event("agent/finished", undefined, 60_000);
    const payload = finished.payload as { outcome: string; detail: string };
    // 红测断言：子必须 completed（症状 = failed/no-adapter/串 provider 报错）
    expect(payload.outcome).toBe("completed");
    expect(payload.detail).toBe("completed");
    // 子请求必须打到 provider B（openai completions 路径）且 model = model-b
    expect(dual.hits.some((hit) => hit.model === "model-b" && !hit.path.includes("/v1/messages"))).toBe(true);
  }, 120_000);
});
