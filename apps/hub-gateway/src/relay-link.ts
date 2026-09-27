// relay 链路（DESIGN §1.5）：出站 WSS 连 relay、enroll 签名注册、token refresh、
// 撤销推送、重连指数退避。传输用 node:tls + ws 帧协议（复用 hub-relay 的读写器——
// 协议包零依赖，帧协议属 relay 域共享件）。
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { WebSocketFrameReader } from "../../hub-relay/src/ws-reader.ts";
import { WebSocketFrameWriter } from "../../hub-relay/src/ws-writer.ts";
import { signBytes } from "@x-harness/remote-protocol";
import { enrollTranscript } from "../../hub-relay/src/auth.ts";

export interface RelayLinkOptions {
  relayUrl: string;
  installationId: string;
  gatewaySigningSecret: string;
  gatewaySigningPub: string;
  /** TLS（LB 终结时为 ws→明文 socket；直连 wss 时 TLS） */
  useTls: boolean;
  onFrame(line: string): void;
  onStatus(status: "connected" | "disconnected", detail: string): void;
  log(message: string): void;
}

export interface RelayLinkHandle {
  send(line: string): boolean;
  connected(): boolean;
  stop(): void;
  /** enroll（返回 gateway token + 节点 id；失败 null） */
  enrollOnce(): Promise<{ token: string } | null>;
}

export function startRelayLink(options: RelayLinkOptions): RelayLinkHandle {
  const url = new URL(options.relayUrl.replace(/^wss/, "https").replace(/^ws/, "http"));
  const port = url.port === "" ? (options.useTls ? 443 : 80) : Number(url.port);
  let socket: import("node:net").Socket | null = null;
  let writer: WebSocketFrameWriter | null = null;
  let stopped = false;
  let backoff = 1000;
  let gatewayToken: string | null = null;

  function openConnection(): void {
    if (stopped) return;
    options.onStatus("disconnected", `dialing ${url.host}`);
    const s = options.useTls
      ? tlsConnect({ host: url.hostname, port, servername: url.hostname })
      : netConnect({ host: url.hostname, port });
    wire(s);
  }

  function wire(s: import("node:net").Socket): void {
    socket = s;
    const reader = new WebSocketFrameReader();
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    s.on("data", (chunk: Buffer) => {
      if (!handshakeDone) {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.includes("\r\n\r\n")) return;
        const head = buf.subarray(0, buf.indexOf("\r\n\r\n")).toString();
        if (!head.includes("101")) {
          options.onStatus("disconnected", `handshake failed: ${head.split("\r\n")[0]}`);
          scheduleReconnect();
          return;
        }
        handshakeDone = true;
        const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
        if (rest.length > 0) reader.push(rest);
        writer = new WebSocketFrameWriter(s);
        options.onStatus("connected", url.host);
        backoff = 1000;
        return;
      }
      reader.push(chunk);
      for (const line of reader.drainTextFrames()) options.onFrame(line);
    });
    s.on("error", (error: Error) => {
      options.onStatus("disconnected", String(error.message));
    });
    s.on("close", () => {
      socket = null;
      writer = null;
      handshakeDone = false;
      options.onStatus("disconnected", "closed");
      scheduleReconnect();
    });
    // 客户端握手（不掩码——服务端按不掩码也解；RFC 客户端应掩码，此处服务端实现兼容两者）
    const key = Buffer.from(Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).toString("base64");
    const tokenQuery = gatewayToken !== null ? `?token=${encodeURIComponent(gatewayToken)}` : "";
    s.write(`GET ${url.pathname === "/" ? "/" : url.pathname}${tokenQuery} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = backoff + Math.random() * 250;
    backoff = Math.min(backoff * 2, 30_000);
    setTimeout(() => {
      if (stopped) return;
      openConnection();
    }, delay);
  }

  openConnection();
  return {
    send(line) {
      if (writer === null) return false;
      writer.writeText(line);
      return true;
    },
    connected: () => writer !== null,
    stop() {
      stopped = true;
      socket?.destroy();
    },
    async enrollOnce() {
      // 两步 enroll：challenge（nodeId+nonce）→ 签名注册
      const challengeReply = await httpPost(url, options.useTls, "/api/enroll/challenge", "{}");
      if (challengeReply === null || challengeReply.status !== 200) {
        options.log(`enroll challenge failed: ${String(challengeReply?.status)}`);
        return null;
      }
      const challenge = JSON.parse(challengeReply.body) as { nodeId?: string; nonce?: string };
      if (typeof challenge.nodeId !== "string" || typeof challenge.nonce !== "string") return null;
      const { nodeId, nonce } = challenge;
      const transcript = enrollTranscript({ installationId: options.installationId, gatewayKeyPub: options.gatewaySigningPub, nodeId, nonce });
      const sig = signBytes(options.gatewaySigningSecret, new TextEncoder().encode(transcript));
      const body = JSON.stringify({ installationId: options.installationId, gatewayKeyPub: options.gatewaySigningPub, sig, nonce });
      const reply = await httpPost(url, options.useTls, "/api/enroll", body);
      if (reply === null) return null;
      if (reply.status !== 200) {
        options.log(`enroll failed: ${reply.status} ${reply.body.slice(0, 120)}`);
        return null;
      }
      const parsed = JSON.parse(reply.body) as { token?: string };
      if (typeof parsed.token !== "string") return null;
      gatewayToken = parsed.token;
      return { token: parsed.token };
    },
  };
}

async function httpPost(url: URL, useTls: boolean, path: string, body: string): Promise<{ status: number; body: string } | null> {
  const port = url.port === "" ? (useTls ? 443 : 80) : Number(url.port);
  return new Promise((resolve) => {
    const s = useTls
      ? tlsConnect({ host: url.hostname, port, servername: url.hostname })
      : netConnect({ host: url.hostname, port });
    const fail = (): void => resolve(null);
    s.once("error", fail);
    s.on("connect", () => {
      s.write(`POST ${path} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let raw = "";
    s.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    s.on("close", () => {
      const statusLine = raw.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        resolve({ status, body: "" });
        return;
      }
      const head = raw.slice(0, headerEnd);
      let body = raw.slice(headerEnd + 4);
      if (head.toLowerCase().includes("transfer-encoding: chunked")) {
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
      resolve({ status, body });
    });
  });
}
