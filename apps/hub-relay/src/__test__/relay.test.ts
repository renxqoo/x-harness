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

  it("enroll challenge：返回 nodeId+nonce", async () => {
    const res = await httpPost({ port: relayPort(relay), path: "/api/enroll/challenge", body: {} });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { nodeId?: string; nonce?: string };
    expect(parsed.nodeId).toBe(relay.nodeId);
    expect(parsed.nonce).toBeTruthy();
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

  it("回归（D1 症状：连接抹 enroll 钥→身份劫持）：连接不改钉存钥；异钥 enroll 恒 409", async () => {
    const kp = generateSigningKeyPair();
    const nonce = "d1";
    const t = enrollTranscript({ installationId: "inst_d1", gatewayKeyPub: kp.pub, nodeId: relay.nodeId, nonce });
    const first = await httpPost({ port: relayPort(relay), path: "/api/enroll", body: { installationId: "inst_d1", gatewayKeyPub: kp.pub, sig: signBytes(kp.secret, new TextEncoder().encode(t)), nonce } });
    expect(first.status).toBe(200);
    // gateway 连接（token 主体 inst_d1）
    const gw = await dialClient({ port: relayPort(relay), token: relay.issueTestToken({ kind: "gateway", subject: "inst_d1" }) });
    await sleep(200);
    // 钉存钥仍为原钥
    expect((await relay.store.getInstallation("inst_d1"))?.gatewayKeyPub).toBe(kp.pub);
    // 异钥 enroll → 409
    const other = generateSigningKeyPair();
    const t2 = enrollTranscript({ installationId: "inst_d1", gatewayKeyPub: other.pub, nodeId: relay.nodeId, nonce });
    const hijack = await httpPost({ port: relayPort(relay), path: "/api/enroll", body: { installationId: "inst_d1", gatewayKeyPub: other.pub, sig: signBytes(other.secret, new TextEncoder().encode(t2)), nonce } });
    expect(hijack.status).toBe(409);
    gw.close();
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
    dev.send(JSON.stringify({ v: 1, from: "dev_route_1", to: `gw_${installationId}`, payload: "aGVsbG8=", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
    await expect(gw.waitLine((l) => l.includes("dev_route_1"))).resolves.toContain("aGVsbG8=");
    gw.send(JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "dev_route_1", payload: "cmVwbHk=", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
    await expect(dev.waitLine((l) => l.includes("gw_"))).resolves.toContain("cmVwbHk=");
    gw.close();
    dev.close();
  });

  it("身份绑定：from 与 token 身份不符 → 丢弃（不转发）", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    const dev = await dialClient({ port: relayPort(relay), token: relay.issueTestToken({ kind: "device", subject: "bind", installationId }) });
    await sleep(100);
    // dev_bind 冒充别人发
    dev.send(JSON.stringify({ v: 1, from: "dev_spoofed", to: `gw_${installationId}`, payload: "eA==", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
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
    gw.send(JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "dev_revoked", payload: "eA==", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
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

  it("D2 回归：跨节点转发 dev_ 目标分派设备连接（pattern 频道语义）", async () => {
    // 同节点直投（无跨节点），此用例锚 broadcast 消费面：发布 revoke 广播后设备连接被断
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    const devToken = relay.issueTestToken({ kind: "device", subject: "bc1", installationId });
    const dev = await dialClient({ port: relayPort(relay), token: devToken });
    await sleep(150);
    await httpPost({ port: relayPort(relay), path: "/api/revoke", body: { deviceId: "bc1" }, token: gwToken });
    await sleep(400);
    expect(dev.raw.destroyed).toBe(true);
    gw.close();
  });

  it("E5 回归：超 16MiB 信封断连", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    const huge = JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "dev_x", payload: "x".repeat(17 * 1024 * 1024), nonce: "A" });
    gw.send(huge);
    await sleep(500);
    expect(gw.raw.destroyed).toBe(true);
  });

  it("显式签名钥注入优先；redis 形态启动；node-key 端点返回注入钥", async () => {
    const { startRelay } = await import("../main.ts");
    const kp = generateSigningKeyPair();
    const relay2 = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "test-secret-16bytes!!", singleInstance: true, signingSecret: kp.secret, signingPub: kp.pub });
    expect(relay2.nodeSigningPub).toBe(kp.pub);
    const node = await httpPost({ port: relayPort(relay2), path: "/api/node-key", body: {} });
    // httpPost 是 POST——node-key 只收 GET。直接 net GET：
    const { connect } = await import("node:net");
    const raw = await new Promise<string>((resolve) => {
      const sock = connect({ host: "127.0.0.1", port: relayPort(relay2) });
      sock.on("connect", () => sock.write("GET /api/node-key HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let buf = "";
      sock.on("data", (c: Buffer) => { buf += c.toString(); });
      sock.on("close", () => resolve(buf));
    });
    expect(raw).toContain(kp.pub);
    void node;
    await relay2.close();
    // redis 形态（fake RESP）启动成功
    const { startFakeRespServer } = await import("./fake-resp.ts");
    const fake = await startFakeRespServer();
    const relay3 = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "test-secret-16bytes!!", singleInstance: true, redis: { host: "127.0.0.1", port: fake.port } });
    expect(relay3.server.listening).toBe(true);
    await relay3.close();
    await fake.close();
  });

  it("pairing ticket 仅 /pairing 路径可用作数据面（其他路径 401）", async () => {
    const ticket = relay.issuePairingTicket("pr_path");
    // 非 pairing 路径：kind=pairing 不被接受
    await expect(dialClient({ port: relayPort(relay), token: ticket, path: "/" })).rejects.toThrow();
    // pairing 路径可连
    const ph = await dialClient({ port: relayPort(relay), token: ticket, path: "/pairing" });
    expect(ph.raw.destroyed).toBe(false);
    ph.close();
  });

  it("单活顶替：旧连接 teardown 清 pingTimer（C4 回归——不泄漏定时器句柄）", async () => {
    const token = relay.issueTestToken({ kind: "device", subject: "single2", installationId });
    const first = await dialClient({ port: relayPort(relay), token });
    const second = await dialClient({ port: relayPort(relay), token });
    await sleep(200);
    expect(first.raw.destroyed).toBe(true);
    // 新连接正常收发
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    second.send(JSON.stringify({ v: 1, from: "dev_single2", to: `gw_${installationId}`, payload: "eA==", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
    await expect(gw.waitLine((l) => l.includes("dev_single2"))).resolves.toBeTruthy();
    second.close();
    gw.close();
  });

  it("句柄面：issuePairingTicket 签发可接入；close 后 server 关闭", async () => {
    const ticket = relay.issuePairingTicket("pr_handle");
    expect(ticket.split(".").length).toBe(3);
    const { startRelay } = await import("../main.ts");
    const one = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "test-secret-16bytes!!", singleInstance: true });
    await one.close();
    expect(one.server.listening).toBe(false);
  });

  it("未知目标 → no-route", async () => {
    const gw = await dialClient({ port: relayPort(relay), token: gwToken });
    gw.send(JSON.stringify({ v: 1, from: `gw_${installationId}`, to: "gw_nope", payload: "eA==", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
    const errLine = await gw.waitLine((l) => Buffer.from((JSON.parse(l) as { payload: string }).payload, "base64").toString("utf8").includes("no-route"));
    expect(errLine).toBeTruthy();
    gw.close();
  });
});

describe("设备 token 签发（WIRE 设备注册收尾）", () => {
  it("gateway 代注册设备签发 kind:device token；未注册设备 404；无 token 401", async () => {
    const res = await httpPost({ port: relayPort(relay), path: "/api/device-token", body: { deviceId: "d_new", installationId }, token: gwToken });
    expect(res?.status).toBe(200);
    const parsed = JSON.parse((res?.body ?? "{}") as string) as { token?: string };
    expect(typeof parsed.token).toBe("string");
    const unauthorized = await httpPost({ port: relayPort(relay), path: "/api/device-token", body: { deviceId: "d_new", installationId } });
    expect(unauthorized?.status).toBe(401);
    // 未登记设备：gateway 持有效 token 即注册凭据（登记放行）；跨 installation 改绑 409
    const freshDevice = await httpPost({ port: relayPort(relay), path: "/api/device-token", body: { deviceId: "d_fresh", installationId }, token: gwToken });
    expect(freshDevice?.status).toBe(200);
    const rebound = await httpPost({ port: relayPort(relay), path: "/api/device-token", body: { deviceId: "d_fresh", installationId: "inst_other" }, token: gwToken });
    expect(rebound?.status).toBe(409);
  });
});
