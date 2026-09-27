// relay 主服务（DESIGN §1.5）：WSS/HTTP 接入、token 鉴权（from==认证身份）、
// 路由转发（同节点直投 / 跨节点 publish）、撤销拉黑（deviceId 键 + 即时广播）、
// 单活连接（新连接顶旧）、帧速率防线。
// 传输层用 node:http upgrade + 自实现 WebSocket 最小服务端帧协议（握手/文本帧/
// ping/pong/close）——零三方依赖；TLS 由 LB/反代终结（runbook）。
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { acceptKey, WebSocketFrameWriter } from "./ws-writer.ts";
import { WebSocketFrameReader } from "./ws-reader.ts";
import { createMemoryStore } from "./store-memory.ts";
import { createRedisStore } from "./store-redis.ts";
import type { RouteStore } from "./store-memory.ts";
import { decodeEnvelope, encodeEnvelope } from "@x-harness/remote-protocol";
import { enrollTranscript, issueToken, newJti, verifyToken, type TokenClaims } from "./auth.ts";
import { FRAME_RATE_BURST, MAX_CONNECTIONS, PAIRING_TICKET_TTL_SECONDS, PING_INTERVAL_MS, PONG_TIMEOUT_MS, TOKEN_TTL_SECONDS } from "./limits.ts";
import { verifyBytes } from "@x-harness/remote-protocol";

export interface RelayOptions {
  port: number;
  host: string;
  /** per-deployment HS256 秘密（env 供给；缺省拒绝启动——fail-closed） */
  tokenSecret: string;
  /** 单实例显式声明（允许内存存储） */
  singleInstance: boolean;
  redis?: { host: string; port: number; password?: string };
  nodeId?: string;
}

interface Conn {
  id: string;
  claims: TokenClaims;
  send: (line: string) => void;
  close: () => void;
  lastPong: number;
  frames: number[]; // 滑动窗口时间戳（帧速率）
}

export interface RelayHandle {
  server: Server;
  store: RouteStore;
  nodeId: string;
  close(): Promise<void>;
  /** 测试面：直接签发 token（生产 token 由 gateway 经 enroll/refresh 线获得） */
  issueTestToken(claims: Omit<TokenClaims, "iat" | "exp" | "jti">): string;
  /** 测试面：签发 pairingTicket */
  issuePairingTicket(pairingId: string): string;
}

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  if (options.tokenSecret.length < 16) {
    throw new Error("relay: token secret must be >= 16 bytes");
  }
  const nodeId = options.nodeId ?? randomUUID();
  let store: RouteStore;
  if (options.redis !== undefined) {
    store = createRedisStore({ ...options.redis, nodeId });
  } else if (options.singleInstance) {
    store = createMemoryStore(nodeId);
  } else {
    // 多实例配置下无共享存储 = fail-fast（DESIGN §1.5：禁止架构决策藏进默认值）
    throw new Error("relay: shared store required for multi-instance (pass --redis or --single-instance)");
  }

  const conns = new Map<string, Conn>(); // key: `${kind}:${subject}`（单活顶替）
  const byConnId = new Map<string, Conn>();
  const localDeliver = new Map<string, (line: string) => void>(); // installationId → 直投口

  // 跨节点与撤销广播消费
  await store.subscribeCrossNode((_installationId, message) => {
    try {
      const parsed = JSON.parse(message) as { kind?: string; deviceId?: string; line?: string; toInstallation?: string };
      if (parsed.kind === "revoke" && parsed.deviceId !== undefined) {
        const conn = conns.get(`device:${parsed.deviceId}`);
        conn?.close();
        return;
      }
      if (parsed.kind === "cross" && parsed.toInstallation !== undefined && parsed.line !== undefined) {
        localDeliver.get(parsed.toInstallation)?.(parsed.line);
      }
    } catch {
      // 广播载荷垃圾——忽略（降级不崩）
    }
  });

  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, nodeId, conns: byConnId.size }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/pairing-ticket") {
      void handlePairingTicket(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/enroll") {
      void handleEnroll(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/revoke") {
      void handleRevoke(req, res);
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  /** 鉴权与限载判定：返回 claims（pairingTicket 场景为合成 claims）或 null（拒连） */
  function authorizeUpgrade(url: string, authHeader: string): TokenClaims | null {
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : new URL(url, "http://x").searchParams.get("token");
    if (token === null || token.length === 0) return null;
    const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
    if (claims !== null) return claims;
    if (url.startsWith("/pairing") && verifyPairingTicket(token)) {
      return { kind: "pairing", subject: "pairing", iat: 0, exp: 0, jti: "" };
    }
    return null;
  }

  async function handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): Promise<void> {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      socket.destroy();
      return;
    }
    const claims = authorizeUpgrade(req.url ?? "", req.headers.authorization ?? "");
    if (claims === null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (byConnId.size >= MAX_CONNECTIONS) {
      socket.write("HTTP/1.1 503 Overloaded\r\n\r\n");
      socket.destroy();
      return;
    }
    await establishConnection({ claims, key, socket, head });
  }

  /** 连接装配：握手回执、单活顶替、路由登记、ping/pong、数据泵 */
  async function establishConnection(spec: { claims: TokenClaims; key: string; socket: import("node:stream").Duplex; head: Buffer }): Promise<void> {
    const { claims, key, socket, head } = spec;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const reader = new WebSocketFrameReader();
    const writer = new WebSocketFrameWriter(socket);
    if (head.length > 0) reader.push(head);
    const connId = randomUUID();
    const effectiveClaims = claims;
    const connKey = `${effectiveClaims.kind}:${effectiveClaims.subject}`;
    const conn: Conn = {
      id: connId,
      claims: effectiveClaims,
      send: (line) => writer.writeText(line),
      close: () => {
        writer.writeClose();
        socket.destroy();
      },
      lastPong: Date.now(),
      frames: [],
    };
    const old = conns.get(connKey);
    if (old !== undefined) {
      old.close();
      byConnId.delete(old.id);
    }
    conns.set(connKey, conn);
    byConnId.set(connId, conn);
    if (effectiveClaims.kind === "gateway") {
      localDeliver.set(effectiveClaims.subject, (line) => conn.send(line));
      await store.putInstallation(effectiveClaims.subject, { gatewayKeyPub: "", nodeId });
    } else if (effectiveClaims.kind === "device") {
      const installationId = effectiveClaims.installationId ?? "";
      if (installationId.length > 0) {
        await store.putDevice(effectiveClaims.subject, { installationId, nodeId });
      }
    }
    const pingTimer = setInterval(() => {
      if (Date.now() - conn.lastPong > PONG_TIMEOUT_MS) {
        teardown();
        return;
      }
      writer.writePing();
    }, PING_INTERVAL_MS);
    function teardown(): void {
      clearInterval(pingTimer);
      conns.delete(connKey);
      byConnId.delete(connId);
      if (effectiveClaims.kind === "gateway") localDeliver.delete(effectiveClaims.subject);
      socket.destroy();
    }
    socket.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      for (const frame of reader.drainTextFrames()) {
        void handleLine(conn, frame);
      }
      if (reader.error !== null) teardown();
    });
    socket.on("close", teardown);
    socket.on("error", teardown);
    reader.onNonText = () => {
      conn.lastPong = Date.now();
    };
  }

  async function handleLine(from: Conn, line: string): Promise<void> {
    // 帧速率防线（滑动窗口）
    const now = Date.now();
    from.frames = from.frames.filter((t) => now - t < 1000);
    if (from.frames.length >= FRAME_RATE_BURST) {
      from.close();
      return;
    }
    from.frames.push(now);
    if (line.length === 0) return;
    const env = decodeEnvelope(line);
    if (env === null) return;
    // 身份绑定：from 必须等于认证身份（S1''——禁自声明）
    // L3 地址恒带前缀（dev_/gw_）；token subject 是裸 id——此处重组比对
    const expectFrom = from.claims.kind === "gateway" ? `gw_${from.claims.subject}` : `dev_${from.claims.subject}`;
    if (env.from !== expectFrom) return;
    void routeFrame(from, env.to, line);
  }

  async function routeFrame(from: Conn, to: string, line: string): Promise<void> {
    // L3 地址约定（线格式钉死）：设备地址 = `dev_<deviceId>`（deviceId 不含前缀）、
    // 网关地址 = `gw_<installationId>`；路由键 = 去前缀后的裸 id（与 token subject 同域）。
    if (to.startsWith("dev_")) {
      const deviceId = to.slice(4);
      if (await store.isRevoked(deviceId)) {
        from.send(errorLine("no-route"));
        return;
      }
      const target = conns.get(`device:${deviceId}`);
      if (target !== undefined) {
        target.send(line);
        return;
      }
      const routed = await store.getDevice(deviceId);
      if (routed === null) {
        from.send(errorLine("no-route"));
        return;
      }
      await store.publishCrossNode(routed.installationId, JSON.stringify({ kind: "cross", toInstallation: routed.installationId, line }));
      return;
    }
    if (to.startsWith("gw_")) {
      const installationId = to.slice(3);
      const local = localDeliver.get(installationId);
      if (local !== undefined) {
        local(line);
        return;
      }
      const routed = await store.getInstallation(installationId);
      if (routed === null) {
        from.send(errorLine("no-route"));
        return;
      }
      await store.publishCrossNode(installationId, JSON.stringify({ kind: "cross", toInstallation: installationId, line }));
      return;
    }
    from.send(errorLine("no-route"));
  }

  function errorLine(code: string): string {
    return encodeEnvelope({ v: 1, from: "relay", to: "caller", payload: Buffer.from(JSON.stringify({ code })).toString("base64") });
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handleEnroll(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const body = JSON.parse(await readBody(req)) as { installationId?: string; gatewayKeyPub?: string; sig?: string; nonce?: string };
      if (typeof body.installationId !== "string" || typeof body.gatewayKeyPub !== "string" || typeof body.sig !== "string" || typeof body.nonce !== "string") {
        res.writeHead(400).end();
        return;
      }
      const transcript = enrollTranscript({ installationId: body.installationId, gatewayKeyPub: body.gatewayKeyPub, nodeId, nonce: body.nonce });
      if (!verifyBytes(body.gatewayKeyPub, new TextEncoder().encode(transcript), body.sig)) {
        res.writeHead(401).end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      const existing = await store.getInstallation(body.installationId);
      if (existing !== null && existing.gatewayKeyPub !== "" && existing.gatewayKeyPub !== body.gatewayKeyPub) {
        // enrollment 冲突：fail-closed 拒绝 + 告警（安全 H3）
        res.writeHead(409).end(JSON.stringify({ error: "installation key conflict" }));
        return;
      }
      await store.putInstallation(body.installationId, { gatewayKeyPub: body.gatewayKeyPub, nodeId });
      const now = Math.floor(Date.now() / 1000);
      const token = issueToken(options.tokenSecret, { kind: "gateway", subject: body.installationId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token, expiresIn: TOKEN_TTL_SECONDS }));
    } catch {
      res.writeHead(400).end();
    }
  }

  async function handleRevoke(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
      if (claims === null || claims.kind !== "gateway") {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse(await readBody(req)) as { deviceId?: string };
      if (typeof body.deviceId !== "string" || body.deviceId.length === 0) {
        res.writeHead(400).end();
        return;
      }
      await store.revoke(body.deviceId);
      await store.removeDevice(body.deviceId);
      res.writeHead(200).end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400).end();
    }
  }

  async function handlePairingTicket(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
      if (claims === null || claims.kind !== "gateway") {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse(await readBody(req)) as { pairingId?: string };
      if (typeof body.pairingId !== "string" || body.pairingId.length === 0) {
        res.writeHead(400).end();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const ticket = issueToken(options.tokenSecret, { kind: "pairing", subject: body.pairingId, iat: now, exp: now + PAIRING_TICKET_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ticket }));
    } catch {
      res.writeHead(400).end();
    }
  }

  // pairingTicket 验证（upgrade 路径用）
  function verifyPairingTicket(token: string): boolean {
    const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
    return claims !== null && claims.kind === "pairing";
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => resolve());
  });

  return {
    server,
    store,
    nodeId,
    async close() {
      for (const conn of byConnId.values()) conn.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    issueTestToken(claims) {
      const now = Math.floor(Date.now() / 1000);
      return issueToken(options.tokenSecret, { ...claims, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
    },
    issuePairingTicket(pairingId) {
      const now = Math.floor(Date.now() / 1000);
      return issueToken(options.tokenSecret, { kind: "pairing", subject: pairingId, iat: now, exp: now + PAIRING_TICKET_TTL_SECONDS, jti: newJti() });
    },
  };
}
