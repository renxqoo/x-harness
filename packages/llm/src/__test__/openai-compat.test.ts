// openai-compat 硬化矩阵（docs/LLM.md §1.4/§3）：本地 HTTP 假服务器表驱动 SSE 脚本——
// 分片写响应体制造撕裂；失败契约（http-<status>/network/retryAfterMs）；abort；消息与工具表转换。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenaiCompatAdapter } from "../openai-compat.ts";
import type { LlmChunk, LlmRequest } from "../types.ts";

interface Captured {
  method?: string;
  path?: string;
  auth?: string | null;
  body?: Record<string, unknown>;
}

interface Scene {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** 每个 string 元素为一次 write 的字节串（分片制造撕裂） */
  readonly chunks: readonly string[];
  /** 直接断开连接（不写任何响应体） */
  readonly destroy?: boolean;
  /** 写完 chunks 后延迟追加 trailing 帧（模拟 [DONE] 后仍写数据的端点）且不 end */
  readonly afterDone?: { readonly delayMs: number; readonly frame: string };
}

let server: Server | undefined;
let captured: Captured | undefined;
let scenes: Scene[] = [];

beforeEach(() => {
  captured = undefined;
  scenes = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server = undefined;
  });
});

function startServer(): Promise<string> {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      captured = {
        method: req.method,
        path: req.url,
        auth: req.headers["authorization"] ?? null,
        body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>,
      };
      const scene = scenes.shift() ?? { status: 200, chunks: [] };
      if (scene.destroy) {
        res.destroy();
        return;
      }
      res.writeHead(scene.status, { "content-type": "text/event-stream", ...scene.headers });
      for (const piece of scene.chunks) res.write(piece);
      if (scene.afterDone !== undefined) {
        setTimeout(() => res.write(scene.afterDone?.frame ?? ""), scene.afterDone.delayMs); // 不 end：等客户端关
        return;
      }
      res.end();
    });
  });
  const listening = server as Server;
  return new Promise((resolve) => {
    listening.listen(0, "127.0.0.1", () => {
      const address = listening.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

function adapter(baseUrl: string): ReturnType<typeof createOpenaiCompatAdapter> {
  return createOpenaiCompatAdapter({ baseUrl, apiKey: "k-test" });
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "m", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const sse = (...frames: string[]): string[] => frames.map((frame) => `data: ${frame}\n\n`);
const DONE = "data: [DONE]\n\n";

describe("openai-compat 流解析硬化（docs/LLM.md §1.4/§3）", () => {
  it("纯文本流 + usage（finish 之后到达）+ finish(stop) + [DONE]", async () => {
    const base = await startServer();
    scenes = [
      {
        status: 200,
        chunks: [
          ...sse('{"choices":[{"delta":{"content":"hel"}}]}'),
          ...sse('{"choices":[{"delta":{"content":"lo"}}]}'),
          ...sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}'),
          ...sse('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'), // usage 在 finish 后——不丢、不重复 finish
          DONE,
        ],
      },
    ];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", finish: { kind: "stop" } },
      { type: "usage", usage: { input: 3, output: 2 } },
    ]);
  });

  it("工具调用分片：index 首现带 callId/name，arguments 增量；finish_reason=tool_calls → stop", async () => {
    const base = await startServer();
    scenes = [
      {
        status: 200,
        chunks: [
          ...sse('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"add","arguments":"{\\"a\\""}}]}}]}'),
          ...sse('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}'),
          ...sse('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
          DONE,
        ],
      },
    ];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "c1", name: "add", argumentsDelta: '{"a"' },
      { type: "tool-call-delta", index: 0, argumentsDelta: ":1}" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("finish_reason=length → max-tokens", async () => {
    const base = await startServer();
    scenes = [{ status: 200, chunks: [...sse('{"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}'), DONE] }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "max-tokens" } });
  });

  it("跨 read 撕裂：半行 JSON 与多字节 UTF-8 跨片拼接", async () => {
    const base = await startServer();
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "héllo→世界" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      DONE,
    ];
    const full = frames.join("");
    scenes = [
      {
        status: 200,
        // 按 1 字节一片写——行边界与 UTF-8 序列都被撕裂
        chunks: [...full].map((ch) => ch),
      },
    ];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "héllo→世界" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("CRLF 行尾 / SSE 注释行 / event: 与 id: 行 / 空 data 跳过", async () => {
    const base = await startServer();
    scenes = [
      {
        status: 200,
        chunks: [
          ": keep-alive comment\r\n\r\n",
          "event: message\r\nid: 42\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\r\n\r\n",
          "data:   \r\n\r\n",
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\n",
          DONE,
        ],
      },
    ];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "x" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("回归：EOF 半行合法帧（无尾换行）不丢——不误判截断触发重试", async () => {
    const base = await startServer();
    scenes = [{ status: 200, chunks: ['data: {"choices":[{"delta":{"content":"tail"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'] }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "tail" },
      { type: "finish", finish: { kind: "stop" } }, // 半行帧被终 flush 救回，无 network 误判
    ]);
  });

  it("EOF 残量为垃圾文本：跳过不崩；无 finish → network 截断口径", async () => {
    const base = await startServer();
    scenes = [{ status: 200, chunks: ["data: not-json"] }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([{ type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } }]);
  });

  it("回归：[DONE] = 终止符——停读，trailing 数据不混入消息", async () => {
    const base = await startServer();
    scenes = [
      {
        status: 200,
        chunks: [...sse('{"choices":[{"delta":{"content":"a"}}]}'), ...sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}'), DONE],
        afterDone: { delayMs: 60, frame: 'data: {"choices":[{"delta":{"content":"AFTER-DONE"}}]}\n\n' },
      },
    ];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "a" },
      { type: "finish", finish: { kind: "stop" } }, // 终止符后流结束，AFTER-DONE 不产出
    ]);
  });

  it("回归：提前 break / [DONE] 后连接被客户端取消（无悬挂）", async () => {
    const base = await startServer();
    let serverSawClose = false;
    server?.on("close", () => {
      serverSawClose = true;
    });
    // 连接级观察走 res close：改用 connection 事件计数
    let connectionsClosed = 0;
    const countClose = (socket: import("node:net").Socket): void => {
      socket.on("close", () => {
        connectionsClosed += 1;
      });
    };
    server?.on("connection", countClose);
    scenes = [
      {
        status: 200,
        chunks: [...sse('{"choices":[{"delta":{"content":"a"}}]}'), DONE],
        afterDone: { delayMs: 5_000, frame: "" }, // 服务端挂住不 end——只有客户端 cancel 能释放
      },
    ];
    const stream = adapter(base).stream(request());
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // 消费首片后提前 break
    await iterator.return?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(connectionsClosed).toBe(1); // reader.cancel 生效：连接释放（releaseLock 后 cancel 无效的回归）
    expect(serverSawClose).toBe(false);
  });

  it("截断流（无 [DONE] 无 finish_reason）→ network finish（可重试口径）", async () => {
    const base = await startServer();
    scenes = [{ status: 200, chunks: [sse('{"choices":[{"delta":{"content":"partial"}}]}')[0] ?? ""] }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks.at(-1)).toEqual({
      type: "finish",
      finish: { kind: "error", message: "stream ended without finish", code: "network" },
    });
  });
});

describe("openai-compat 失败契约（docs/LLM.md §1.2——abort throw；其余 finish{error, code}）", () => {
  it("非 2xx → http-<status> code + 体摘要", async () => {
    const base = await startServer();
    scenes = [{ status: 500, chunks: ['{"error":"upstream blew"}'] }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks).toEqual([
      {
        type: "finish",
        finish: { kind: "error", message: '{"error":"upstream blew"}', code: "http-500" }, // message 只给体摘要，code 携带状态
      },
    ]);
  });

  it.each([
    ["整数秒", "2", 2000],
    ["小数秒", "2.5", 2500],
    ["零（立即重试）", "0", 0],
  ])("429 Retry-After %s → retryAfterMs 原样（%s ms）", async (_name, header, expectedMs) => {
    const base = await startServer();
    scenes = [{ status: 429, headers: { "retry-after": header }, chunks: ["rate limited"] }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks[0]).toEqual({
      type: "finish",
      finish: { kind: "error", message: "rate limited", code: "http-429", retryAfterMs: expectedMs },
    });
  });

  it("Retry-After HTTP-date：未来日期 → 相对毫秒；过去日期 → 0（立即）；垃圾 → 缺席", async () => {
    const base = await startServer();
    const future = new Date(Date.now() + 3_000).toUTCString();
    const finishOf = async (header: string): Promise<{ code?: string; retryAfterMs?: number }> => {
      scenes = [{ status: 503, headers: { "retry-after": header }, chunks: ["slow"] }];
      const chunks = await collect(adapter(base).stream(request()));
      return (chunks[0] as { type: "finish"; finish: { code?: string; retryAfterMs?: number } }).finish;
    };
    const futureFinish = await finishOf(future);
    expect(futureFinish.code).toBe("http-503");
    expect(futureFinish.retryAfterMs).toBeGreaterThan(2_000);
    expect(futureFinish.retryAfterMs).toBeLessThanOrEqual(3_000);
    expect((await finishOf("Wed, 21 Oct 2015 07:28:00 GMT")).retryAfterMs).toBe(0); // 过去 = 立即
    expect((await finishOf("not a date at all")).retryAfterMs).toBeUndefined(); // 垃圾 = 缺席
  });

  it("连接拒绝 → network finish", async () => {
    // 端口 1 保留段：连接必拒
    const chunks = await collect(adapter("http://127.0.0.1:1").stream(request()));
    expect(chunks[0]).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
  });

  it("读体中断（服务器 destroy）→ network finish；已有分片保序", async () => {
    const base = await startServer();
    scenes = [{ status: 200, chunks: [], destroy: true }];
    const chunks = await collect(adapter(base).stream(request()));
    expect(chunks[0]).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
  });

  it("请求前已 abort → throw AbortError", async () => {
    const base = await startServer();
    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter(base).stream(request({ signal: controller.signal })))).rejects.toThrow();
  });
});

describe("openai-compat 请求体（docs/LLM.md §1.4 消息与工具表转换）", () => {
  it("四角色转换 + assistant 空 text 有 tool_calls → content null + 工具表含 description；无工具不落 tools 键", async () => {
    const base = await startServer();
    scenes = [{ status: 200, chunks: [DONE] }];
    await collect(
      adapter(base).stream(
        request({
          temperature: 0.7,
          maxTokens: 128,
          tools: [
            { name: "add", inputSchema: { type: "object" } },
            { name: "sub", description: "减法", inputSchema: { type: "object" } },
          ] as never,
          messages: [
            { role: "system", text: "sys" },
            { role: "user", content: [{ type: "text", text: "q1" }, { type: "text", text: "q2" }] },
            { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "add", input: "{}" }] },
            { role: "tool", callId: "c1", content: "3" },
          ] as never,
        }),
      ),
    );
    expect(captured?.method).toBe("POST");
    expect(captured?.path).toBe("/chat/completions");
    expect(captured?.auth).toBe("Bearer k-test");
    const body = captured?.body ?? {};
    expect(body["stream"]).toBe(true);
    expect(body["temperature"]).toBe(0.7);
    expect(body["max_tokens"]).toBe(128);
    expect(body["tools"]).toEqual([
      { type: "function", function: { name: "add", parameters: { type: "object" } } },
      { type: "function", function: { name: "sub", description: "减法", parameters: { type: "object" } } },
    ]);
    expect(body["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q1\nq2" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "add", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "3" },
    ]);

    // 无工具：不落 tools 键
    scenes = [{ status: 200, chunks: [DONE] }];
    await collect(adapter(base).stream(request()));
    expect(Object.hasOwn(captured?.body ?? {}, "tools")).toBe(false);
  });
});
