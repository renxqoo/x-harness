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
  tokenSecret: string;
  signingSecret?: string;
  signingPub?: string;
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

  const httpRoutes: Array<{ method: string; path: string; handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void> }> = [
    {
      method: "GET",
      path: "/api/node-key",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ signingPub: nodeSigningPub, nodeId }));
      },
    },
    { method: "POST", path: "/api/pairing-ticket", handler: (req, res) => void handlePairingTicket(req, res) },
    { method: "POST", path: "/api/enroll/challenge", handler: (req, res) => void handleEnrollChallenge(req, res) },
    { method: "POST", path: "/api/enroll", handler: (req, res) => void handleEnroll(req, res) },
    { method: "POST", path: "/api/revoke", handler: (req, res) => void handleRevoke(req, res) },
    { method: "POST", path: "/api/device-token", handler: (req, res) => void handleDeviceToken(req, res) },
    { method: "POST", path: "/api/device-token/refresh", handler: (req, res) => void handleDeviceTokenRefresh(req, res) },
  ];

  async function dispatchHttp(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, nodeId, conns: byConnId.size }));
      return;
    }
    const route = httpRoutes.find((candidate) => candidate.method === req.method && candidate.path === req.url);
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

  function errorLine(code: string): string {
    return encodeEnvelope({ v: 1, from: "relay", to: "caller", payload: Buffer.from(JSON.stringify({ code })).toString("base64"), nonce: Buffer.alloc(17).toString("base64") });
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

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
      const routed = await store.getDevice(body.deviceId);
      if (routed === null || routed.installationId !== claims.subject) {
        res.writeHead(409).end(JSON.stringify({ error: "device not bound to this installation" }));
        return;
      }
      await store.revoke(body.deviceId);
      await store.removeDevice(body.deviceId);
      await store.deleteDeviceKey(body.deviceId);

      res.writeHead(200).end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400).end();
    }
  }

  async function handleDeviceToken(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const claims = verifyToken(options.tokenSecret, token, Math.floor(Date.now() / 1000));
      if (claims === null || claims.kind !== "gateway") {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse(await readBody(req)) as { deviceId?: string; deviceLongTermPub?: string };
      if (typeof body.deviceId !== "string" || !/^d_[0-9a-f]{16}$/.test(body.deviceId)) {
        res.writeHead(400).end(JSON.stringify({ error: "bad deviceId format" }));
        return;
      }
      if (typeof body.deviceLongTermPub === "string" && body.deviceLongTermPub.length > 0) {
        const pinned = await store.getDeviceKey(body.deviceId);
        if (pinned === null) await store.putDeviceKey(body.deviceId, body.deviceLongTermPub);
        else if (pinned !== body.deviceLongTermPub) {
          res.writeHead(409).end(JSON.stringify({ error: "device key conflict" }));
          return;
        }
      }
      const installationId = claims.subject;
      const routed = await store.getDevice(body.deviceId);
      if (routed !== null && routed.installationId !== installationId) {
        res.writeHead(409).end(JSON.stringify({ error: "device bound to another installation" }));
        return;
      }
      if (routed === null) {
        await store.putDevice(body.deviceId, { installationId, nodeId });
      }
      const now = Math.floor(Date.now() / 1000);
      const deviceToken = issueToken(options.tokenSecret, { kind: "device", subject: body.deviceId, installationId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: deviceToken, expiresIn: TOKEN_TTL_SECONDS }));
    } catch {
      res.writeHead(400).end();
    }
  }

  async function handleDeviceTokenRefresh(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const body = JSON.parse(await readBody(req)) as { deviceId?: string; nonce?: string; sig?: string };
      if (typeof body.deviceId !== "string" || !/^d_[0-9a-f]{16}$/.test(body.deviceId) || typeof body.nonce !== "string" || typeof body.sig !== "string") {
        res.writeHead(400).end();
        return;
      }
      const pinnedKey = await store.getDeviceKey(body.deviceId);
      if (pinnedKey === null) {
        res.writeHead(404).end(JSON.stringify({ error: "device key not pinned" }));
        return;
      }
      const transcript = `device-refresh|${body.deviceId}|${nodeId}|${body.nonce}`;
      if (!verifyBytes(pinnedKey, new TextEncoder().encode(transcript), body.sig)) {
        res.writeHead(401).end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      const routed = await store.getDevice(body.deviceId);
      if (routed === null) {
        res.writeHead(404).end(JSON.stringify({ error: "device not registered" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const deviceToken = issueToken(options.tokenSecret, { kind: "device", subject: body.deviceId, installationId: routed.installationId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: deviceToken, expiresIn: TOKEN_TTL_SECONDS, nodeId }));
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
