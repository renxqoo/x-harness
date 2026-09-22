// 真内核 e2e（docs/SANDBOX.md §5）：darwin seatbelt 真跑——srt 引擎的执法面在 vitest 默认门。
// wrapper 在场时零 skip（依赖缺失=测试失败，不静默跳过）；linux 真内核腿 in-repo 不可达
// （darwin 开发机）——本包零平台分支（平台差异收敛在 srt 内），known-untested 延续。

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin } from "@x-harness/tools";
import { createPermissionPlugin, permissionGrants } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import { execEnv } from "@x-harness/exec-env";
import { realSrtRuntime } from "../srt-runtime.ts";
import { createSandboxPlugin } from "../plugin.ts";

interface World {
  readonly ctx: ReturnType<typeof createContext>;
  readonly root: string;
  readonly dispose: () => Promise<void>;
}

async function withWorld(options: Partial<Parameters<typeof createSandboxPlugin>[0]>, fn: (w: World) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "xh-sbxe2e-"));
  mkdirSync(join(root, ".git"));
  try {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionPlugin({ root }),
      createSandboxPlugin({ root, ...options }, realSrtRuntime),
    ]);
    const dispose = async (): Promise<void> => {
      for (const d of [...unload].reverse()) await d();
    };
    await fn({ ctx, root, dispose });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

async function run(w: World, command: string, session?: SessionId): Promise<RunResult> {
  const spawned = await w.ctx.use(execEnv).spawn({
    argv: ["/bin/sh", "-c", command],
    cwd: w.root,
    ...(session !== undefined ? { session } : {}),
  });
  if (!spawned.ok) return { code: -1, out: "", err: `spawn-failed:${spawned.reason.kind}` };
  const [out, err, exited] = await Promise.all([
    new Response(spawned.proc.stdout).text(),
    new Response(spawned.proc.stderr).text(),
    spawned.proc.exited,
  ]);
  await spawned.proc.settled;
  return { code: exited.code, out, err };
}

/** curl 退出码 ∈ 拒绝形态集（7 连不上/35 TLS 前/56 重置）——白名单拒绝的三种表现 */
function expectCurlDenied(r: RunResult): void {
  const m = /curl_exit=(\d+)/.exec(r.out);
  expect(m, `curl output: ${r.out}`).not.toBeNull();
  expect(["7", "35", "56"]).toContain(m![1]);
}

describe("真内核 e2e：srt 围栏（darwin seatbelt）", () => {
  it("依赖在场：seatbelt 探测零错误（缺席=本文件红，不静默）", async () => {
    const errors = await realSrtRuntime.checkDeps();
    expect(errors).toEqual([]);
  });

  it("界内写通 + 读回；tmpdir 可写", async () => {
    await withWorld({}, async (w) => {
      const tmpFile = join(tmpdir(), "xh-e2e-tmp.txt");
      const r = await run(w, `echo payload > in-root.txt && cat in-root.txt && echo t > ${tmpFile}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("payload");
      rmSync(tmpFile, { force: true });
      await w.dispose();
    });
  }, 30_000);

  it("越根写拒：EPERM 非零退出可见（非 spawn 失败——围栏执法面在子进程）", async () => {
    await withWorld({}, async (w) => {
      const outside = "/tmp/xh-sbxe2e-outside.txt"; // /tmp 不在白名单（root/tmpdir 之外）
      const r = await run(w, `echo x > ${outside}`);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("Operation not permitted");
      rmSync(outside, { force: true });
      await w.dispose();
    });
  }, 30_000);

  it("拒读底线表：~/.ssh 列目录 EPERM（内容不可达）", async () => {
    await withWorld({}, async (w) => {
      const r = await run(w, `ls ~/.ssh/`);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("Operation not permitted");
      await w.dispose();
    });
  }, 30_000);

  it("受保护 .git：写拒而同根他处可写（denyWrite 嵌在 allowWrite 内精准执法）", async () => {
    await withWorld({}, async (w) => {
      const denied = await run(w, `echo x > .git/config`);
      expect(denied.code).not.toBe(0);
      expect(denied.err).toContain("Operation not permitted");
      const allowed = await run(w, `echo ok > beside-git.txt`);
      expect(allowed.code).toBe(0);
      await w.dispose();
    });
  }, 30_000);

  it("网络空白名单：未授权域名硬拒（无 ask——交互不属 sandbox）", async () => {
    await withWorld({}, async (w) => {
      const r = await run(w, `curl -s --max-time 8 https://example.com > /dev/null 2>&1; echo curl_exit=$?`);
      expectCurlDenied(r);
      await w.dispose();
    });
  }, 60_000);

  it("授权即时生效：grants 记域名 → 下一次 spawn 热切换 → 放行（旧实现 full 网络被拒的症状回归）", async () => {
    await withWorld({}, async (w) => {
      const sid = "s-e2e" as never as SessionId;
      const before = await run(w, `curl -s --max-time 8 https://example.com > /dev/null 2>&1; echo curl_exit=$?`, sid);
      expectCurlDenied(before);
      w.ctx.use(permissionGrants).recordDomain(sid, "example.com", "allow");
      const after = await run(w, `curl -s --max-time 10 https://example.com > /dev/null 2>&1; echo curl_exit=$?`, sid);
      expect(after.out).toContain("curl_exit=0");
      await w.dispose();
    });
  }, 60_000);

  it("unrestricted（full 档总括）：域名全通 + 越根写放开（用户主诉症状的全量回归）", async () => {
    await withWorld({}, async (w) => {
      w.ctx.use(permissionGrants).setUnrestricted(true);
      const sid = "s-full" as never as SessionId;
      const net = await run(w, `curl -s --max-time 10 https://www.anthropic.com > /dev/null 2>&1; echo curl_exit=$?`, sid);
      expect(net.out).toContain("curl_exit=0");
      const outside = "/tmp/xh-sbx-full-write.txt";
      const fsr = await run(w, `echo full > ${outside} && echo WROTE`, sid);
      expect(fsr.out).toContain("WROTE");
      rmSync(outside, { force: true });
      await w.dispose();
    });
  }, 60_000);

  it("env 密钥清洗：子进程读不到宿主密钥键（缺省 env 继承路径）", async () => {
    process.env.MY_E2E_SECRET_TOKEN = "leak-me";
    try {
      await withWorld({}, async (w) => {
        const r = await run(w, `echo got=[$MY_E2E_SECRET_TOKEN]`);
        expect(r.out.trim()).toBe("got=[]");
        await w.dispose();
      });
    } finally {
      delete process.env.MY_E2E_SECRET_TOKEN;
    }
  }, 30_000);

  it("组杀与 settled：wrapper 下 kill 两段语义成立", async () => {
    await withWorld({}, async (w) => {
      const spawned = await w.ctx.use(execEnv).spawn({ argv: ["/bin/sh", "-c", "sleep 30"], cwd: w.root });
      if (!spawned.ok) throw new Error(spawned.reason.detail);
      await spawned.proc.kill("term");
      const exited = await spawned.proc.exited;
      expect(exited).not.toBe(0);
      await spawned.proc.settled; // 不挂起
      await w.dispose();
    });
  }, 30_000);

  it("拆卸后 spawn fail-fast（sandbox_unavailable——绝不裸跑）", async () => {
    await withWorld({}, async (w) => {
      const env = w.ctx.use(execEnv); // 先捕获——dispose 后服务下线，语义面向已持引用的调用方
      await w.dispose();
      const r = await env.spawn({ argv: ["/bin/true"], cwd: w.root });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.kind).toBe("sandbox_unavailable");
    });
  }, 30_000);
});
