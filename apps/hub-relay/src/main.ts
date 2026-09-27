// relay 主服务（DESIGN §1.5）：WSS/HTTP 接入、token 鉴权（from==认证身份）、
// 路由转发（同节点直投 / 跨节点 publish）、撤销拉黑（deviceId 键 + 即时广播）、
// 单活连接（新连接顶旧）、帧速率防线。
// 传输层用 node:http upgrade + 自实现 WebSocket 最小服务端帧协议（握手/文本帧/
// ping/pong/close）——零三方依赖；TLS 由 LB/反代终结（runbook）。
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { acceptKey, WebSocketFrameWriter } from "@x-harness/remote-protocol";
import { WebSocketFrameReader } from "@x-harness/remote-protocol";
import { createMemoryStore } from "./store-memory.ts";
import { createRedisStore } from "./store-redis.ts";
import type { RouteStore } from "./store-memory.ts";
import { decodeEnvelope, encodeEnvelope } from "@x-harness/remote-protocol";
import { enrollTranscript, issueToken, newJti, verifyToken, type TokenClaims } from "./auth.ts";
import { ENVELOPE_MAX_BYTES, FRAME_RATE_BURST, MAX_CONNECTIONS, PAIRING_TICKET_TTL_SECONDS, PING_INTERVAL_MS, PONG_TIMEOUT_MS, TOKEN_TTL_SECONDS } from "./limits.ts";
import { verifyBytes } from "@x-harness/remote-protocol";

export interface RelayOptions {
  port: number;
  host: string;
  /** per-deployment HS256 秘密（env 供给；缺省拒绝启动——fail-closed） */
  tokenSecret: string;
  /** 部署签名钥（可选注入；缺省从 tokenSecret 派生——确定性，指纹可预计算钉存） */
  signingSecret?: string;
  signingPub?: string;
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
  /** 节点签名公钥（gateway 指纹比对锚；运营者钉存其 sha256） */
  nodeSigningPub: string;
  close(): Promise<void>;
  /** 测试面：直接签发 token（生产 token 由 gateway 经 enroll/refresh 线获得） */
  issueTestToken(claims: Omit<TokenClaims, "iat" | "exp" | "jti">): string;
  /** 测试面：签发 pairingTicket */
  issuePairingTicket(pairingId: string): string;
}

/** 部署签名钥解析：显式注入优先；缺省 tokenSecret 派生（HKDF 域分离——确定性可预计算） */
function nodeCryptoImports(): typeof import("@x-harness/remote-protocol") {
  // 顶部静态导入会与 routes 循环引用冲突——经 require 局部取（Bun/Node 同步可用）
  return require("@x-harness/remote-protocol");
}

function deriveNodeSigningKeys(options: RelayOptions): { secret: string; pub: string } {
  if (options.signingSecret !== undefined && options.signingPub !== undefined) {
    return { secret: options.signingSecret, pub: options.signingPub };
  }
  const { hkdf, fromSecretSigning } = nodeCryptoImports();
  const seed = Buffer.from(hkdf({ ikm: new TextEncoder().encode(options.tokenSecret), salt: new Uint8Array(32), info: "xh-relay/node-signing/v1", length: 32 })).toString("hex");
  return fromSecretSigning(seed);
}

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  if (options.tokenSecret.length < 16) {
    throw new Error("relay: token secret must be >= 16 bytes");
  }
  const nodeId = options.nodeId ?? randomUUID();
  const nodeSigning = deriveNodeSigningKeys(options);
  const nodeSigningPub = nodeSigning.pub;
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
      if (parsed.kind === "cross" && parsed.line !== undefined) {
        // 按 to 前缀分派（D2）：dev_ → 设备连接；gw_ → 网关投递口
        const env = JSON.parse(parsed.line) as { to?: string };
        if (typeof env.to === "string" && env.to.startsWith("dev_")) {
          conns.get(`device:${env.to.slice(4)}`)?.send(parsed.line);
          return;
        }
        if (parsed.toInstallation !== undefined) {
          localDeliver.get(parsed.toInstallation)?.(parsed.line);
        }
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
    if (req.method === "GET" && req.url === "/api/node-key") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signingPub: nodeSigningPub, nodeId }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/pairing-ticket") {
      void handlePairingTicket(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/enroll/challenge") {
      void handleEnrollChallenge(req, res);
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

  /** 鉴权与限载判定：返回 claims（pairingTicket 场景为合成 claims，subject=pairingId——单活键按配对面隔离） */
  function authorizeUpgrade(url: string, authHeader: string): TokenClaims | null {
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : new URL(url, "http://x").searchParams.get("token");
    if (token === null || token.length === 0) return null;
    const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
    // pairing kind 仅配对面路径（D3：任意路径不得当 pairing 数据面连接）
    if (claims !== null) {
      if (claims.kind === "pairing") return url.startsWith("/pairing") ? claims : null;
      return claims;
    }
    // pairing kind 仅配对面路径；subject=pairingId（单活键按配对面隔离——D3）
    if (url.startsWith("/pairing")) {
      const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
      if (claims !== null && claims.kind === "pairing") return claims;
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
      // 连接路径只更新连接节点——绝不写 gatewayKeyPub（enroll 的 TOFU 钉存不可被覆盖）
      const existing = await store.getInstallation(effectiveClaims.subject);
      await store.putInstallation(effectiveClaims.subject, { gatewayKeyPub: existing?.gatewayKeyPub ?? "", nodeId });
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
      // 定时器无条件清（单活顶替后旧连接的 timer 泄漏修复）；表项只清当前代
      clearInterval(pingTimer);
      if (conns.get(connKey) !== conn) return;
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

  /** L3 地址前缀（token kind → 地址域） */
  function addressPrefixOf(kind: string): string {
    if (kind === "gateway") return "gw_";
    if (kind === "pairing") return "pairing_";
    return "dev_";
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
    // 帧字节门（E5——16MiB；超限断连防 64MiB 帧洪泛）
    if (Buffer.byteLength(line) > ENVELOPE_MAX_BYTES) {
      from.close();
      return;
    }
    if (line.length === 0) return;
    const env = decodeEnvelope(line);
    if (env === null) return;
    // 身份绑定：from 必须等于认证身份（S1''——禁自声明）
    // L3 地址恒带前缀（dev_/gw_/pairing_）；token subject 是裸 id——此处重组比对
    const prefix = addressPrefixOf(from.claims.kind);
    const expectFrom = `${prefix}${from.claims.subject}`;
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
    if (to.startsWith("pairing_")) {
      // 配对面：投给持 pairingTicket 的连接（单活键 pairing:<pairingId>）
      const target = conns.get(`pairing:${to.slice("pairing_".length)}`);
      if (target !== undefined) {
        target.send(line);
        return;
      }
      from.send(errorLine("no-route"));
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
    return encodeEnvelope({ v: 1, from: "relay", to: "caller", payload: Buffer.from(JSON.stringify({ code })).toString("base64"), nonce: Buffer.alloc(17).toString("base64") });
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  /** enroll 第一步：拿 nodeId+nonce（转录绑定 relay 节点与新鲜性） */
  async function handleEnrollChallenge(_req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ nodeId, nonce: newJti() }));
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
      // 基线空串（连接路径只更 nodeId 时）也视作未钉存；已钉存且不同 → 409（安全 H3 fail-closed）
      if (existing !== null && existing.gatewayKeyPub.length > 0 && existing.gatewayKeyPub !== body.gatewayKeyPub) {
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

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => resolve());
  });

  return {
    server,
    store,
    nodeId,
    nodeSigningPub,
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
