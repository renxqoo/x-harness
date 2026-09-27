import { createServer, type Server } from "node:net";
import { parseResp } from "../resp.ts";
// fake RESP server（测试装置）：内存语义，覆盖 store-redis 用到的命令子集。
/** fake RESP server：内存语义（GET/SET/DEL/SADD/SISMEMBER/PUBLISH/SUBSCRIBE） */
export interface FakeRespServer {
  server: Server;
  port: number;
  received: string[][];
  subscribe(fn: (channel: string, message: string) => void): void;
  close(): Promise<void>;
}

export function startFakeRespServer(): Promise<FakeRespServer> {
  const state = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const subscribers = new Set<(channel: string, message: string) => void>();
  const received: string[][] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        // 解析请求命令（array of bulk strings）
        const parsed = parseResp(buffer);
        if (parsed === null) return;
        buffer = buffer.subarray(parsed.consumed);
        const command = parsed.value;
        if (!Array.isArray(command)) continue;
        const args = command.map(String);
        received.push(args);
        const [verb, ...rest] = args;
        switch (verb) {
          case "AUTH":
            socket.write("+OK\r\n");
            break;
          case "GET": {
            const value = state.get(rest[0] ?? "");
            socket.write(value === undefined ? "$-1\r\n" : `$${value.length}\r\n${value}\r\n`);
            break;
          }
          case "SET":
            state.set(rest[0] ?? "", rest[1] ?? "");
            socket.write("+OK\r\n");
            break;
          case "DEL":
            state.delete(rest[0] ?? "");
            socket.write(":1\r\n");
            break;
          case "SADD": {
            const set = sets.get(rest[0] ?? "") ?? new Set<string>();
            set.add(rest[1] ?? "");
            sets.set(rest[0] ?? "", set);
            socket.write(":1\r\n");
            break;
          }
          case "SISMEMBER": {
            const hit = sets.get(rest[0] ?? "")?.has(rest[1] ?? "") ?? false;
            socket.write(hit ? ":1\r\n" : ":0\r\n");
            break;
          }
          case "PUBLISH": {
            const [channel, message] = rest;
            for (const fn of subscribers) fn(channel ?? "", message ?? "");
            socket.write(":1\r\n");
            break;
          }
          case "SUBSCRIBE":
            // 订阅确认帧不发（client send() 不为 SUBSCRIBE 排 pending——发会错位）
            subscribers.add((_channel: string, _message: string) => {});
            break;
          default:
            socket.write("-ERR unknown\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        received,
        subscribe(fn: (channel: string, message: string) => void) {
          subscribers.add(fn);
        },
        async close() {
          for (const s of sockets) s.destroy();
          await new Promise<void>((resolve2) => {
            server.close(() => resolve2());
          });
        },
      });
    });
  });
}
