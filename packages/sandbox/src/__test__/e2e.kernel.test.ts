import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin } from "@x-harness/tools";
import { createPermissionPlugin, permissionGrants } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
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
  let dispose: () => Promise<void> = async () => {};
  try {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
    createPermissionModesPlugin(),
      toolsPlugin,
      createPermissionPlugin({ root }),
      createSandboxPlugin({ root, ...options }, realSrtRuntime),
    ]);
    dispose = async (): Promise<void> => {
      for (const d of [...unload].reverse()) await d();
    };
    await fn({ ctx, root, dispose });
  } finally {
    await dispose().catch(() => {});
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

function expectCurlDenied(r: RunResult): void {
  const m = /curl_exit=(\d+)/.exec(r.out);
  expect(m, `curl output: ${r.out}`).not.toBeNull();
  expect(["7", "35", "56"]).toContain(m![1]);
}

async function runCurlUntilSettled(w: World, command: string, session?: SessionId): Promise<RunResult> {
  let r = await run(w, command, session);
  if (/curl_exit=28/.test(r.out)) r = await run(w, command, session);
  return r;
}

const LOOPBACK_SCRIPT =
  `bun -e 'const s=Bun.serve({port:0,fetch:()=>new Response("loop-ok")});` +
  `const r=await fetch("http://127.0.0.1:"+s.port);console.log(await r.text());s.stop(true);process.exit(0)'`;

describe("真内核 e2e：srt 围栏（darwin seatbelt）", () => {
  it("依赖在场：seatbelt 探测零错误（缺席=本文件红，不静默）", async () => {
    const errors = await realSrtRuntime.checkDeps();
    expect(errors).toEqual([]);
  });

  it("回环放行（缺省档）：围栏内 bind + loopback 自连可用——本地工作流通道（用户裁决④）", async () => {
    await withWorld({}, async (w) => {
      const r = await run(w, LOOPBACK_SCRIPT);
      expect(r.code, `out=${r.out} err=${r.err}`).toBe(0);
      expect(r.out.trim()).toBe("loop-ok");
    });
  }, 30_000);

  it("回环关闭（allowLocalBinding:false）：bind 被剖面拒——stricter 档 kill switch", async () => {
    await withWorld({ allowLocalBinding: false }, async (w) => {
      const r = await run(w, LOOPBACK_SCRIPT);
      expect(r.code).not.toBe(0);
    });
  }, 30_000);

  it("界内写通 + 读回；tmpdir 可写", async () => {
    await withWorld({}, async (w) => {
      const tmpFile = join(tmpdir(), "xh-e2e-tmp.txt");
      const r = await run(w, `echo payload > in-root.txt && cat in-root.txt && echo t > ${tmpFile}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("payload");
      rmSync(tmpFile, { force: true });
    });
  }, 30_000);

  it("越根写拒：EPERM 非零退出可见（非 spawn 失败——围栏执法面在子进程）", async () => {
    await withWorld({}, async (w) => {
      const outside = "/tmp/xh-sbxe2e-outside.txt";
      const r = await run(w, `echo x > ${outside}`);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("Operation not permitted");
      rmSync(outside, { force: true });
    });
  }, 30_000);

  it("拒读底线表：~/.ssh 列目录 EPERM（内容不可达）", async () => {
    await withWorld({}, async (w) => {
      const r = await run(w, `ls ~/.ssh/`);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("Operation not permitted");
    });
  }, 30_000);

  it("受保护 .git：写拒而同根他处可写（denyWrite 嵌在 allowWrite 内精准执法）", async () => {
    await withWorld({}, async (w) => {
      const denied = await run(w, `echo x > .git/config`);
      expect(denied.code).not.toBe(0);
      expect(denied.err).toContain("Operation not permitted");
      const allowed = await run(w, `echo ok > beside-git.txt`);
      expect(allowed.code).toBe(0);
    });
  }, 30_000);

  it("网络空白名单：未授权域名硬拒（无 ask——交互不属 sandbox）", async () => {
    await withWorld({}, async (w) => {
      const r = await run(w, `curl -s --max-time 8 https://example.com > /dev/null 2>&1; echo curl_exit=$?`);
      expectCurlDenied(r);
    });
  }, 60_000);

  it("unrestricted（full 档总括）：域名全通 + 越根写放开（用户主诉症状的全量回归）", async () => {
    await withWorld({}, async (w) => {
      w.ctx.use(permissionGrants).setUnrestricted(true);
      const sid = "s-full" as never as SessionId;
      const net = await runCurlUntilSettled(w, `curl -s --max-time 15 https://www.anthropic.com > /dev/null 2>&1; echo curl_exit=$?`, sid);
      expect(net.out).toContain("curl_exit=0");
      const outside = "/tmp/xh-sbx-full-write.txt";
      const fsr = await run(w, `echo full > ${outside} && echo WROTE`, sid);
      expect(fsr.out).toContain("WROTE");
      rmSync(outside, { force: true });
    });
  }, 60_000);

  it("env 密钥清洗：子进程读不到宿主密钥键（缺省 env 继承路径）", async () => {
    process.env.MY_E2E_SECRET_TOKEN = "leak-me";
    try {
      await withWorld({}, async (w) => {
        const r = await run(w, `echo got=[$MY_E2E_SECRET_TOKEN]`);
        expect(r.out.trim()).toBe("got=[]");
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
      await spawned.proc.settled;
    });
  }, 30_000);

  it("unrestricted 直通回归：KEY 类工具键原样达子进程（普通会话被清洗——区分对）", async () => {
    process.env.BW_PROBE_KEY = "tool-key-probe";
    try {
      await withWorld({}, async (w) => {
        const fenced = await run(w, `echo k=[$BW_PROBE_KEY]`);
        expect(fenced.out.trim()).toBe("k=[]");
        w.ctx.use(permissionGrants).setUnrestricted(true);
        const raw = await run(w, `echo k=[$BW_PROBE_KEY]`, "s-raw" as never as SessionId);
        expect(raw.out.trim()).toBe("k=[tool-key-probe]");
      });
    } finally {
      delete process.env.BW_PROBE_KEY;
    }
  }, 30_000);

  it("拆卸后 spawn fail-fast（sandbox_unavailable——绝不裸跑）", async () => {
    await withWorld({}, async (w) => {
      const env = w.ctx.use(execEnv);
      await w.dispose();
      const r = await env.spawn({ argv: ["/bin/true"], cwd: w.root });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.kind).toBe("sandbox_unavailable");
    });
  }, 30_000);
});
