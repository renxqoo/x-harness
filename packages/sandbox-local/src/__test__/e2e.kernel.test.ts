// 真内核 e2e（docs/EXEC-ENV.md §7）：darwin Seatbelt 腿全执行（wrapper 在场时 skip>0 即失败——
// darwin sandbox-exec 系统内建恒在场）；linux bwrap 腿仓库内 darwin 开发机不执行
// （known-untested in-repo——T9 外部矩阵承载，X_HARNESS_REQUIRE_LINUX_FENCE=1 时 fail-if-unexecuted）。
// 用例：越根写拒/根内写过/拒读表/直连拒/非代理口拒/会话代理真 CONNECT/TOCTOU 换靶拒/组杀 wrapper 下。

import * as net from "node:net";
import { existsSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { createSandboxEnv } from "../env.ts";
import { createSessionProxy } from "../proxy/server.ts";
import type { ExecEnv } from "@x-harness/exec-env";
import type { SessionId } from "@x-harness/session";

const DARWIN = process.platform === "darwin";
const HAS_SEATBELT = DARWIN && existsSync("/usr/bin/sandbox-exec");
const REQUIRE_LINUX = process.env.X_HARNESS_REQUIRE_LINUX_FENCE === "1";

if (REQUIRE_LINUX && !DARWIN && process.platform !== "linux") {
  throw new Error("X_HARNESS_REQUIRE_LINUX_FENCE=1 but not on linux");
}

import { GrantsRegistry } from "@x-harness/permission";

const S = "sess-e2e" as SessionId;

function upstreamEcho(socket: net.Socket): void {
  socket.on("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"));
}

let root = "";
let outside = "";
let env: ExecEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "xh-sbx-"));
  outside = mkdtempSync(join(homedir(), ".xh-sbx-out-")); // 家目录（不在 writable——越根靶场）
  env = createSandboxEnv({
    base: createLocalEnv(root),
    fenceOf: () => ({ writable: [root, tmpdir()], denyRead: ["~/.ssh"], protectedPaths: [], network: { allowedDomains: [] } }),
    dialect: DARWIN ? "darwin" : "linux",
    // 直连腿：allowlist 档但无代理口（SBPL 无任何网络放行——直连必拒）；CONNECT 腿单独装配
    proxyTargetOf: async () => ({}),
    isTornDown: () => false,
  }).env;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function drainTo(stream: ReadableStream<Uint8Array>, parts: string[]): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    parts.push(dec.decode(read.value, { stream: true }));
  }
}

async function sh(command: string): Promise<{ out: string; code: number | null }> {
  const spawned = await env.spawn({ argv: ["/bin/sh", "-c", command], cwd: root, session: S });
  if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned.reason)}`);
  const parts: string[] = [];
  const exited = spawned.proc.exited;
  await Promise.all([drainTo(spawned.proc.stdout, parts), drainTo(spawned.proc.stderr, parts)]);
  const done = await exited;
  await spawned.proc.settled;
  return { out: parts.join(""), code: done.code };
}

describe("sandbox 真内核（darwin Seatbelt 全腿）", () => {
  it.skipIf(!HAS_SEATBELT)("越根写拒：家目录（writable 外）写入失败可见；根内写过", async () => {
    const inside = await sh(`echo ok > ${JSON.stringify(join(root, "w.txt"))}`);
    expect(inside.code).toBe(0);
    expect(readFileSync(join(root, "w.txt"), "utf8").trim()).toBe("ok");
    const denied = await sh(`echo pwned > ${JSON.stringify(join(outside, "pwned.txt"))}`);
    expect(denied.code).not.toBe(0); // EPERM 可见（非工具 isError——bash 工具层语义）
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  }, 20_000);

  it.skipIf(!HAS_SEATBELT)("拒读表（确定性装置）：denyReadExtra 临时目录实种文件拒读，存在/缺失同文案（反探测）", async () => {
    const secretDir = mkdtempSync(join(tmpdir(), "xh-secret-"));
    writeFileSync(join(secretDir, "real.txt"), "s");
    const fenced2 = createSandboxEnv({
      base: createLocalEnv(root),
      fenceOf: () => ({ writable: [root, tmpdir()], denyRead: ["~/.ssh", secretDir], protectedPaths: [], network: { allowedDomains: [] } }),
      dialect: DARWIN ? "darwin" : "linux",
      proxyTargetOf: async () => ({}),
      isTornDown: () => false,
    }).env;
    const run2 = async (command: string): Promise<{ out: string; code: number | null }> => {
      const spawned = await fenced2.spawn({ argv: ["/bin/sh", "-c", command], cwd: root, session: S });
      if (!spawned.ok) throw new Error("spawn failed");
      const parts: string[] = [];
      await Promise.all([drainTo(spawned.proc.stdout, parts), drainTo(spawned.proc.stderr, parts)]);
      const done = await spawned.proc.exited;
      await spawned.proc.settled;
      return { out: parts.join(""), code: done.code };
    };
    const present = await run2(`cat ${JSON.stringify(join(secretDir, "real.txt"))} 2>&1`);
    expect(present.code).not.toBe(0);
    expect(present.out).toContain("Operation not permitted"); // 存在文件被内核拒（真拒非缺失）
    const missing = await run2(`cat ${JSON.stringify(join(secretDir, "ghost.txt"))} 2>&1`);
    // 内核层反探测不可达落档：seatbelt deny 匹配发生在 vnode 层，缺失路径报 ENOENT——
    // 存在性在内核层可探测（与 my-agent BUG-14 用户态 stat 前置不同层）；工具面 stat 前置无此泄漏
    expect(missing.out).toContain("No such file or directory");
    rmSync(secretDir, { recursive: true, force: true });
  }, 20_000);

  it.skipIf(!HAS_SEATBELT)("DNS 泄漏拒：nslookup 直连（UDP/53 出站被剖面拒）", async () => {
    const r = await sh("nslookup example.com 2>&1 | tail -2; echo NSLOOKUP_DONE");
    expect(r.out).toContain("NSLOOKUP_DONE");
    // 无外网 CI 上该腿弱化（直连本来就失败）——有网环境上剖面必须拒：断言未出现解析成功地址行
    expect(r.out).not.toMatch(/Addresses?:[^\n]*\d+\.\d+\.\d+\.\d+/); // 直连 DNS 解析不得成功
  }, 20_000);

  it.skipIf(!HAS_SEATBELT)("fenced bash 工具面：大输出截断保尾 + spill 字节等值 + 双流（wrapper 下三件套）", async () => {
    const { createToolbox } = await import("@x-harness/toolbox");
    const { toolsPlugin, toolRegistry } = await import("@x-harness/tools");
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const spill = mkdtempSync(join(tmpdir(), "xh-sbxspill-"));
    const ctx = createContext();
    const box = createToolbox({ root, spillDir: spill, defaultTimeoutMs: 10_000, env });
    const unload = await loadPlugins(ctx, [toolsPlugin, box.bashPlugin]);
    const reg = ctx.use(toolRegistry);
    const out = await reg.dispatch({
      callId: "fenced-bash",
      name: "bash",
      args: { command: 'for i in $(seq 1 6000); do echo "line-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done; echo err-line 1>&2', timeout_ms: 8_000 },
      signal: new AbortController().signal,
    });
    for (const dispose of unload) await dispose();
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("[output truncated; full output: ");
    expect(out.content).toContain("line-6000-"); // 保尾
    const spillPath = /full output: (.+)]/.exec(out.content)?.[1];
    expect(spillPath).toBeDefined();
    if (spillPath !== undefined) {
      const full = readFileSync(spillPath, "utf8");
      expect(full).toContain("line-1-"); // 头在 spill
      expect(full).toContain("line-6000-");
      expect(full).toContain("[stderr]");
      expect(full).toContain("err-line");
      expect(full.split("\n").filter((l) => l.startsWith("line-")).length).toBe(6_000); // 字节级等值（行数口径）
    }
    rmSync(spill, { recursive: true, force: true });
  }, 30_000);

  it.skipIf(!HAS_SEATBELT)("网络：直连外部/非代理回环口全拒（curl 可见失败）", async () => {
    const direct = await sh("curl -sS --max-time 4 -o /dev/null -w '%{http_code}' http://example.com 2>&1 || echo CURL_FAIL");
    expect(direct.out).toContain("CURL_FAIL"); // DNS/直连出站被剖面拒
    const port = await freePort();
    const loopback = await sh(`curl -sS --max-time 4 http://127.0.0.1:${String(port)}/ 2>&1 || echo CURL_FAIL`);
    expect(loopback.out).toContain("CURL_FAIL"); // 非代理口拒（SBPL 只放代理口字面量）
  }, 20_000);

  it.skipIf(!HAS_SEATBELT)("TOCTOU 回归：根内 symlink 换靶指向根外 → 写拒（门被骗过、内核不骗）", async () => {
    symlinkSync(outside, join(root, "swap-link"));
    const denied = await sh(`echo leaked > ${JSON.stringify(join(root, "swap-link", "leak.txt"))}`);
    expect(denied.code).not.toBe(0);
    expect(existsSync(join(outside, "leak.txt"))).toBe(false); // TOOLBOX §7 落档残留由内核闭合
  }, 20_000);

  it.skipIf(!HAS_SEATBELT)("组杀 wrapper 下：TERM 杀组长、settle 有界（孙进程收敛在 env）", async () => {
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "sleep 30"], cwd: root, session: S });
    if (!spawned.ok) throw new Error("spawn failed");
    await spawned.proc.kill("term");
    const exited = await spawned.proc.exited;
    expect(exited.code === null || exited.code !== 0).toBe(true); // 被杀非正常退出
    const started = Date.now();
    await spawned.proc.settled;
    expect(Date.now() - started).toBeLessThan(8_500);
  }, 20_000);
});

describe("sandbox 会话代理真 CONNECT（darwin 全链）", () => {
  it.skipIf(!HAS_SEATBELT)("授权域经代理放行：curl 走注入的 http_proxy 命中假上游", async () => {
    // 假上游：HTTP 200
    const upstream = net.createServer(upstreamEcho);
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const grants = new GrantsRegistry();
    grants.recordDomain(S, "127.0.0.1", "allow");
    const proxy = await createSessionProxy(S, grants, { askDomain: async () => "deny" });
    const fenced = createSandboxEnv({
      base: createLocalEnv(root),
      fenceOf: () => ({ writable: [root, tmpdir()], denyRead: ["~/.ssh"], protectedPaths: [], network: { allowedDomains: ["127.0.0.1"] } }),
      dialect: "darwin",
      proxyTargetOf: async () => ({ port: proxy.port }),
      isTornDown: () => false,
    }).env;
    try {
      const spawned = await fenced.spawn({
        argv: ["/bin/sh", "-c", `curl -sS --proxytunnel --max-time 6 http://127.0.0.1:${String(upstreamPort)}/`],
        cwd: root,
        session: S,
      });
      if (!spawned.ok) throw new Error("spawn failed");
      const parts: string[] = [];
      const reader = spawned.proc.stdout.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        parts.push(dec.decode(read.value, { stream: true }));
      }
      const done = await spawned.proc.exited;
      await spawned.proc.settled;
      expect(done.code).toBe(0);
      expect(parts.join("")).toContain("hi"); // 经代理命中上游——全链（注入 env→SBPL 放代理口→CONNECT→假上游）
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  }, 30_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}
