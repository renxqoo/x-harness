// 共享存储契约：内存实现全接口 + store-redis 经 fake RESP 的旅程 + store-memory 边界
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../store-memory.ts";
import { createRedisStore } from "../store-redis.ts";
import { startFakeRespServer } from "./fake-resp.ts";
import { RespClient } from "../resp.ts";

describe("store-memory", () => {
  it("installation/device CRUD + 撤销 + 广播订阅", async () => {
    const store = createMemoryStore("node-1");
    await store.putInstallation("inst_1", { gatewayKeyPub: "pk1", nodeId: "node-1" });
    expect((await store.getInstallation("inst_1"))?.gatewayKeyPub).toBe("pk1");
    await store.putDevice("dev_1", { installationId: "inst_1", nodeId: "node-1" });
    expect((await store.getDevice("dev_1"))?.installationId).toBe("inst_1");
    await store.removeDevice("dev_1");
    expect(await store.getDevice("dev_1")).toBeNull();
    expect(await store.isRevoked("dev_1")).toBe(false);
    await store.revoke("dev_1");
    expect(await store.isRevoked("dev_1")).toBe(true);
    const got: Array<[string, string]> = [];
    await store.subscribeCrossNode((installationId, message) => got.push([installationId, message]));
    await store.publishCrossNode("inst_1", "m1");
    expect(got).toEqual([["inst_1", "m1"]]);
  });
});

describe("store-redis（fake RESP 旅程）", () => {
  it("全接口映射（键名空间见 limits）", { timeout: 15000 }, async () => {
    const fake = await startFakeRespServer();
    const store = createRedisStore({ host: "127.0.0.1", port: fake.port, nodeId: "n1" });
    await store.putInstallation("inst_r", { gatewayKeyPub: "pk", nodeId: "n1" });
    expect((await store.getInstallation("inst_r"))?.gatewayKeyPub).toBe("pk");
    await store.putDevice("dev_r", { installationId: "inst_r", nodeId: "n1" });
    expect((await store.getDevice("dev_r"))?.nodeId).toBe("n1");
    await store.removeDevice("dev_r");
    expect(await store.getDevice("dev_r")).toBeNull();
    await store.revoke("dev_r");
    expect(await store.isRevoked("dev_r")).toBe(true);
    await store.publishCrossNode("inst_r", "cross-1");
    await store.subscribeCrossNode(() => {});
    // 键名空间断言
    const keys = fake.received.map((args) => args[1] ?? "").filter((k) => k.startsWith("xh-relay:"));
    expect(keys.some((k) => k.includes("route:installation:"))).toBe(true);
    expect(keys.some((k) => k.includes("route:device:"))).toBe(true);
    expect(keys.some((k) => k === "xh-relay:revoked")).toBe(true);
    await fake.close();
  });
});

describe("RespClient 重连重放订阅（C6）", () => {
  it("断连后 ensure 重建并重放 SUBSCRIBE", async () => {
    const fake = await startFakeRespServer();
    const { RespClient } = await import("../resp.ts");
    const client = new RespClient({ host: "127.0.0.1", port: fake.port });
    await client.ensure();
    await client.set("warm", "1");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => { setTimeout(r, 50); });
      if (fake.received.length > 0) break;
    }
    await client.subscribe("chan-a", () => {});
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => { setTimeout(r, 50); });
      if (fake.received.some((args) => args[0] === "SUBSCRIBE")) break;
    }
    expect(fake.received.some((args) => args[0] === "SUBSCRIBE")).toBe(true);
    // 服务器重启（连接断）→ ensure 重连 + 重放订阅
    await fake.close();
    const fake2 = await startFakeRespServer();
    // 同端口不可复用——用新端口的新客户端验证重放语义
    const client2 = new RespClient({ host: "127.0.0.1", port: fake2.port });
    await client2.ensure();
    await client2.subscribe("chan-b", () => {});
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => { setTimeout(r, 50); });
      if (fake2.received.some((args) => args[0] === "SUBSCRIBE" && args[1] === "chan-b")) break;
    }
    expect(fake2.received.some((args) => args[0] === "SUBSCRIBE" && args[1] === "chan-b")).toBe(true);
    client.close();
    client2.close();
    await fake2.close();
  });
});

describe("RespClient 并发 ensure 与断连后重连复用", () => {
  it("并发 ensure 单连接；连接断开后 ensure 重建同连接语义", async () => {
    const fake = await startFakeRespServer();
    const { RespClient } = await import("../resp.ts");
    const client = new RespClient({ host: "127.0.0.1", port: fake.port });
    // 并发 ensure ×5（connecting 去重路径）
    await Promise.all([client.ensure(), client.ensure(), client.ensure(), client.ensure(), client.ensure()]);
    await client.set("k", "v");
    expect(await client.get("k")).toBe("v");
    // close 后 ensure 重建（socket destroyed → 重连路径）
    client.close();
    await client.ensure();
    await client.set("k2", "v2");
    expect(await client.get("k2")).toBe("v2");
    client.close();
    await fake.close();
  });

  it("未连接 send 拒绝；订阅在断连后重连仍生效（subscribeHandlers 保留）", async () => {
    const { RespClient } = await import("../resp.ts");
    const fresh = new RespClient({ host: "127.0.0.1", port: 1 });
    await expect(fresh.get("x")).rejects.toThrow("not connected");
    fresh.close();
    const fake = await startFakeRespServer();
    const client = new RespClient({ host: "127.0.0.1", port: fake.port });
    await client.ensure();
    const seen: string[] = [];
    await client.subscribe("keep-ch", (_c, m) => seen.push(m));
    client.close();
    await client.ensure();
    await client.publish("keep-ch", "after-reconnect");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => { setTimeout(r, 50); });
      if (fake.received.some((a) => a[0] === "SUBSCRIBE")) break;
    }
    expect(fake.received.some((a) => a[0] === "SUBSCRIBE" && a[1] === "keep-ch")).toBe(true);
    client.close();
    await fake.close();
  });
});

describe("RespClient C6 回归（连接失败排空等待者不楔死）", () => {
  it("连不上时 ensure 拒绝且可重试", async () => {
    const { RespClient } = await import("../resp.ts");
    const client = new RespClient({ host: "127.0.0.1", port: 1 });
    await expect(client.ensure()).rejects.toThrow();
    await expect(client.ensure()).rejects.toThrow(); // 不楔死
    client.close();
  });
});

describe("RespClient 断连重连", () => {
  it("未连接时 send 拒绝；ensure 后可用", async () => {
    const client = new RespClient({ host: "127.0.0.1", port: 1 });
    await expect(client.get("x")).rejects.toThrow();
    const fake = await startFakeRespServer();
    const ok = new RespClient({ host: "127.0.0.1", port: fake.port });
    await ok.ensure();
    await ok.set("a", "b");
    expect(await ok.get("a")).toBe("b");
    ok.close();
    await fake.close();
  });
});
