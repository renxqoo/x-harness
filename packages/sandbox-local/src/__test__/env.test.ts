// env 面单测（fake base 注入——docs/EXEC-ENV.md §7 平台分支以假体覆盖逻辑，内核触达在 e2e 腿）：
// off/allowlist 档 argv+env 形状、密钥清洗、NO_PROXY 剥除、torn-down/代理缺席 fail-closed、
// 活句柄登记与 settled 自清。

import { describe, expect, it } from "vitest";
import { createSandboxEnv, scrubEnv } from "../env.ts";
import type { ExecEnv, SpawnRequest, SpawnResult } from "@x-harness/exec-env";
import type { Fence } from "../fence.ts";

interface Capture {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly req: SpawnRequest;
}

function fakeBase(settledOf: () => Promise<void> = () => Promise.resolve()): { base: ExecEnv; captures: Capture[] } {
  const captures: Capture[] = [];
  const base: ExecEnv = {
    kind: "local",
    root: "/w/app",
    realpath: async (p) => p,
    stat: async () => ({ ok: false, reason: "not_found" }),
    openRead: async () => ({ ok: false, reason: "not_found" }),
    writeFileAtomic: async () => ({ ok: false, reason: "write_failed", detail: "fake" }),
    readDir: async () => ({ ok: true, entries: [] }),
    spawn: async (req) => {
      captures.push({ argv: req.argv, env: req.env, req });
      return { ok: true, proc: fakeProc(settledOf()) } as SpawnResult;
    },
  };
  return { base, captures };
}

/** settled 受控（默认已决；活句柄用例传入 pending 手动放行） */
function fakeProc(settled: Promise<void> = Promise.resolve()): never {
  return {
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: async () => {},
    settled,
  } as never;
}

const offFence: Fence = { writable: ["/w/app", "/tmp"], denyRead: [], protectedPaths: [], network: "off" };
const allowFence: Fence = { writable: ["/w/app", "/tmp"], denyRead: [], protectedPaths: [], network: { allowedDomains: ["x.dev"] } };

describe("scrubEnv（密钥清洗——内核拦不住读自身 env）", () => {
  it("KEY|PASSWORD|SECRET|TOKEN 命中即剥（子串口径——过剥优于漏剥）", () => {
    const out = scrubEnv({ PATH: "/bin", API_KEY: "x", MY_PASSWORD: "y", CLIENT_SECRET: "z", GITHUB_TOKEN: "t", MONKEY_FILE: "m" });
    expect(out.PATH).toBe("/bin");
    expect(out.MONKEY_FILE).toBeUndefined(); // 子串命中——过剥 fail-safe
    expect(Object.keys(out)).toEqual(["PATH"]);
  });
});

describe("createSandboxEnv（fake base 形状断言）", () => {
  it("off 档：darwin=seatbelt 包裹、无代理注入、密钥清洗透传", async () => {
    const { base, captures } = fakeBase();
    const env = createSandboxEnv({ base, fenceOf: () => offFence, dialect: "darwin", proxyTargetOf: async () => undefined, isTornDown: () => false }).env;
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "ls"], env: { PATH: "/bin", API_KEY: "secret" } });
    expect(spawned.ok).toBe(true);
    const cap = captures[0];
    if (cap === undefined) throw new Error("no capture");
    expect(cap.argv[0]).toBe("sandbox-exec");
    expect(cap.argv.slice(-2)).toEqual(["-c", "ls"]);
    expect(cap.env?.API_KEY).toBeUndefined(); // 清洗
    expect(cap.env?.PATH).toBe("/bin");
    expect(cap.env?.http_proxy).toBeUndefined(); // off 档无代理
    expect(cap.env).not.toHaveProperty("HTTP_PROXY");
  });

  it("allowlist 档：代理变量注入（大小写双写）+ 宿主 NO_PROXY 剥除；mount 旗标透传 linux 桥", async () => {
    const { base, captures } = fakeBase();
    const env = createSandboxEnv({ base, fenceOf: () => allowFence, dialect: "darwin", proxyTargetOf: async () => ({ port: 12345 }), isTornDown: () => false }).env;
    await env.spawn({ argv: ["/bin/sh", "-c", "curl x.dev"], env: { PATH: "/bin", NO_PROXY: "127.0.0.1", no_proxy: "localhost" } });
    const cap = captures[0];
    if (cap === undefined) throw new Error("no capture");
    expect(cap.env?.http_proxy).toBe("http://127.0.0.1:12345");
    expect(cap.env?.HTTP_PROXY).toBe("http://127.0.0.1:12345");
    expect(cap.env).not.toHaveProperty("NO_PROXY"); // 宿主 NO_PROXY 剥除（回环绕代理实测坑）
    expect(cap.env).not.toHaveProperty("no_proxy");
    expect(cap.argv[0]).toBe("sandbox-exec");
    expect(cap.argv[2]).toContain("localhost:12345"); // SBPL 仅放本会话代理口

    const linux = createSandboxEnv({ base, fenceOf: () => allowFence, dialect: "linux", proxyTargetOf: async () => ({ mounted: true }), isTornDown: () => false }).env;
    captures.length = 0;
    await linux.spawn({ argv: ["/bin/sh", "-c", "ls"] });
    expect(captures[0]?.env?.http_proxy).toBe("http://127.0.0.1:18080"); // ns 内 socat 桥口
    expect(captures[0]?.argv.join(" ")).toContain("socat TCP-LISTEN:18080");
  });

  it("fail-closed：torn-down 或代理缺席 → sandbox_unavailable（绝不裸跑）", async () => {
    const { base } = fakeBase();
    const torn = createSandboxEnv({ base, fenceOf: () => allowFence, dialect: "darwin", proxyTargetOf: async () => ({ port: 1 }), isTornDown: () => true }).env;
    const refused = await torn.spawn({ argv: ["/bin/sh", "-c", "ls"] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason.kind).toBe("sandbox_unavailable");

    const noProxy = createSandboxEnv({ base, fenceOf: () => allowFence, dialect: "darwin", proxyTargetOf: async () => undefined, isTornDown: () => false }).env;
    const refused2 = await noProxy.spawn({ argv: ["/bin/sh", "-c", "ls"] });
    expect(refused2.ok).toBe(false);
    if (!refused2.ok) expect(refused2.reason.kind).toBe("sandbox_unavailable");
  });

  it("活句柄登记：spawn 入册、settled 后自清（受控 deferred——真进程场景 settled 晚于断言）", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { base } = fakeBase(() => pending);
    const handle = createSandboxEnv({ base, fenceOf: () => offFence, dialect: "darwin", proxyTargetOf: async () => undefined, isTornDown: () => false });
    await handle.env.spawn({ argv: ["/bin/sh", "-c", "true"] });
    expect(handle.liveHandles()).toHaveLength(1);
    release();
    await pending;
    await new Promise((r) => {
      setTimeout(r, 0);
    }); // 自清微任务
    expect(handle.liveHandles()).toHaveLength(0);
  });

  it("fs 面直通 base（执法在 gate/permission——§3 裁决）", async () => {
    const { base } = fakeBase();
    const env = createSandboxEnv({ base, fenceOf: () => offFence, dialect: "darwin", proxyTargetOf: async () => undefined, isTornDown: () => false }).env;
    expect(await env.stat("/w/app/x")).toEqual({ ok: false, reason: "not_found" }); // fake base 应答原样
    expect(env.kind).toBe("sandbox");
  });
});
