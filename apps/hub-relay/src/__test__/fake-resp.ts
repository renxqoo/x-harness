import { createServer, type Server } from "node:net";
import { parseResp } from "../resp.ts";
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
    const handlers: Record<string, (rest: string[]) => void> = {
      AUTH: () => {
        socket.write("+OK\r\n");
      },
      GET: (rest) => {
        const value = state.get(rest[0] ?? "");
        socket.write(value === undefined ? "$-1\r\n" : `$${value.length}\r\n${value}\r\n`);
      },
      SET: (rest) => {
        state.set(rest[0] ?? "", rest[1] ?? "");
        socket.write("+OK\r\n");
      },
      DEL: (rest) => {
        state.delete(rest[0] ?? "");
        socket.write(":1\r\n");
      },
      SADD: (rest) => {
        const set = sets.get(rest[0] ?? "") ?? new Set<string>();
        set.add(rest[1] ?? "");
        sets.set(rest[0] ?? "", set);
        socket.write(":1\r\n");
      },
      SISMEMBER: (rest) => {
        const hit = sets.get(rest[0] ?? "")?.has(rest[1] ?? "") ?? false;
        socket.write(hit ? ":1\r\n" : ":0\r\n");
      },
      PUBLISH: (rest) => {
        const [channel, message] = rest;
        for (const fn of subscribers) fn(channel ?? "", message ?? "");
        socket.write(":1\r\n");
      },
      SUBSCRIBE: () => {
        subscribers.add((_channel: string, _message: string) => {});
      },
    };
    const handleCommand = (args: string[]): void => {
      const [verb, ...rest] = args;
      const handler = handlers[verb ?? ""];
      if (handler === undefined) {
        socket.write("-ERR unknown\r\n");
        return;
      }
      handler(rest);
    };
    const pump = (): void => {
      for (;;) {
        const parsed = parseResp(buffer);
        if (parsed === null) return;
        buffer = buffer.subarray(parsed.consumed);
        const command = parsed.value;
        if (!Array.isArray(command)) continue;
        const args = command.map(String);
        received.push(args);
        handleCommand(args);
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
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
