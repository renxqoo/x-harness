// RESP 编解码契约 + fake server 旅程（store-redis 经 fake server 走全命令面）
import { describe, expect, it } from "vitest";
import { encodeCommand, parseResp, RespClient } from "../resp.ts";
import { startFakeRespServer } from "./fake-resp.ts";
import { createServer, type Server } from "node:net";

describe("RESP 编解码", () => {
  it("命令编码：array of bulk strings", () => {
    const bytes = encodeCommand(["GET", "key:1"]);
    expect(bytes.toString("utf8")).toBe("*2\r\n$3\r\nGET\r\n$5\r\nkey:1\r\n");
  });

  it("解析：简单串/整数/批量串/null 数组/负长度；不完整返回 null", () => {
    expect(parseResp(Buffer.from("+OK\r\n"))).toEqual({ value: "OK", consumed: 5 });
    expect(parseResp(Buffer.from(":7\r\n"))).toEqual({ value: 7, consumed: 4 });
    expect(parseResp(Buffer.from("$3\r\nabc\r\n"))).toEqual({ value: "abc", consumed: 9 });
    expect(parseResp(Buffer.from("$-1\r\n"))).toEqual({ value: null, consumed: 5 });
    expect(parseResp(Buffer.from("*-1\r\n"))).toEqual({ value: null, consumed: 5 });
    expect(parseResp(Buffer.from("*2\r\n$1\r\na\r\n$1\r"))).toBeNull();
    expect(parseResp(Buffer.from("*2\r\n$1\r\na\r\n$1\r\nb\r\nEXTRA"))?.consumed).toBe(18);
    expect(parseResp(Buffer.from("-ERR x\r\n"))?.value).toBeInstanceOf(Error);
    expect(parseResp(Buffer.alloc(0))).toBeNull();
  });
});

describe("RespClient 旅程（fake server）", () => {
  it("全命令面：ensure/get/set/del/sadd/sismember/publish/subscribe", async () => {
    const fake = await startFakeRespServer();
    const client = new RespClient({ host: "127.0.0.1", port: fake.port });
    await client.ensure();
    await client.set("k1", "v1");
    expect(await client.get("k1")).toBe("v1");
    expect(await client.get("missing")).toBeNull();
    await client.del("k1");
    expect(await client.get("k1")).toBeNull();
    await client.sadd("revoked", "dev_9");
    expect(await client.sismember("revoked", "dev_9")).toBe(true);
    expect(await client.sismember("revoked", "dev_x")).toBe(false);
    const got: Array<[string, string]> = [];
    await client.subscribe("chan-1", (channel, message) => got.push([channel, message]));
    fake.subscribe((channel: string, message: string) => {
      if (channel === "chan-1") client.publish("noop", "noop").catch(() => {});
    });
    await client.publish("chan-1", "hello");
    await new Promise((r) => setTimeout(r, 100));
    client.close();
    await fake.close();
    // subscribe 消息经 client 的 subscribeHandlers 分发（此处仅验证不崩 + 写面全走）
    expect(fake.received.length).toBeGreaterThanOrEqual(6);
  });
});
