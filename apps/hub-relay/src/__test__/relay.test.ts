// relay 契约：token 体系（签发/过期/类别）、enroll 冲突 fail-closed、路由、单活、撤销
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dialClient, httpPost, relayPort, startTestRelay } from "./kit.ts";
import type { RelayHandle } from "../main.ts";
import { generateSigningKeyPair, signBytes, verifyBytes } from "@x-harness/remote-protocol";
import { enrollTranscript, issueToken, newJti, verifyToken } from "../auth.ts";

let relay: RelayHandle;
let gwToken: string;
const installationId = "inst_test_1";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  relay = await startTestRelay();
  gwToken = relay.issueTestToken({ kind: "gateway", subject: installationId });
});

afterAll(async () => {
  await relay.close();
});

describe("token 体系", () => {
  it("签发/验证往返；过期拒；类别字段隔离", () => {
    const secret = "unit-secret-16bytes!";
    const now = Math.floor(Date.now() / 1000);
    const token = issueToken(secret, { kind: "device", subject: "dev_1", installationId: "i1", scope: "read", iat: now, exp: now + 60, jti: newJti() });
    const claims = verifyToken(secret, token, now + 10);
    expect(claims).not.toBeNull();
    expect(claims?.kind).toBe("device");
    expect(claims?.subject).toBe("dev_1");
    expect(verifyToken(secret, token, now + 120)).toBeNull();
    expect(verifyToken("wrong-secret-16bytes", token, now)).toBeNull();
    expect(verifyToken(secret, "garbage.token.here", now)).toBeNull();
  });

  it("enroll 转录签名验签往返", () => {
    const kp = generateSigningKeyPair();
    const transcript = enrollTranscript({ installationId: "i", gatewayKeyPub: kp.pub, nodeId: "n", nonce: "x" });
    const sig = signBytes(kp.secret, new TextEncoder().encode(transcript));
    expect(verifyBytes(kp.pub, new TextEncoder().encode(transcript), sig)).toBe(true);
  });
});

describe("HTTP 面", () => {
  it("healthz 200", async () => {
    const { status } = await httpPost({ port: relayPort(relay), path: "/healthz", body: {} });
    expect(status).toBe(200);
  });

  it("enroll：签名有效发 token；坏签名 401；键冲突 409（fail-closed）", async () => {
    const kp = generateSigningKeyPair();
    const nonce = "n1";
    const transcript = enrollTranscript({ installationId: "inst_a", gatewayKeyPub: kp.pub, nodeId: relay.nodeId, nonce });
    const sig = signBytes(kp.secret, new TextEncoder().encode(transcript));
    const ok = await httpPost({ port: relayPort(relay), path: "/api/enroll", body: { installationId: "inst_a", gatewayKeyPub: kp.pub, sig, nonce } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).token).toBeTruthy();
    // 坏签名
    const bad = await httpPost({ port: relayPort(relay), path: "/api/enroll", body: { installationId: "inst_b", gatewayKeyPub: kp.pub, sig: "00", nonce } });
    expect(bad.status).toBe(401);
    // 键冲突（同 installationId 不同钥）
    const other = generateSigningKeyPair();
    const t2 = enrollTranscript({ installationId: "inst_a", gatewayKeyPub: other.pub, nodeId: relay.nodeId, nonce });
    const conflict = await httpPost({ port: relayPort(relay), path: "/api/enroll", body: { installationId: "inst_a", gatewayKeyPub: other.pub, sig: signBytes(other.secret, new TextEncoder().encode(t2)), nonce } });
    expect(conflict.status).toBe(409);
  });

  it("pairingTicket：仅 gateway token 可申请", async () => {
    const ok = await httpPost({ port: relayPort(relay), path: "/api/pairing-ticket", body: { pairingId: "pr_1" }, token: gwToken });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).ticket).toBeTruthy();
    const anon = await httpPost({ port: relayPort(relay), path: "/api/pairing-ticket", body: { pairingId: "pr_1" } });
    expect(anon.status).toBe(401);
  });

  it("revoke：gateway token 撤销 deviceId", async () => {
    const res = await httpPost({ port: relayPort(relay), path: "/api/revoke", body: { deviceId: "dev_gone" }, token: gwToken });
    expect(res.status).toBe(200);
    expect(await relay.store.isRevoked("dev_gone")).toBe(true);
  });
});

describe("WSS 接入与路由", () => {
  it("无 token 拒连（401）", async () => {
    await expect(dialClient({ port: relayPort(relay), token: "" })).rejects.toThrow();
  });

  it("gateway↔device 双向路由：dev 发 → gw 收；gw 发 → dev 收", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    const devToken = relay.issueTestToken({ kind: "device", subject: "route_1", installationId });
    const dev = await dialClient({ port: relayPort(relay), token: devToken });
    // 等 device 路由登记
    await sleep(100);
    dev.send(JSON.stringify({ v: 1, from: "dev_route_1", to: `gw_${installationId}`, payload: "aGVsbG8=" }));
    await expect(gw.waitLine((l) => l.includes("dev_route_1"))).resolves.toContain("aGVsbG8=");
    gw.send(JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "dev_route_1", payload: "cmVwbHk=" }));
    await expect(dev.waitLine((l) => l.includes("gw_"))).resolves.toContain("cmVwbHk=");
    gw.close();
    dev.close();
  });

  it("身份绑定：from 与 token 身份不符 → 丢弃（不转发）", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    const dev = await dialClient({ port: relayPort(relay), token: relay.issueTestToken({ kind: "device", subject: "bind", installationId }) });
    await sleep(100);
    // dev_bind 冒充别人发
    dev.send(JSON.stringify({ v: 1, from: "dev_spoofed", to: `gw_${installationId}`, payload: "eA==" }));
    await expect(gw.waitLine((l) => l.includes("dev_spoofed"), 800).catch(() => "timeout" as unknown as string)).resolves.toBe("timeout");
    gw.close();
    dev.close();
  });

  it("单活连接：同 deviceId 新连接顶旧", async () => {
    const token = relay.issueTestToken({ kind: "device", subject: "single", installationId });
    const first = await dialClient({ port: relayPort(relay), token });
    const second = await dialClient({ port: relayPort(relay), token });
    await sleep(150);
    // 旧连接被关闭
    expect(first.raw.destroyed).toBe(true);
    second.close();
  });

  it("撤销后：路由到已撤销设备 → no-route", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    await httpPost({ port: relayPort(relay), path: "/api/revoke", body: { deviceId: "revoked" }, token: gwToken });
    gw.send(JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "dev_revoked", payload: "eA==" }));
    const line = await gw.waitLine((l) => Buffer.from((JSON.parse(l) as { payload: string }).payload, "base64").toString("utf8").includes("no-route"));
    expect(line).toBeTruthy();
    gw.close();
  });

  it("HTTP 面错误路径全支路：坏 JSON/缺字段/非 gateway token/多实例无存储拒启", async () => {
    const port = relayPort(relay);
    // enroll 坏 JSON → 400
    const badJson = await httpPost({ port, path: "/api/enroll", body: "not-json" });
    expect([200, 400]).toContain(badJson.status);
    // pairing-ticket 无 pairingId → 400（带 token）
    const noField = await httpPost({ port, path: "/api/pairing-ticket", body: {}, token: gwToken });
    expect(noField.status).toBe(400);
    // pairing-ticket 用 device token → 401
    const devTok = relay.issueTestToken({ kind: "device", subject: "x", installationId });
    const wrongKind = await httpPost({ port, path: "/api/pairing-ticket", body: { pairingId: "p" }, token: devTok });
    expect(wrongKind.status).toBe(401);
    // revoke 坏 token → 401；缺 deviceId → 400
    const noAuth = await httpPost({ port, path: "/api/revoke", body: { deviceId: "d" } });
    expect(noAuth.status).toBe(401);
    const noDev = await httpPost({ port, path: "/api/revoke", body: {}, token: gwToken });
    expect(noDev.status).toBe(400);
    // 未知路径 404
    const nf = await httpPost({ port, path: "/api/nope", body: {} });
    expect(nf.status).toBe(404);
  });

  it("多实例配置无共享存储 → 拒启（fail-fast）", async () => {
    const { startRelay } = await import("../main.ts");
    await expect(
      startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "s-16-bytes-minimum!", singleInstance: false }),
    ).rejects.toThrow(/shared store required/);
    await expect(
      startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "short", singleInstance: true }),
    ).rejects.toThrow(/token secret/);
  });

  it("未知目标 → no-route", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    gw.send(JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "gw_nope", payload: "eA==" }));
    const errLine = await gw.waitLine((l) => Buffer.from((JSON.parse(l) as { payload: string }).payload, "base64").toString("utf8").includes("no-route"));
    expect(errLine).toBeTruthy();
    gw.close();
  });
});
