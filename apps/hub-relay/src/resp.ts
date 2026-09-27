// 最小 RESP 客户端（DESIGN §1.5）：GET/SET/DEL/SADD/SMISMEMBER/PUBLISH/SUBSCRIBE。
// 只实现 relay 用到的子集；连接断开自动重连；命令排队（订阅建立前的写命令照常可用）。
import { connect, type Socket } from "node:net";

export interface RespOptions {
  host: string;
  port: number;
  password?: string;
  onReconnect?(): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RespClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private subscribeHandlers = new Map<string, (channel: string, message: string) => void>();
  private connecting = false;
  private closed = false;

  constructor(private readonly options: RespOptions) {}

  async ensure(): Promise<void> {
    if (this.socket !== null && !this.socket.destroyed) return;
    if (this.connecting) {
      await new Promise<void>((resolve, reject) => {
        this.onceConnected.push((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      return;
    }
    this.connecting = true;
    try {
      await this.connectOnce();
      // 重连成功：重放订阅集（SUBSCRIBE 短连接语义——C6）
      for (const channel of this.subscribeHandlers.keys()) {
        this.socket?.write(encodeCommand(["SUBSCRIBE", channel]));
      }
    } finally {
      this.connecting = false;
      for (const fn of this.onceConnected) fn();
      this.onceConnected = [];
    }
  }

  private onceConnected: Array<((error?: Error) => void)> = [];

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      const fail = (error: Error): void => {
        this.socket = null;
        // 连接失败：排空等待者（否则永久楔死——C6）
        const waiters = this.onceConnected.splice(0);
        for (const fn of waiters) (fn as (err?: Error) => void)(error);
        reject(error);
      };
      socket.on("error", fail);
      socket.on("connect", () => {
        if (this.options.password !== undefined) {
          socket.write(encodeCommand(["AUTH", this.options.password]));
        }
        this.socket = socket;
        resolve();
      });
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => {
        this.socket = null;
        if (!this.closed) {
          this.options.onReconnect?.();
          setTimeout(() => {
            void this.ensure().catch(() => {});
          }, 1000);
        }
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseResp(this.buffer);
      if (parsed === null) return;
      this.buffer = this.buffer.subarray(parsed.consumed);
      const value = parsed.value;
      // 订阅消息：["message", channel, payload]
      if (Array.isArray(value) && value.length === 3 && value[0] === "message") {
        const channel = String(value[1]);
        const message = String(value[2]);
        const handler = this.subscribeHandlers.get(channel);
        handler?.(channel, message);
        continue;
      }
      const pending = this.pending.shift();
      if (pending === undefined) continue;
      if (value instanceof Error) pending.reject(value);
      else pending.resolve(value);
    }
  }

  private send(args: string[]): Promise<unknown> {
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      return Promise.reject(new Error("resp: not connected"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      socket.write(encodeCommand(args));
    });
  }

  async get(key: string): Promise<string | null> {
    const value = await this.send(["GET", key]);
    return value === null ? null : String(value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.send(["SET", key, value]);
  }

  async del(key: string): Promise<void> {
    await this.send(["DEL", key]);
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.send(["SADD", key, member]);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const value = await this.send(["SISMEMBER", key, member]);
    return value === 1;
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.send(["PUBLISH", channel, message]);
  }

  async subscribe(channel: string, handler: (channel: string, message: string) => void): Promise<void> {
    this.subscribeHandlers.set(channel, handler);
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      throw new Error("resp: not connected");
    }
    // SUBSCRIBE 不排 pending：确认帧是服务端推送形态（与 message 帧同通路）
    socket.write(encodeCommand(["SUBSCRIBE", channel]));
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}

/** RESP 编码（inline 不用，统一 RESP array of bulk strings） */
export function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

export type RespValue = string | number | null | Error | RespValue[];

/** RESP 解析（需要的子集：+ - : $ *）；不完整返回 null */
export function parseResp(input: Buffer): { value: RespValue; consumed: number } | null {
  if (input.length === 0) return null;
  const type = String.fromCharCode(input[0]!);
  const lineEnd = input.indexOf("\r\n");
  if (lineEnd < 0) return null;
  const head = input.subarray(1, lineEnd).toString("utf8");
  switch (type) {
    case "+":
      return { value: head, consumed: lineEnd + 2 };
    case "-":
      return { value: new Error(head), consumed: lineEnd + 2 };
    case ":":
      return { value: Number(head), consumed: lineEnd + 2 };
    case "$": {
      const length = Number(head);
      if (Number.isNaN(length)) return null;
      if (length === -1) return { value: null, consumed: lineEnd + 2 };
      const total = lineEnd + 2 + length + 2;
      if (input.length < total) return null;
      return { value: input.subarray(lineEnd + 2, lineEnd + 2 + length).toString("utf8"), consumed: total };
    }
    case "*": {
      const count = Number(head);
      if (Number.isNaN(count)) return null;
      if (count === -1) return { value: null, consumed: lineEnd + 2 };
      const items: RespValue[] = [];
      let cursor = lineEnd + 2;
      for (let i = 0; i < count; i++) {
        const parsed = parseResp(input.subarray(cursor));
        if (parsed === null) return null;
        items.push(parsed.value);
        cursor += parsed.consumed;
      }
      return { value: items, consumed: cursor };
    }
    default:
      return null;
  }
}
