// relay 链路（DESIGN §1.5）：出站 WSS 连 relay、两步 enroll、401 自动重认证（token
// refresh）、重连指数退避。传输 node:net/tls + 协议包 ws 帧读写器。
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";
import { WebSocketFrameReader, WebSocketFrameWriter, signBytes } from "@x-harness/remote-protocol";
import { enrollTranscript } from "../../hub-relay/src/auth.ts";

export interface RelayLinkOptions {
  relayUrl: string;
  installationId: string;
  gatewaySigningSecret: string;
  gatewaySigningPub: string;
  useTls: boolean;
  onFrame(line: string): void;
  onStatus(status: "connected" | "disconnected", detail: string): void;
  log(message: string): void;
}

export interface RelayLinkHandle {
  send(line: string): boolean;
  connected(): boolean;
  stop(): void;
  /** 两步 enroll（challenge → 签名注册）→ gateway token */
  enrollOnce(): Promise<{ token: string } | null>;
}

export function startRelayLink(options: RelayLinkOptions): RelayLinkHandle {
  const url = new URL(options.relayUrl.replace(/^wss/, "https").replace(/^ws/, "http"));
  const defaultPort = options.useTls ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  let socket: import("node:net").Socket | null = null;
  let writer: WebSocketFrameWriter | null = null;
  let stopped = false;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let gatewayToken: string | null = null;
  let enrollInFlight: Promise<{ token: string } | null> | null = null;

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
          // 401 = token 过期/被顶：重 enroll 换新 token 立即重拨（C2——TTL 后不失联）
          if (head.includes("401")) {
            void enrollOnce()
              .then((ok) => {
                if (ok === null) scheduleReconnect();
              })
              .catch(() => scheduleReconnect());
            return;
          }
          scheduleReconnect();
          return;
        }
        handshakeDone = true;
        writer = new WebSocketFrameWriter(s, { clientMask: true });
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        options.onStatus("connected", url.host);
        backoff = 1000;
        const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
        if (rest.length > 0) reader.push(rest);
        return;
      }
      reader.push(chunk);
      // ping → pong（relay 活性探测；不回会被 60s 断线）
      reader.onNonText = () => {
        writer?.writePong();
      };
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
    const key = randomBytes(16).toString("base64");
    const tokenQuery = gatewayToken !== null ? `?token=${encodeURIComponent(gatewayToken)}` : "";
    s.write(`GET ${url.pathname === "/" ? "/" : url.pathname}${tokenQuery} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  }

  function openConnection(): void {
    if (stopped) return;
    options.onStatus("disconnected", `dialing ${url.host}`);
    const s = options.useTls ? tlsConnect({ host: url.hostname, port, servername: url.hostname }) : netConnect({ host: url.hostname, port });
    wire(s);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const delay = backoff + Math.random() * 250;
    backoff = Math.min(backoff * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      openConnection();
    }, delay);
  }

  function enrollOnce(): Promise<{ token: string } | null> {
    // 单飞（并发 enroll 只跑一次——抖动环修复）
    if (enrollInFlight !== null) return enrollInFlight;
    enrollInFlight = enrollOnceInner()
      .catch(() => null)
      .finally(() => {
        enrollInFlight = null;
      });
    return enrollInFlight;
  }

  async function enrollOnceInner(): Promise<{ token: string } | null> {
    const challengeReply = await httpPost(url, { useTls: options.useTls, path: "/api/enroll/challenge", body: "{}" });
    if (challengeReply === null || challengeReply.status !== 200) {
      options.log(`enroll challenge failed: ${String(challengeReply?.status)}`);
      return null;
    }
    const challenge = JSON.parse(challengeReply.body) as { nodeId?: string; nonce?: string };
    if (typeof challenge.nodeId !== "string" || typeof challenge.nonce !== "string") return null;
    const transcript = enrollTranscript({ installationId: options.installationId, gatewayKeyPub: options.gatewaySigningPub, nodeId: challenge.nodeId, nonce: challenge.nonce });
    const sig = signBytes(options.gatewaySigningSecret, new TextEncoder().encode(transcript));
    const body = JSON.stringify({ installationId: options.installationId, gatewayKeyPub: options.gatewaySigningPub, sig, nonce: challenge.nonce });
    const reply = await httpPost(url, { useTls: options.useTls, path: "/api/enroll", body });
    if (reply === null) return null;
    if (reply.status !== 200) {
      options.log(`enroll failed: ${reply.status} ${reply.body.slice(0, 120)}`);
      return null;
    }
    const parsed = JSON.parse(reply.body) as { token?: string };
    if (typeof parsed.token !== "string") return null;
    gatewayToken = parsed.token;
    // 新 token 生效：重拨（stopped 守卫；旧连接由 close 路径自清）
    if (!stopped) {
      socket?.destroy();
      openConnection();
    }
    return { token: parsed.token };
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
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      socket?.destroy();
    },
    enrollOnce,
  };
}

async function httpPost(url: URL, spec: { useTls: boolean; path: string; body: string }): Promise<{ status: number; body: string } | null> {
  const { useTls, path, body } = spec;
  const defaultPort2 = useTls ? 443 : 80;
  const port = url.port === "" ? defaultPort2 : Number(url.port);
  return new Promise((resolve) => {
    const s = useTls ? tlsConnect({ host: url.hostname, port, servername: url.hostname }) : netConnect({ host: url.hostname, port });
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
      let bodyText = raw.slice(headerEnd + 4);
      if (head.toLowerCase().includes("transfer-encoding: chunked")) {
        const parts: string[] = [];
        let cursor = 0;
        for (;;) {
          const lineEnd = bodyText.indexOf("\r\n", cursor);
          if (lineEnd < 0) break;
          const size = Number.parseInt(bodyText.slice(cursor, lineEnd), 16);
          if (Number.isNaN(size) || size === 0) break;
          parts.push(bodyText.slice(lineEnd + 2, lineEnd + 2 + size));
          cursor = lineEnd + 2 + size + 2;
        }
        bodyText = parts.join("");
      }
      resolve({ status, body: bodyText });
    });
  });
}
