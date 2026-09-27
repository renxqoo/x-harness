// relay 测试装置：真 TCP socket 起服务 + 客户端 WebSocket 连接（同仓 ws.ts 复用）
import { connect } from "node:net";
import { acceptKey, WebSocketFrameReader, WebSocketFrameWriter } from "@x-harness/remote-protocol";
import type { RelayHandle } from "../main.ts";
import { startRelay } from "../main.ts";
import { randomBytes } from "node:crypto";

export async function startTestRelay(spec?: { port?: number; nodeId?: string }): Promise<RelayHandle> {
  const port = spec?.port ?? 0;
  const handle = await startRelay({
    port,
    host: "127.0.0.1",
    tokenSecret: "test-secret-16bytes!!",
    singleInstance: true,
    nodeId: spec?.nodeId,
  });
  return handle;
}

export function relayPort(handle: RelayHandle): number {
  const address = handle.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

export interface TestClient {
  send(line: string): void;
  lines(): Promise<string[]>;
  waitLine(pred: (line: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
  raw: import("node:net").Socket;
}

export async function dialClient(spec: { port: number; token: string; path?: string }): Promise<TestClient> {
  const socket = connect({ host: "127.0.0.1", port: spec.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = new WebSocketFrameReader();
  const writer = new WebSocketFrameWriter(socket);
  const key = randomBytes(16).toString("base64");
  socket.write(`GET ${spec.path ?? "/"}?token=${encodeURIComponent(spec.token)} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  // 读握手响应
  await new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes("\r\n\r\n")) {
        const head = buf.subarray(0, buf.indexOf("\r\n\r\n")).toString();
        if (!head.includes("101")) {
          reject(new Error(`handshake failed: ${head.split("\r\n")[0]}`));
          return;
        }
        socket.off("data", onData);
        const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
        if (rest.length > 0) reader.push(rest);
        resolve();
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  const received: string[] = [];
  socket.on("data", (chunk: Buffer) => {
    reader.push(chunk);
    for (const line of reader.drainTextFrames()) received.push(line);
  });
  return {
    send: (line) => writer.writeText(line),
    lines: async () => received.slice(),
    waitLine: (pred, timeoutMs = 5000) =>
      new Promise<string>((resolve, reject) => {
        const started = Date.now();
        const tick = (): void => {
          const hit = received.find(pred);
          if (hit !== undefined) {
            resolve(hit);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`waitLine timeout; got ${received.length} lines`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      }),
    close: () => {
      writer.writeClose();
      socket.destroy();
    },
    raw: socket,
  };
}

export async function httpPost(spec: { port: number; path: string; body: unknown; token?: string }): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(JSON.stringify(spec.body));
  const socket = connect({ host: "127.0.0.1", port: spec.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const headers = [`POST ${spec.path} HTTP/1.1`, "Host: x", `Content-Length: ${payload.length}`, "Connection: close"];
  if (spec.token !== undefined) headers.push(`Authorization: Bearer ${spec.token}`);
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  socket.write(payload);
  const raw = await new Promise<string>((resolve) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
    });
    socket.on("close", () => resolve(buf.toString("utf8")));
  });
  socket.destroy();
  const statusLine = raw.split("\r\n")[0] ?? "";
  const status = Number(statusLine.split(" ")[1] ?? 0);
  const headerEnd = raw.indexOf("\r\n\r\n");
  const head = headerEnd >= 0 ? raw.slice(0, headerEnd) : "";
  let body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : "";
  if (head.toLowerCase().includes("transfer-encoding: chunked")) {
    // 逐 chunk 解包
    const parts: string[] = [];
    let cursor = 0;
    for (;;) {
      const lineEnd = body.indexOf("\r\n", cursor);
      if (lineEnd < 0) break;
      const size = Number.parseInt(body.slice(cursor, lineEnd), 16);
      if (Number.isNaN(size) || size === 0) break;
      parts.push(body.slice(lineEnd + 2, lineEnd + 2 + size));
      cursor = lineEnd + 2 + size + 2;
    }
    body = parts.join("");
  }
  return { status, body };
}

export { acceptKey };
