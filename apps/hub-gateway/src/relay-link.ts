import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";
import { WebSocketFrameReader, WebSocketFrameWriter, signBytes } from "@x-harness/remote-protocol";
import { enrollTranscript } from "../../hub-relay/src/auth.ts";

// TLS 拨号选项：hostname 是 IP 时省略 servername（Node/Bun 均拒 IP 型 SNI——
// ERR_INVALID_ARG_VALUE；IP 证书走 SAN-IP 校验，不需要 SNI）。
function tlsOptions(hostname: string, port: number): { host: string; port: number; servername?: string } {
  const isIp = /^[0-9.]+$/.test(hostname) || hostname.includes(":");
  return isIp ? { host: hostname, port } : { host: hostname, port, servername: hostname };
}

export interface RelayLinkOptions {
  relayUrl: string;
  installationId: string;
  relayInstallationId?: string;
  gatewaySigningSecret: string;
  gatewaySigningPub: string;
  useTls: boolean;
  expectedRelayFingerprint?: string;
  onFrame(line: string): void;
  onStatus(status: "connected" | "disconnected", detail: string): void;
  log(message: string): void;
}

export interface RelayLinkHandle {
  send(line: string): boolean;
  connected(): boolean;
  stop(): void;
  enrollOnce(): Promise<{ token: string } | null>;
  requestPairingTicket(pairingId: string): Promise<string | null>;
  requestDeviceToken(deviceId: string, deviceLongTermPub?: string): Promise<string | null>;
  revokeDevice(deviceId: string): Promise<boolean>;
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
        void verifyRelayFingerprint();
        const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
        if (rest.length > 0) reader.push(rest);
        return;
      }
      reader.push(chunk);
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
    const s = options.useTls ? tlsConnect(tlsOptions(url.hostname, port)) : netConnect({ host: url.hostname, port });
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

  async function verifyRelayFingerprint(): Promise<void> {
    const expected = options.expectedRelayFingerprint ?? "";
    if (expected.length === 0) return;
    const reply = await httpGet(url, { useTls: options.useTls, path: "/api/node-key" });
    if (reply === null || reply.status !== 200) {
      options.log("node-key fetch failed — disconnecting");
      socket?.destroy();
      return;
    }
    const parsed = JSON.parse(reply.body) as { signingPub?: string };
    if (typeof parsed.signingPub !== "string") {
      socket?.destroy();
      return;
    }
    const { createHash } = await import("node:crypto");
    const actual = createHash("sha256").update(Buffer.from(parsed.signingPub, "hex")).digest("hex");
    if (actual !== expected) {
      options.log(`relay fingerprint mismatch (expected ${expected.slice(0, 8)}…, got ${actual.slice(0, 8)}…) — disconnecting`);
      socket?.destroy();
    }
  }

  // HTTP API 的 401 = gateway token 过期（15min TTL）——re-enroll 后重试一次。
  // 只有 WS 握手 401 触发续期的话，长连接闲置超过 TTL 后配对/设备令牌全部假死
  // （症状：pairing-ticket failed: 401 反复出现，直到连接意外断开才自愈）。
  async function postWithEnrollRetry(path: string, body: string): Promise<{ status: number; body: string } | null> {
    if (gatewayToken === null) {
      const enrolled = await enrollOnce();
      if (enrolled === null) return null;
    }
    const first = await httpPost(url, { useTls: options.useTls, path, body, token: gatewayToken ?? undefined });
    if (first !== null && first.status !== 401) return first;
    options.log(`relay api ${path} unauthorized — re-enrolling`);
    gatewayToken = null;
    const enrolled = await enrollOnce();
    if (enrolled === null) return first;
    return httpPost(url, { useTls: options.useTls, path, body, token: enrolled.token });
  }

  async function revokeDevice(deviceId: string): Promise<boolean> {
    if (gatewayToken === null) return false;
    const reply = await postWithEnrollRetry("/api/revoke", JSON.stringify({ deviceId }));
    return reply !== null && reply.status === 200;
  }

  async function requestDeviceToken(deviceId: string, deviceLongTermPub?: string): Promise<string | null> {
    if (gatewayToken === null) {
      const enrolled = await enrollOnce();
      if (enrolled === null) return null;
    }
    const body = JSON.stringify({ deviceId, ...(deviceLongTermPub !== undefined && deviceLongTermPub.length > 0 ? { deviceLongTermPub } : {}) });
    const reply = await postWithEnrollRetry("/api/device-token", body);
    if (reply === null || reply.status !== 200) {
      options.log(`device-token failed: ${String(reply?.status)}`);
      return null;
    }
    const parsed = JSON.parse(reply.body) as { token?: string };
    return typeof parsed.token === "string" ? parsed.token : null;
  }

  async function requestPairingTicket(pairingId: string): Promise<string | null> {
    if (gatewayToken === null) {
      const enrolled = await enrollOnce();
      if (enrolled === null) return null;
    }
    const body = JSON.stringify({ pairingId });
    const reply = await postWithEnrollRetry("/api/pairing-ticket", body);
    if (reply === null || reply.status !== 200) {
      options.log(`pairing-ticket failed: ${String(reply?.status)}`);
      return null;
    }
    const parsed = JSON.parse(reply.body) as { ticket?: string };
    return typeof parsed.ticket === "string" ? parsed.ticket : null;
  }

  function enrollOnce(): Promise<{ token: string } | null> {
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
    requestPairingTicket,
    requestDeviceToken,
    revokeDevice,
  };
}

async function httpPost(url: URL, spec: { useTls: boolean; path: string; body: string; token?: string }): Promise<{ status: number; body: string } | null> {
  const { useTls, path, body, token } = spec;
  const defaultPort2 = useTls ? 443 : 80;
  const port = url.port === "" ? defaultPort2 : Number(url.port);
  return new Promise((resolve) => {
    const s = useTls ? tlsConnect(tlsOptions(url.hostname, port)) : netConnect({ host: url.hostname, port });
    const fail = (): void => resolve(null);
    s.once("error", fail);
    s.on("connect", () => {
      const auth = token !== undefined ? `Authorization: Bearer ${token}\r\n` : "";
      s.write(`POST ${path} HTTP/1.1\r\nHost: ${url.host}\r\n${auth}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let raw = "";
    s.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    s.on("close", () => {
      resolve(decodeHttpResponse(raw));
    });
  });
}

function decodeHttpResponse(raw: string): { status: number; body: string } {
  const statusLine = raw.split("\r\n")[0] ?? "";
  const status = Number(statusLine.split(" ")[1] ?? 0);
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) return { status, body: "" };
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
  return { status, body: bodyText };
}

async function httpGet(url: URL, spec: { useTls: boolean; path: string }): Promise<{ status: number; body: string } | null> {
  const { useTls, path } = spec;
  const defaultPort = useTls ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  return new Promise((resolve) => {
    const s = useTls ? tlsConnect(tlsOptions(url.hostname, port)) : netConnect({ host: url.hostname, port });
    const fail = (): void => resolve(null);
    s.once("error", fail);
    s.on("connect", () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    s.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    s.on("close", () => {
      resolve(decodeHttpResponse(raw));
    });
  });
}
