import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { acceptKey, WebSocketFrameWriter } from "@x-harness/remote-protocol";
import { WebSocketFrameReader } from "@x-harness/remote-protocol";
import { createMemoryStore } from "./store-memory.ts";
import { createAdminHttpHandlers } from "./admin-http.ts";
import { createRedisStore } from "./store-redis.ts";
import type { RouteStore } from "./store-memory.ts";
import { decodeEnvelope, encodeEnvelope } from "@x-harness/remote-protocol";
import { enrollTranscript, issueToken, newJti, verifyToken, type TokenClaims } from "./auth.ts";
import { ENVELOPE_MAX_BYTES, FRAME_RATE_BURST, MAX_CONNECTIONS, PAIRING_TICKET_TTL_SECONDS, PING_INTERVAL_MS, PONG_TIMEOUT_MS, TOKEN_TTL_SECONDS } from "./limits.ts";
import { verifyBytes } from "@x-harness/remote-protocol";

export interface RelayOptions {
  port: number;
  host: string;
  tokenSecret: string;
  signingSecret?: string;
  signingPub?: string;
  singleInstance: boolean;
  redis?: { host: string; port: number; password?: string };
  nodeId?: string;
  /** 网关描述回调（embedded 形态：6 位码发现端点按码反查网关接入信息）。 */
  gatewayOfCode?: (code: string) => { relayUrl: string; installationId: string; gatewayKeyFingerprint: string; pairingId: string; pairingTicket: string } | null | Promise<{ relayUrl: string; installationId: string; gatewayKeyFingerprint: string; pairingId: string; pairingTicket: string } | null>;
}

interface Conn {
  id: string;
  claims: TokenClaims;
  send: (line: string) => void;
  close: () => void;
  lastPong: number;
  frames: number[];
}

export interface RelayHandle {
  server: Server;
  store: RouteStore;
  nodeId: string;
  nodeSigningPub: string;
  close(): Promise<void>;
  issueTestToken(claims: Omit<TokenClaims, "iat" | "exp" | "jti">): string;
  issuePairingTicket(pairingId: string): string;
}

function nodeCryptoImports(): typeof import("@x-harness/remote-protocol") {
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
    throw new Error("relay: shared store required for multi-instance (pass --redis or --single-instance)");
  }

  const conns = new Map<string, Conn>();
  const byConnId = new Map<string, Conn>();
  const localDeliver = new Map<string, (line: string) => void>();
  // 6 位码注册表（外部 relay 形态的发现面）：网关经 WS 控制帧把活跃配对会话的码
  // 注册进来；/api/discover 查表——替代进程内 gatewayOfCode 回调（那只对嵌入式
  // relay 可用，外部 relay 是独立进程够不到函数引用）。安全约束：每网关码数上限
  // + exp 封顶 + 断连即清 + discover 只回在线网关的码——开放 enroll 面上，恶意
  // 网关试图批量占满码空间把配对顶号到自己名下的攻击面被压到无意义。
  const PAIRING_CODES_PER_GATEWAY_MAX = 16;
  const PAIRING_CODE_TTL_MAX_SECONDS = 600;
  // 码空间全局上限：6 位码只有 100 万空间，且注册面开放（任意已配对网关都能注册）。
  // 单网关条数上限挡不住「针对性顶号」——攻击者只需反复注册受害方当前码。
  const PAIRING_CODES_TOTAL_MAX = 4096;
  const pairingCodes = new Map<string, { pairingId: string; installationId: string; gatewayKeyFingerprint: string; exp: number }>();

  await store.subscribeCrossNode((_installationId, message) => {
    try {
      const parsed = JSON.parse(message) as { kind?: string; deviceId?: string; line?: string; toInstallation?: string };
      if (parsed.kind === "revoke" && parsed.deviceId !== undefined) {
        const conn = conns.get(`device:${parsed.deviceId}`);
        conn?.close();
        return;
      }
      if (parsed.kind === "cross" && parsed.line !== undefined) {
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
    }
  });

  const server = createServer((req, res) => {
  void dispatchHttp(req, res);
});

  const adminHttp = createAdminHttpHandlers({ nodeId, tokenSecret: options.tokenSecret, store });
  const httpRoutes: Array<{ method: string; path: string; handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void> }> = [
    {
      method: "GET",
      path: "/api/node-key",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ signingPub: nodeSigningPub, nodeId }));
      },
    },
    { method: "POST", path: "/api/pairing-ticket", handler: (req, res) => void adminHttp.handlePairingTicket(req, res) },
    { method: "POST", path: "/api/enroll/challenge", handler: (req, res) => void adminHttp.handleEnrollChallenge(req, res) },
    { method: "POST", path: "/api/enroll", handler: (req, res) => void adminHttp.handleEnroll(req, res) },
    { method: "POST", path: "/api/revoke", handler: (req, res) => void adminHttp.handleRevoke(req, res) },
    { method: "POST", path: "/api/device-token", handler: (req, res) => void adminHttp.handleDeviceToken(req, res) },
    { method: "POST", path: "/api/device-token/refresh", handler: (req, res) => void adminHttp.handleDeviceTokenRefresh(req, res) },
    {
      method: "GET",
      path: "/api/discover",
      handler: (req, res) => {
        const code = new URL(req.url ?? "/api/discover", "http://x").searchParams.get("code") ?? "";
        // 外部 relay 形态：查网关注册表（仅在线网关的码）；嵌入式形态（同进程回调）仍走 gatewayOfCode。
        const registered = pairingCodes.get(code);
        const hit = registered !== undefined && registered.exp > Math.floor(Date.now() / 1000) && localDeliver.has(registered.installationId)
          ? { relayUrl: "", installationId: registered.installationId, gatewayKeyFingerprint: registered.gatewayKeyFingerprint, pairingId: registered.pairingId, pairingTicket: "" }
          : null;
        void Promise.resolve(hit ?? options.gatewayOfCode?.(code) ?? null).then((resolved) => {
          if (resolved === null) {
            res.writeHead(404).end();
            return;
          }
          const host = req.headers.host ?? "";
          const relayUrl = host.length > 0 && resolved.relayUrl.length === 0 ? `ws://${host}` : resolved.relayUrl;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...resolved, relayUrl }));
        });
      },
    },
  ];

  async function dispatchHttp(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, nodeId, conns: byConnId.size }));
      return;
    }
    const routePath = (req.url ?? "/").split("?")[0] ?? "/";
    const route = httpRoutes.find((candidate) => candidate.method === req.method && candidate.path === routePath);
    if (route !== undefined) {
      await route.handler(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  function authorizeUpgrade(url: string, authHeader: string): TokenClaims | null {
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : new URL(url, "http://x").searchParams.get("token");
    if (token === null || token.length === 0) return null;
    const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
    if (claims !== null) {
      if (claims.kind === "pairing") return url.startsWith("/pairing") ? claims : null;
      return claims;
    }
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
      socket.write("HTTP/1.1 401 Unauthorized\r\nX-Relay-Reason: auth\r\n\r\n");
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
      const existing = await store.getInstallation(effectiveClaims.subject);
      await store.putInstallation(effectiveClaims.subject, { gatewayKeyPub: existing?.gatewayKeyPub ?? "", nodeId });
    } else if (effectiveClaims.kind === "device") {
      if (await store.isRevoked(effectiveClaims.subject)) {
        socket.write(errorLine("revoked"));
        socket.destroy();
        return;
      }
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
      if (conns.get(connKey) !== conn) return;
      conns.delete(connKey);
      byConnId.delete(connId);
      if (effectiveClaims.kind === "gateway") {
        localDeliver.delete(effectiveClaims.subject);
        // 网关断连即清它的码——发现面不回离线网关（描述符指向死路是功能缺陷，
        // 也是占用面）
        for (const [code, row] of pairingCodes) if (row.installationId === effectiveClaims.subject) pairingCodes.delete(code);
      }
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

  function addressPrefixOf(kind: string): string {
    if (kind === "gateway") return "gw_";
    if (kind === "pairing") return "pairing_";
    return "dev_";
  }

  async function handleLine(from: Conn, line: string): Promise<void> {
    const now = Date.now();
    from.frames = from.frames.filter((t) => now - t < 1000);
    if (from.frames.length >= FRAME_RATE_BURST) {
      from.close();
      return;
    }
    from.frames.push(now);
    if (Buffer.byteLength(line) > ENVELOPE_MAX_BYTES) {
      from.close();
      return;
    }
    if (line.length === 0) return;
    const env = decodeEnvelope(line);
    if (env === null) return;
    const prefix = addressPrefixOf(from.claims.kind);
    const expectFrom = `${prefix}${from.claims.subject}`;
    if (env.from !== expectFrom) return;
    void routeFrame(from, env.to, line);
  }

  async function routeFrame(from: Conn, to: string, line: string): Promise<void> {
    // 控制信箱：网关注册/注销 6 位码（外部 relay 形态的发现面；见 pairingCodes）。
    // 鉴权面：仅 gateway kind 的 WS 连接（token 握手已验）；注册归 installationId 所有，
    // 注销只删自己的行；exp 封顶 + 每网关码数封顶。
    if (to === "relay" && from.claims.kind === "gateway") {
      const env = decodeEnvelope(line);
      const payload = env === null ? null : Buffer.from(env.payload, "base64").toString("utf8");
      let message: { register?: { code: string; pairingId: string; gatewayKeyFingerprint: string; exp: number }; unregister?: string } | null = null;
      try { message = payload === null ? null : JSON.parse(payload); } catch { message = null; }
      const nowSec = Math.floor(Date.now() / 1000);
      if (message?.register !== undefined && /^[0-9]{6}$/.test(message.register.code)) {
        const owned = [...pairingCodes.values()].filter((row) => row.installationId === from.claims.subject);
        // 码空间先到先得：已被他人持有则拒绝，不覆盖。set 无条件覆盖会让任一已配对
        // 网关把受害网关的活跃配对码顶到自己名下，discover 随即把该码的 pairingId/
        // gatewayKeyFingerprint 返给受害者设备——设备把配对票据发给攻击者。
        const holder = pairingCodes.get(message.register.code);
        const takeover = holder !== undefined && holder.installationId !== from.claims.subject;
        const ownRenewal = holder !== undefined && holder.installationId === from.claims.subject;
        if (!takeover && owned.length < PAIRING_CODES_PER_GATEWAY_MAX && (ownRenewal || pairingCodes.size < PAIRING_CODES_TOTAL_MAX)) {
          pairingCodes.set(message.register.code, { pairingId: message.register.pairingId, installationId: from.claims.subject, gatewayKeyFingerprint: message.register.gatewayKeyFingerprint, exp: Math.min(message.register.exp, nowSec + PAIRING_CODE_TTL_MAX_SECONDS) });
        }
      } else if (typeof message?.unregister === "string") {
        for (const [code, row] of pairingCodes) if (row.pairingId === message.unregister && row.installationId === from.claims.subject) pairingCodes.delete(code);
      }
      // 过期清扫（顺路；不另起定时器）
      for (const [code, row] of pairingCodes) if (row.exp <= nowSec) pairingCodes.delete(code);
      return;
    }
    if (to.startsWith("dev_")) {
      const deviceId = to.slice(4);
      if (await store.isRevoked(deviceId)) {
        from.send(errorLine("no-route", to));
        return;
      }
      const target = conns.get(`device:${deviceId}`);
      if (target !== undefined) {
        target.send(line);
        return;
      }
      const routed = await store.getDevice(deviceId);
      if (routed === null) {
        from.send(errorLine("no-route", to));
        return;
      }
      await store.publishCrossNode(routed.installationId, JSON.stringify({ kind: "cross", toInstallation: routed.installationId, line }));
      return;
    }
    if (to.startsWith("pairing_")) {
      if (from.claims.kind !== "gateway") {
        from.send(errorLine("forbidden"));
        return;
      }
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

  function errorLine(code: string, to = "caller"): string {
    return encodeEnvelope({ v: 1, from: "relay", to, payload: Buffer.from(JSON.stringify({ code })).toString("base64"), nonce: Buffer.alloc(17).toString("base64") });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
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
