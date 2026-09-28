// 参考客户端：经 relay 连 gateway（e2e 驱动形态）。传输/L3 信封/L2 outbox 在此；
// L1 E2E 经 codec 注入（ratchet 会话由装配层建立——两端配对产物，见 e2e 装置）。
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";
import { ChunkReassemblerPool, decodeEnvelope, encodeEnvelope, parseFrame, type Frame, type ResponseBody } from "@x-harness/remote-protocol";
import { WebSocketFrameReader, WebSocketFrameWriter } from "@x-harness/remote-protocol";

export interface RemoteCodec {
  /** 明文帧 JSON → {payload, nonce}；失败 null（不发） */
  seal(frameJson: string): Promise<{ payload: string; nonce: string } | null>;
  /** 密文 → 明文帧 JSON；失败 null（丢弃+计数） */
  open(payloadBase64: string, nonceBase64: string): Promise<string | null>;
}

export interface RemoteClientOptions {
  relayUrl: string;
  relayToken: string;
  deviceId: string;
  installationId: string;
  useTls: boolean;
  codec: RemoteCodec;
  onFrame(frame: Frame): void;
  onStatus(status: "connected" | "disconnected", detail: string): void;
  log(message: string): void;
}

export interface RemoteClientHandle {
  sendCommand(spec: { command: string; id: string; args?: Record<string, unknown> }): Promise<boolean>;
  sendFrame(frame: Frame): Promise<boolean>;
  /** 断线窗口命令重发（重连后调用） */
  resendOutbox(): Promise<void>;
  /** outbox 未结算命令 id（观测面） */
  outboxIds(): string[];
  waitResponse(id: string, timeoutMs?: number): Promise<ResponseBody>;
  frames(): Frame[];
  connected(): boolean;
  stop(): void;
}

export function connectRemote(options: RemoteClientOptions): RemoteClientHandle {
  const url = new URL(options.relayUrl.replace(/^wss/, "https").replace(/^ws/, "http"));
  const defaultPort = options.useTls ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  const frames: Frame[] = [];
  const responseWaiters = new Map<string, (response: ResponseBody) => void>();
  const chunkPool = new ChunkReassemblerPool();
  // 命令 outbox（§1.2：response 到达前保留；重连后重发）+ ACK 滑动窗口
  const commandOutbox = new Map<string, Frame>();
  let ackDebt = 0;
  let lastAckAt = 0;
  let stopped = false;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      // 重拨由外层重建 connectRemote；此处最小实现：标记断线状态（App 端按需重建）。
      // 参考客户端保持轻量：重连策略属 App 装配层（RECONNECT_BACKOFF_* 常量供其使用）。
      options.onStatus("disconnected", "awaiting-reconnect");
    }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  /** 设备→gateway ACK（§1.2：32 帧或 250ms 合并） */
  function maybeSendAck(): void {
    ackDebt += 1;
    const now = Date.now();
    if (ackDebt < 32 && now - lastAckAt < 250) return;
    const acks = [...perStreamLastSeq.entries()].map(([streamId, upTo]) => ({ streamId, upTo }));
    void sendFrameInternal({ kind: "ack", streamId: "ack", seq: ackSeq++, body: { acks } });
    ackDebt = 0;
    lastAckAt = now;
  }

  const perStreamLastSeq = new Map<string, number>();
  let ackSeq = 1;
  let writer: WebSocketFrameWriter | null = null;
    let nextSeq = 1;

  async function sendFrameInternal(frame: Frame): Promise<boolean> {
    if (writer === null || stopped) return false;
    const sealed = await options.codec.seal(JSON.stringify(frame));
    if (sealed === null) return false;
    const env = encodeEnvelope({ v: 1, from: `dev_${options.deviceId}`, to: `gw_${options.installationId}`, payload: sealed.payload, nonce: sealed.nonce });
    writer.writeText(env);
    return true;
  }

  async function ingest(line: string): Promise<void> {
    const env = decodeEnvelope(line);
    if (env === null) return;
    if (env.from === "relay") {
      options.log(`relay: ${env.payload.slice(0, 80)}`);
      return;
    }
    const plaintext = await options.codec.open(env.payload, env.nonce);
    if (plaintext === null) return;
    const frame = parseFrame(plaintext);
    if (frame === null) return;
    if (frame.kind === "chunk") {
      // chunk 段重组（§1.2）：集齐还原逻辑帧再上抛
      const body = frame.body as { segmentId: number; segmentCount: number; data: string };
      const whole = chunkPool.add({ streamId: frame.streamId, seq: frame.seq, segmentId: body.segmentId, segmentCount: body.segmentCount, data: body.data });
      if (whole === null) return;
      const wholeFrame = parseFrame(whole);
      if (wholeFrame === null) return;
      frames.push(wholeFrame);
      options.onFrame(wholeFrame);
      if (wholeFrame.kind === "response") {
        const body2 = wholeFrame.body as ResponseBody;
        const waiter = responseWaiters.get(body2.id);
        responseWaiters.delete(body2.id);
        waiter?.(body2);
      }
      return;
    }
    frames.push(frame);
    options.onFrame(frame);
    perStreamLastSeq.set(frame.streamId, Math.max(perStreamLastSeq.get(frame.streamId) ?? 0, frame.seq));
    maybeSendAck();
    if (frame.kind === "response") {
      const body = frame.body as ResponseBody;
      commandOutbox.delete(body.id);
      const waiter = responseWaiters.get(body.id);
      responseWaiters.delete(body.id);
      waiter?.(body);
    }
  }

  const s = options.useTls ? tlsConnect({ host: url.hostname, port, servername: url.hostname }) : netConnect({ host: url.hostname, port });
  const reader = new WebSocketFrameReader();
  let handshakeDone = false;
  let buf = Buffer.alloc(0);
  const onHandshake = (chunk: Buffer): boolean => {
    buf = Buffer.concat([buf, chunk]);
    if (!buf.includes("\r\n\r\n")) return false;
    const head = buf.subarray(0, buf.indexOf("\r\n\r\n")).toString();
    if (!head.includes("101")) {
      options.onStatus("disconnected", head.split("\r\n")[0] ?? "handshake failed");
      return false;
    }
    handshakeDone = true;
    writer = new WebSocketFrameWriter(s, { clientMask: true });
    options.onStatus("connected", url.host);
    const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
    if (rest.length > 0) reader.push(rest);
    return true;
  };
  s.on("data", (chunk: Buffer) => {
    if (!handshakeDone) {
      void onHandshake(chunk);
      return;
    }
    reader.push(chunk);
    // ping → pong（服务端活性探测；不回会被 60s 断线）
    reader.onNonText = () => {
      writer?.writePong();
    };
    for (const line of reader.drainTextFrames()) void ingest(line);
  });
  s.on("error", (error: Error) => options.onStatus("disconnected", String(error.message)));
  s.on("close", () => {
    writer = null;
    options.onStatus("disconnected", "closed");
    scheduleReconnect();
  });
  const key = randomBytes(16).toString("base64");
  s.write(`GET ${url.pathname}?token=${encodeURIComponent(options.relayToken)} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);

  return {
    sendCommand(spec) {
      const frame: Frame = { kind: "command", streamId: `cmd:${options.deviceId}`, seq: nextSeq++, body: { command: spec.command, id: spec.id, args: spec.args } };
      commandOutbox.set(spec.id, frame);
      return sendFrameInternal(frame);
    },
    /** 断线窗口的命令重发（App 重连后调用；response 未到条目重投） */
    async resendOutbox(): Promise<void> {
      for (const frame of commandOutbox.values()) {
        await sendFrameInternal(frame);
      }
    },
    outboxIds(): string[] {
      return [...commandOutbox.keys()];
    },
    sendFrame(frame) {
      return sendFrameInternal(frame);
    },
    waitResponse(id, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const existing = frames.find((f) => f.kind === "response" && (f.body as ResponseBody).id === id);
        if (existing !== undefined) {
          resolve(existing.body as ResponseBody);
          return;
        }
        const timer = setTimeout(() => {
          responseWaiters.delete(id);
          reject(new Error(`waitResponse timeout: ${id}`));
        }, timeoutMs);
        responseWaiters.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    },
    frames: () => [...frames],
    connected: () => writer !== null,
    stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      s.destroy();
    },
  };
}
