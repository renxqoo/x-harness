import type { IncomingMessage } from "node:http";
import { enrollTranscript, issueToken, newJti, verifyToken } from "./auth.ts";
import { verifyBytes } from "@x-harness/remote-protocol";
import { PAIRING_TICKET_TTL_SECONDS, TOKEN_TTL_SECONDS } from "./limits.ts";

export interface AdminHttpDeps {
  nodeId: string;
  tokenSecret: string;
  store: {
    getInstallation(id: string): Promise<{ gatewayKeyPub: string; nodeId: string } | null>;
    putInstallation(id: string, row: { gatewayKeyPub: string; nodeId: string }): Promise<void>;
    getDevice(id: string): Promise<{ installationId: string; nodeId: string } | null>;
    putDevice(id: string, row: { installationId: string; nodeId: string }): Promise<void>;
    revoke(id: string): Promise<void>;
    removeDevice(id: string): Promise<void>;
    getDeviceKey(id: string): Promise<string | null>;
    putDeviceKey(id: string, pub: string): Promise<void>;
    deleteDeviceKey(id: string): Promise<void>;
  };
}

export function createAdminHttpHandlers(deps: AdminHttpDeps) {
  const { nodeId, tokenSecret, store } = deps;
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
      const token = issueToken(tokenSecret, { kind: "gateway", subject: body.installationId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token, expiresIn: TOKEN_TTL_SECONDS }));
    } catch {
      res.writeHead(400).end();
    }
  }

  async function handleRevoke(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const claims = verifyToken(tokenSecret, token, Math.floor(Date.now() / 1000));
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
      const claims = verifyToken(tokenSecret, token, Math.floor(Date.now() / 1000));
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
      const deviceToken = issueToken(tokenSecret, { kind: "device", subject: body.deviceId, installationId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
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
      const deviceToken = issueToken(tokenSecret, { kind: "device", subject: body.deviceId, installationId: routed.installationId, iat: now, exp: now + TOKEN_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: deviceToken, expiresIn: TOKEN_TTL_SECONDS, nodeId }));
    } catch {
      res.writeHead(400).end();
    }
  }

  async function handlePairingTicket(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const claims = verifyToken(tokenSecret, token, Math.floor(Date.now() / 1000));
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
      const ticket = issueToken(tokenSecret, { kind: "pairing", subject: body.pairingId, iat: now, exp: now + PAIRING_TICKET_TTL_SECONDS, jti: newJti() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ticket }));
    } catch {
      res.writeHead(400).end();
    }
  }

  return { readBody, handleEnrollChallenge, handleEnroll, handleRevoke, handleDeviceToken, handleDeviceTokenRefresh, handlePairingTicket };
}
