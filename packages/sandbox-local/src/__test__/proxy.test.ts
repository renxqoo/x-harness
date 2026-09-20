// 会话代理（docs/EXEC-ENV.md §4/§7）：真 socket in-process——CONNECT 直连授权域/未授权经假
// broker 批→放行+正缓存/拒→403+负缓存（重试不重弹）/非 CONNECT→405/同域并发单问/socket-close
// 后迟到裁决丢弃。

import * as net from "node:net";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GrantsRegistry } from "@x-harness/permission";
import { createSessionProxy } from "../proxy/server.ts";
import type { SessionId } from "@x-harness/session";

const S = "sess-p" as SessionId;

let upstream: net.Server;
let upstreamPort = 0;
const seen: string[] = [];

beforeEach(async () => {
  seen.length = 0;
  upstream = net.createServer((socket) => {
    socket.on("data", (buf) => {
      seen.push(buf.toString("utf8"));
      socket.write("PONG\n");
    });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as net.AddressInfo).port;
      resolve();
    });
  });
});
afterEach(async () => {
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve());
  });
});

/** marker 到场即收（200 头自带换行——不能以换行判定完成）；无 marker 等关闭 */
function speak(port: number, data: string, opts: { readonly marker?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let out = "";
    socket.on("connect", () => socket.write(data));
    socket.on("data", (buf) => {
      out += buf.toString("utf8");
      if (opts.marker !== undefined && out.includes(opts.marker)) {
        socket.end();
        resolve(out);
      }
    });
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
}

describe("createSessionProxy（真 socket）", () => {
  it("预授权域：CONNECT 放行并双向 pipe（upstream 收到载荷）", async () => {
    const grants = new GrantsRegistry();
    grants.recordDomain(S, "127.0.0.1", "allow");
    const proxy = await createSessionProxy(S, grants, { askDomain: async () => "deny" });
    try {
      const out = await speak(proxy.port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\nPING\n`, { marker: "PONG" });
      expect(out).toContain("200");
      expect(out).toContain("PONG");
      expect(seen).toContain("PING\n");
    } finally {
      await proxy.close();
    }
  });

  it("未授权域：ask 批→放行并记正缓存（二次零 ask）；拒→403 + 负缓存（重试不重弹）", async () => {
    const grants = new GrantsRegistry();
    let asks = 0;
    const proxy = await createSessionProxy(S, grants, {
      askDomain: async (_s, domain) => {
        asks += 1;
        return domain === "127.0.0.1" ? "allow" : "deny";
      },
    });
    try {
      const ok = await speak(proxy.port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\n`, { marker: "200 Connection Established" });
      expect(ok).toContain("200 Connection Established");
      expect(asks).toBe(1);
      const again = await speak(proxy.port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\n`, { marker: "200 Connection Established" });
      expect(again).toContain("200");
      expect(asks).toBe(1); // 正缓存——二次零 ask
      const bad = await speak(proxy.port, "CONNECT ask-no.dev:443 HTTP/1.1\r\n\r\n", { marker: "403" });
      expect(bad).toContain("403");
      const badAgain = await speak(proxy.port, "CONNECT ask-no.dev:443 HTTP/1.1\r\n\r\n", { marker: "403" });
      expect(badAgain).toContain("403");
      expect(asks).toBe(2); // 负缓存——拒后重试不重弹
    } finally {
      await proxy.close();
    }
  });

  it("broker 抛错 → deny（fail-closed）；非 CONNECT → 405", async () => {
    const grants = new GrantsRegistry();
    const proxy = await createSessionProxy(S, grants, {
      askDomain: async () => {
        throw new Error("ui gone");
      },
    });
    try {
      const denied = await speak(proxy.port, "CONNECT boom.dev:443 HTTP/1.1\r\n\r\n", { marker: "403" });
      expect(denied).toContain("403");
      const method = await speak(proxy.port, "GET http://x/ HTTP/1.1\r\n\r\n", { marker: "405" });
      expect(method).toContain("405");
    } finally {
      await proxy.close();
    }
  });

  it("垃圾输入降级：头部超限（>16K 无 HEAD_END）连接被毁，代理存活", async () => {
    const grants = new GrantsRegistry();
    const proxy = await createSessionProxy(S, grants, { askDomain: async () => "deny" });
    try {
      const junk = `X-${"a".repeat(20_000)}`;
      await speak(proxy.port, junk, { marker: "__never__" }).then(
        () => "closed",
        () => "closed",
      );
      // 代理仍在服务
      const still = await speak(proxy.port, "CONNECT any.dev:443 HTTP/1.1\r\n\r\n", { marker: "403" });
      expect(still).toContain("403");
    } finally {
      await proxy.close();
    }
  });

  it("同域并发 CONNECT 只问一次（单飞经 grants）；close 后监听停", async () => {
    const grants = new GrantsRegistry();
    let asks = 0;
    const proxy = await createSessionProxy(S, grants, {
      askDomain: async () => {
        asks += 1;
        await new Promise((r) => {
          setTimeout(r, 30);
        });
        return "allow";
      },
    });
    const port = proxy.port;
    const both = await Promise.all([
      speak(port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\n`, { marker: "200 Connection Established" }),
      speak(port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\n`, { marker: "200 Connection Established" }),
    ]);
    expect(both[0]).toContain("200");
    expect(both[1]).toContain("200");
    expect(asks).toBe(1); // 同域单问
    await proxy.close();
    const after = await speak(port, "CONNECT fly.dev:443 HTTP/1.1\r\n\r\n").then(
      () => "connected",
      () => "refused",
    );
    expect(after).toBe("refused"); // close 后监听停
  });
});

describe("createSessionProxy × unrestricted 总括（docs/PERMISSION-FULL-UNRESTRICTED.md）", () => {
  it("总括短路：负缓存被压过（位序在桶查询前）+ 不 ask + 不记账 + 双向 pipe", async () => {
    const grants = new GrantsRegistry();
    grants.recordDomain(S, "127.0.0.1", "deny"); // 先造负缓存——总括必须压过它
    grants.setUnrestricted(true);
    let asks = 0;
    let unrecordedConnects = 0;
    const proxy = await createSessionProxy(S, grants, {
      askDomain: async () => {
        asks += 1;
        return "deny";
      },
      // 上游 connect 注入：127.0.0.1 直连真 upstream；未记录域计数后抛错（消 DNS 环境依赖，确定论 502）
      connect: ((...args: Parameters<typeof net.connect>) => {
        const opts = args[0] as { host?: string } | undefined;
        if (opts?.host === "unrecorded.invalid") {
          unrecordedConnects += 1;
          throw new Error("stub refused");
        }
        return net.connect(...args);
      }) as typeof net.connect,
    });
    try {
      const out = await speak(proxy.port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\nPING\n`, { marker: "PONG" });
      expect(out).toContain("200 Connection Established");
      expect(out).toContain("PONG");
      expect(seen).toContain("PING\n");
      expect(asks).toBe(0); // 不经 ask
      expect(grants.domainVerdict(S, "127.0.0.1")).toBe("deny"); // 不改写既有记账（负缓存原样）
      // 未记录域（RFC 6761 保留 TLD）放行后也不新增记账（总括不写桶）
      const refused = await speak(proxy.port, "CONNECT unrecorded.invalid:443 HTTP/1.1\r\n\r\n", { marker: "502" });
      expect(refused).toContain("502"); // 短路放行 → 上游 stub 拒 → 502（经管道出口）
      expect(unrecordedConnects).toBe(1); // 放行确实到达上游连接尝试
      expect(grants.domainVerdict(S, "unrecorded.invalid")).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  it("总括态非 CONNECT 方法仍 405（短路不吞方法检查）", async () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    const proxy = await createSessionProxy(S, grants, { askDomain: async () => "deny" });
    try {
      const out = await speak(proxy.port, "GET http://x.dev/ HTTP/1.1\r\n\r\n", { marker: "405" });
      expect(out).toContain("405 Method Not Allowed");
    } finally {
      await proxy.close();
    }
  });

  it("rootOverride 会话不短路：仍走 ask 链（隔离压过总括，文件/网络同向）", async () => {
    const grants = new GrantsRegistry();
    grants.setRootOverride(S, "/wt/agent-1", "/repo");
    grants.setUnrestricted(true);
    let asks = 0;
    const proxy = await createSessionProxy(S, grants, {
      askDomain: async () => {
        asks += 1;
        return "allow";
      },
    });
    try {
      const out = await speak(proxy.port, `CONNECT 127.0.0.1:${String(upstreamPort)} HTTP/1.1\r\n\r\n`, { marker: "200 Connection Established" });
      expect(out).toContain("200");
      expect(asks).toBe(1); // 走了 ask——未短路
    } finally {
      await proxy.close();
    }
  });
});
