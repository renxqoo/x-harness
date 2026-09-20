// 会话代理（docs/EXEC-ENV.md §4 网络域名白名单——用户裁决①）：本机回环 HTTP CONNECT 代理，
// per-session 专口（CONNECT 归属会话无歧义）。域名 ACL 经 permission：授权集内放行；域外
// broker ask（socket close 即撤 ask 以 deny 结算——子进程死/超时不留僵尸 ask）；deny=负缓存
// （重试不重弹）。非 HTTP(S) 协议不经代理（内核剖面只放代理口——直连全拒）。

import * as net from "node:net";
import type { SessionId } from "@x-harness/session";
import type { GrantsRegistry } from "@x-harness/permission";

export interface ProxyHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface ProxyDeps {
  /** broker 裁决入口（缺席/抛错 → deny——fail-closed 由 grants 承担） */
  readonly askDomain: (session: SessionId | undefined, domain: string) => Promise<"allow" | "deny">;
  /** 宿主预授权域名（永不走 ask——§4） */
  readonly preAllowed?: ReadonlySet<string>;
  readonly connect?: typeof net.connect;
  readonly createServer?: typeof net.createServer;
}

const HEAD_END = "\r\n\r\n";

export function createSessionProxy(session: SessionId | undefined, grants: GrantsRegistry, deps: ProxyDeps): Promise<ProxyHandle> {
  const connect = deps.connect ?? net.connect;
  const sockets = new Set<net.Socket>();
  const server = (deps.createServer ?? net.createServer)((client: net.Socket) => {
    sockets.add(client);
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf(HEAD_END);
      if (end < 0) {
        if (buffer.length > 16_384) client.destroy(); // 头部超限——垃圾输入降级
        return;
      }
      client.removeListener("data", onData);
      // CONNECT 头与载荷同包时残余字节不可丢——建立管道后先转发
      void handleConnect(client, buffer.slice(0, end), Buffer.from(buffer.slice(end + HEAD_END.length), "latin1"));
    };
    client.on("data", onData);
    client.on("close", () => {
      sockets.delete(client);
    });
    client.on("error", () => {
      sockets.delete(client);
    });
  });

  const handleConnect = async (client: net.Socket, head: string, pipelined: Buffer): Promise<void> => {
    const first = head.split("\r\n", 1)[0] ?? "";
    // CONNECT host:port HTTP/1.x —— 其它方法（GET 等）不经代理转发（围栏内 HTTP_PROXY 语义）
    const match = /^CONNECT\s+([^\s:]+)(?::(\d+))?\s+HTTP\//i.exec(first);
    if (match === null) {
      client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      return;
    }
    const domain = (match[1] ?? "").toLowerCase();
    const port = Number(match[2] ?? "443");
    if (grants.isUnrestricted(session)) {
      // full 总括授权（docs/PERMISSION-FULL-UNRESTRICTED.md）：位序在域名桶之前（压过逐域
      // 负缓存）、不 ask、不记账——放行后 domainVerdict 仍 undefined；override 会话不短路
      await pipeUpstream({ client, domain, port, pipelined });
      return;
    }
    const settled = grants.domainVerdict(session, domain);
    let verdict: "allow" | "deny" = settled ?? "deny";
    if (settled === undefined && deps.preAllowed?.has(domain) === true) {
      verdict = "allow"; // 宿主预授权——永不 ask
    } else if (settled === undefined) {
      // socket close 即撤 ask：客户端断开（子进程被杀/超时）→ aborted——迟到裁决不记账不生效
      const aborted = new Promise<"aborted">((resolve) => {
        client.once("close", () => resolve("aborted"));
      });
      const outcome = await Promise.race([
        grants.askDomainOnce({ session, domain, ask: () => deps.askDomain(session, domain), abort: aborted }),
        aborted,
      ]);
      if (outcome === "aborted") {
        client.destroy();
        return;
      }
      verdict = outcome;
    }
    if (verdict === "deny") {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    await pipeUpstream({ client, domain, port, pipelined });
  };

  /** CONNECT 放行后的上游管道建立（总括短路与逐域批准共用出口） */
  const pipeUpstream = async (req: { readonly client: net.Socket; readonly domain: string; readonly port: number; readonly pipelined: Buffer }): Promise<void> => {
    const { client, domain, port, pipelined } = req;
    let upstream: net.Socket;
    try {
      upstream = connect({ host: domain, port });
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const drop = (): void => {
      upstream.destroy();
      client.destroy();
    };
    // 连接失败（DNS/拒连）是异步 error——200 未发出前以 502 收场
    upstream.once("error", () => {
      if (!client.destroyed && client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      else drop();
    });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (pipelined.byteLength > 0) upstream.write(pipelined);
    upstream.pipe(client);
    client.pipe(upstream);
    client.on("error", drop);
    upstream.on("close", () => {
      sockets.delete(client);
      client.destroy();
    });
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("sandbox-local: proxy listen failed"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
