import { describe, expect, it } from "vitest";
import { newBucket, preflightBytes, preflightCmds, processInboundLine, type InboundSpec } from "../inbound.ts";
import { startRelay } from "../../../hub-relay/src/main.ts";
import { startRelayLink } from "../relay-link.ts";
import { loadOrCreateIdentity } from "../identity.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function spec(over: Partial<InboundSpec> = {}): InboundSpec & { commands: string[] } {
  const commands: string[] = [];
  const base: InboundSpec = {
    deviceId: "d1",
    tier: "interact",
    bucket: newBucket(),
    decrypt: (payload) => {
      return { plaintext: Buffer.from(payload, "base64").toString("utf8"), tagFailures: 0 };
    },
    onCommand: (_frame, command) => {
      commands.push(command);
    },
    onUiResponse: () => {},
    onAck: () => {},
    now: () => 1_000_000,
  };
  return { ...base, ...over, commands };
}

function lineWith(body: unknown): string {
  return JSON.stringify({ v: 1, from: "dev_d1", to: "gw_x", payload: Buffer.from(JSON.stringify(body)).toString("base64") });
}

describe("限流桶", () => {
  it("字节桶：突发耗尽拒；时间回填", () => {
    const bucket = newBucket();
    expect(preflightBytes(bucket, 1000, 0)).toBe(true);
    expect(preflightBytes(bucket, DEVICE_BYTES_BURST_DEFAULT(), 1)).toBe(false);
    expect(preflightBytes(bucket, 100, 1000)).toBe(true);
  });

  it("命令桶：同时刻 20 连发过、21 拒；1.2s 后回填", () => {
    const bucket = newBucket();
    for (let i = 0; i < 20; i++) expect(preflightCmds(bucket, 0)).toBe(true);
    expect(preflightCmds(bucket, 0)).toBe(false);
    expect(preflightCmds(bucket, 1200)).toBe(true);
  });
});

function DEVICE_BYTES_BURST_DEFAULT(): number {
  return 8 * 1024 * 1024 + 1;
}

describe("入站管线", () => {
  it("全支路：bad-envelope/bad-frame/ratchet 失败/rate-limited/scope/unknown/ack/ui_response/delivered", () => {
    const s = spec();
    expect(processInboundLine("not-json", s)).toMatchObject({ kind: "bad-envelope" });
    expect(processInboundLine(JSON.stringify({ no: "payload" }), s)).toMatchObject({ kind: "bad-envelope" });
    const failSpec = spec({ decrypt: () => ({ plaintext: null, tagFailures: 3 }) });
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 1, body: {} }), failSpec)).toMatchObject({ kind: "ratchet-failed", tagFailures: 3 });
    const badFrame = spec({ decrypt: () => ({ plaintext: "not-a-frame", tagFailures: 0 }) });
    expect(processInboundLine(lineWith({}), badFrame)).toMatchObject({ kind: "bad-frame" });
    const acks: Array<[string, number]> = [];
    const ackSpec = spec({ onAck: (streamId, upTo) => acks.push([streamId, upTo]) });
    expect(processInboundLine(lineWith({ kind: "ack", streamId: "a", seq: 1, body: { acks: [{ streamId: "ev:t1", upTo: 5 }] } }), ackSpec)).toMatchObject({ kind: "delivered" });
    expect(acks).toEqual([["ev:t1", 5]]);
    const uiSeen: string[] = [];
    const uiSpec = spec({ onUiResponse: (requestId) => uiSeen.push(requestId) });
    expect(processInboundLine(lineWith({ kind: "ui_response", streamId: "u", seq: 1, body: { requestId: "r1", payload: { confirmed: true } } }), uiSpec)).toMatchObject({ kind: "delivered" });
    expect(uiSeen).toEqual(["r1"]);
    expect(processInboundLine(lineWith({ kind: "ui_response", streamId: "u", seq: 2, body: { requestId: "r2" } }), spec({ tier: "read" }))).toMatchObject({ kind: "scope-denied", command: "ui_response" });
    const cmdSpec = spec();
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 1, body: { command: "prompt", id: "m1", args: { threadId: "t" } } }), cmdSpec)).toMatchObject({ kind: "delivered" });
    expect(cmdSpec.commands).toEqual(["prompt"]);
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 2, body: { command: "prompt", id: "m2" } }), spec({ tier: "read" }))).toMatchObject({ kind: "scope-denied", command: "prompt" });
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 3, body: { command: "bash", id: "m3" } }), spec({ tier: "interact" }))).toMatchObject({ kind: "scope-denied", command: "bash" });
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 4, body: { command: "auth/set_api_key", id: "m4" } }), spec({ tier: "full" }))).toMatchObject({ kind: "scope-denied", command: "auth/set_api_key" });
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 5, body: { command: "nope_cmd", id: "m5" } }), cmdSpec)).toMatchObject({ kind: "unknown-command", command: "nope_cmd" });
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 6, body: { command: "gw/status", id: "m6" } }), cmdSpec)).toMatchObject({ kind: "delivered" });
    expect(processInboundLine(lineWith({ kind: "command", streamId: "c", seq: 7, body: { command: "gw/devices/list", id: "m7" } }), cmdSpec)).toMatchObject({ kind: "scope-denied", command: "gw/devices/list" });
  });

  it("字节限流触发：超突发拒", () => {
    const s = spec({ bucket: { bytes: 0, bytesAt: 1_000_000, cmds: 0, cmdsAt: 1_000_000 } });
    const big = lineWith({ kind: "ack", streamId: "a", seq: 1, body: { big: "x".repeat(9 * 1024 * 1024) } });
    expect(processInboundLine(big, s)).toMatchObject({ kind: "rate-limited" });
  });
});

describe("relay-link 对真 relay 旅程", () => {
  it("enroll 签名注册 + WSS 连接收发", { timeout: 15000 }, async () => {
    const relay = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "gw-link-test-secret!", singleInstance: true });
    const port = (relay.server.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "link-"));
    const identity = await loadOrCreateIdentity({ agentDir: dir, installationIdFile: join(dir, "iid"), gatewayIdentityFile: join(dir, "gid.json") });
    const received: string[] = [];
    const statuses: string[] = [];
    const link = startRelayLink({
      relayUrl: `ws://127.0.0.1:${port}`,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: false,
      onFrame: (line) => received.push(line),
      onStatus: (status) => statuses.push(status),
      log: () => {},
    });
    const enrolled = await link.enrollOnce();
    expect(enrolled).not.toBeNull();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      if (link.connected()) break;
    }
    expect(link.connected()).toBe(true);
    expect(link.send(JSON.stringify({ v: 1, from: `gw_${identity.installationId}`, to: "dev_none", payload: "eA==", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }))).toBe(true);
    link.stop();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      if (!link.connected()) break;
    }
    expect(link.connected()).toBe(false);
    expect(link.send("{}")).toBe(false);
    await relay.close();
  });

  it("C2 回归：401 握手触发重 enroll（reauthenticate 路径）", { timeout: 12000 }, async () => {
    const relay = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "gw-link-test-secret!", singleInstance: true });
    const port = (relay.server.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "link401-"));
    const identity = await loadOrCreateIdentity({ agentDir: dir, installationIdFile: join(dir, "iid"), gatewayIdentityFile: join(dir, "gid.json") });
    let reauth = 0;
    const link = startRelayLink({
      relayUrl: `ws://127.0.0.1:${port}`,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: false,
      onFrame: () => {},
      onStatus: (status, detail) => {
        if (status === "disconnected" && detail.includes("401")) reauth += 1;
      },
      log: () => {},
    });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => { setTimeout(r, 200); });
      if (link.connected()) break;
    }
    expect(link.connected()).toBe(true);
    expect(reauth).toBeGreaterThanOrEqual(1);
    link.stop();
    await relay.close();
  });

  it("D5 回归：relay 节点指纹不符断连；相符保持连接", { timeout: 15000 }, async () => {
    const { startRelay } = await import("../../../../apps/hub-relay/src/main.ts");
    const relay = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "fp-test-secret-16bytes", singleInstance: true });
    const port = (relay.server.address() as { port: number }).port;
    const { createHash } = await import("node:crypto");
    const goodFp = createHash("sha256").update(Buffer.from(relay.nodeSigningPub, "hex")).digest("hex");
    const statuses: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), "fp-"));
    const identity = await loadOrCreateIdentity({ agentDir: dir, installationIdFile: join(dir, "iid"), gatewayIdentityFile: join(dir, "gid.json") });
    const badLink = startRelayLink({
      relayUrl: `ws://127.0.0.1:${port}`,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: false,
      expectedRelayFingerprint: "deadbeef".repeat(8),
      onFrame: () => {},
      onStatus: (st, d) => statuses.push(`bad:${st}:${d.slice(0, 30)}`),
      log: () => {},
    });
    await new Promise((r) => { setTimeout(r, 2500); });
    expect(statuses.some((x) => x.includes("mismatch") || x.includes("disconnected"))).toBe(true);
    badLink.stop();
    const goodLink = startRelayLink({
      relayUrl: `ws://127.0.0.1:${port}`,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: false,
      expectedRelayFingerprint: goodFp,
      onFrame: () => {},
      onStatus: () => {},
      log: () => {},
    });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => { setTimeout(r, 200); });
      if (goodLink.connected()) break;
    }
    expect(goodLink.connected()).toBe(true);
    await new Promise((r) => { setTimeout(r, 800); });
    expect(goodLink.connected()).toBe(true);
    goodLink.stop();
    await relay.close();
  });

  it("requestPairingTicket：无 token（未 enroll）返回 null；坏端口同样 null", { timeout: 10000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pt-"));
    const identity = await loadOrCreateIdentity({ agentDir: dir, installationIdFile: join(dir, "iid"), gatewayIdentityFile: join(dir, "gid.json") });
    const link = startRelayLink({
      relayUrl: "ws://127.0.0.1:1",
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: false,
      onFrame: () => {},
      onStatus: () => {},
      log: () => {},
    });
    await expect(link.requestPairingTicket("pr_x")).resolves.toBeNull();
    await expect(link.enrollOnce()).resolves.toBeNull();
    await expect(link.requestPairingTicket("pr_y")).resolves.toBeNull();
    link.stop();
  });

  it("enroll 失败路径：坏 URL 返回 null", { timeout: 8000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "link2-"));
    const identity = await loadOrCreateIdentity({ agentDir: dir, installationIdFile: join(dir, "iid"), gatewayIdentityFile: join(dir, "gid.json") });
    const link = startRelayLink({
      relayUrl: "ws://127.0.0.1:1",
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: false,
      onFrame: () => {},
      onStatus: () => {},
      log: () => {},
    });
    expect(await link.enrollOnce()).toBeNull();
    link.stop();
  });
});
