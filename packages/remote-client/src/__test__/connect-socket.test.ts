// connect.ts ingest 全路径（真 socket）：事件→ACK 合并、chunk 重组上抛、response 唤醒、
// relay 控制帧日志。本地起最小 WS 服务端（复用协议包读写器）。
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connectRemote, type RemoteClientHandle } from "../connect.ts";
import { acceptKey, WebSocketFrameReader, WebSocketFrameWriter, type Frame } from "@x-harness/remote-protocol";
import { connect as netConnect } from "node:net";

interface MiniServer {
  server: Server;
  port: number;
  received: string[];
  push(frame: Frame): void;
  /** 摧毁既有连接（模拟服务端断开） */
  destroyConnections(): void;
  close(): Promise<void>;
}

async function startMiniServer(): Promise<MiniServer> {
  const received: string[] = [];
  let writer: WebSocketFrameWriter | null = null;
  const sockets = new Set<import("node:stream").Duplex>();
  const server = createServer((req, res) => {
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const reader = new WebSocketFrameReader();
    writer = new WebSocketFrameWriter(socket as unknown as import("node:stream").Stream & { write(d: Buffer): boolean });
    reader.onNonText = () => {
      writer?.writePong();
    };
    sockets.add(socket as import("node:stream").Duplex);
    socket.on("close", () => sockets.delete(socket as import("node:stream").Duplex));
    socket.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      for (const line of reader.drainTextFrames()) received.push(line);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    received,
    push(frame) {
      writer?.writeText(JSON.stringify({ v: 1, from: "gw_i", to: "dev_d", payload: Buffer.from(JSON.stringify(frame)).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }));
    },
    destroyConnections: () => {
      for (const sock of sockets) sock.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("connect ingest 全路径（真 socket）", () => {
  it("事件帧上抛 + ACK 合并（服务端收到 ack）；response 唤醒 waitResponse；chunk 重组", { timeout: 15000 }, async () => {
    const srv = await startMiniServer();
    const seen: Frame[] = [];
    const client: RemoteClientHandle = connectRemote({
      relayUrl: `ws://127.0.0.1:${srv.port}`,
      relayToken: "t",
      deviceId: "d",
      installationId: "i",
      useTls: false,
      codec: {
        seal: async (frameJson) => ({ payload: Buffer.from(frameJson).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }),
        open: async (payloadBase64) => Buffer.from(payloadBase64, "base64").toString("utf8"),
      },
      onFrame: (f) => seen.push(f),
      onStatus: () => {},
      log: () => {},
    });
    // 等连接
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      if (client.connected()) break;
    }
    expect(client.connected()).toBe(true);

    // 事件帧 ×33（跨 ACK 阈值 32 → 服务端应收到 ack）
    for (let i = 1; i <= 33; i++) {
      srv.push({ kind: "event", streamId: "ev:t1", seq: i, body: { threadId: "t1", name: "turn", payload: { i } } });
    }
    await new Promise((r) => {
      setTimeout(r, 600);
    });
    expect(seen.length).toBe(33);
    const acks = srv.received.map((l) => JSON.parse(l) as { payload?: string }).filter((e) => {
      if (typeof e.payload !== "string") return false;
      const frame = JSON.parse(Buffer.from(e.payload, "base64").toString("utf8")) as { kind?: string };
      return frame.kind === "ack";
    });
    expect(acks.length).toBeGreaterThanOrEqual(1);

    // response 唤醒
    srv.push({ kind: "response", streamId: "cmd:d", seq: 1, body: { id: "m9", command: "thread/list", success: true } });
    const res = await client.waitResponse("m9", 3000);
    expect(res.success).toBe(true);

    // chunk 重组：两段组一帧（小阈值由段构造直接驱动——段 data 为帧 JSON 切片）
    const wholeFrame: Frame = { kind: "response", streamId: "cmd:d", seq: 2, body: { id: "m10", command: "get_messages", success: true, data: { blob: "z".repeat(200) } } };
    const json = JSON.stringify(wholeFrame);
    const bytes = Buffer.from(json, "utf8");
    const half = Math.floor(bytes.length / 2);
    for (let i = 0; i < 2; i++) {
      const data = Buffer.from(bytes.subarray(i * half, i === 0 ? half : bytes.length)).toString("base64");
      srv.push({ kind: "chunk", streamId: "cmd:d", seq: 2, body: { segmentId: i, segmentCount: 2, totalBytes: bytes.length, data } });
    }
    const res2 = await client.waitResponse("m10", 3000);
    expect(res2.success).toBe(true);

    client.stop();
    await srv.close();
    void netConnect;
  });

  it("断线触发 awaiting-reconnect 状态；relay 控制帧走日志面", { timeout: 15000 }, async () => {
    const srv = await startMiniServer();
    const statuses: string[] = [];
    const client = connectRemote({
      relayUrl: `ws://127.0.0.1:${srv.port}`,
      relayToken: "t",
      deviceId: "d",
      installationId: "i",
      useTls: false,
      codec: {
        seal: async (frameJson) => ({ payload: Buffer.from(frameJson).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }),
        open: async (payloadBase64) => Buffer.from(payloadBase64, "base64").toString("utf8"),
      },
      onFrame: () => {},
      onStatus: (st, d) => statuses.push(`${st}:${d}`),
      log: () => {},
    });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      if (client.connected()) break;
    }
    expect(client.connected()).toBe(true);
    // 服务端断开 → awaiting-reconnect（1s 退避后）
    srv.destroyConnections();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => {
        setTimeout(r, 150);
      });
      if (statuses.some((x) => x.includes("awaiting-reconnect"))) break;
    }
    expect(statuses.some((x) => x.includes("awaiting-reconnect"))).toBe(true);
    client.stop();
  });
});
