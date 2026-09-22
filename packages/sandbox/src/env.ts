// 围栏执行环境（docs/SANDBOX.md §1/§3）：fs 面直通 base（执法在 gate/permission——两层口径
// 裁决不变）；spawn 面两分支——
//   直通（unrestricted 会话=裁决⑤修订「完全访问=不套壳」；或宿主受信命令——GUI/系统服务类
//   工具内核围栏表达不了）：原样 argv/env 转发（env 不清洗——受信面自带工具键，清洗正则会
//   误杀 KEY 类键名；permission 工具面裁决照常先行，此处只决定内核包裹去留）；
//   包裹（其余）：fenceFor(session) → 白名单热切换 → srt wrap（失败收殓判别联合——srt wrap
//   可抛：shell 缺席/半初始化）→ base.spawn(清洗 env)。srt 返回的 env 不采用（宿主
//   process.env 未清洗）；代理/TMPDIR 注入经 wrapped 命令内 env 前缀叠加。活句柄登记供拆卸
// 契约（两段杀 → settled；逃逸复查自杀）。

import { randomUUID } from "node:crypto";
import type { SessionId } from "@x-harness/session";
import type { ExecEnv, ProcHandle, SpawnRequest, SpawnResult } from "@x-harness/exec-env";
import type { Fence } from "./fence.ts";
import type { SrtRuntime } from "./srt-runtime.ts";
import { commandOf } from "./shell-quote.ts";
import { scrubEnv } from "./scrub-env.ts";
import { isTrustedCommand } from "./trusted.ts";

type EnvMap = Readonly<Record<string, string>>;

function envOf(req: { readonly env?: EnvMap }): EnvMap {
  if (req.env !== undefined) return req.env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface SandboxEnvDeps {
  readonly base: ExecEnv;
  readonly runtime: SrtRuntime;
  readonly fenceOf: (session: SessionId | undefined) => Fence;
  /** spawn 前白名单重算热切换（会话登记 + 并集 + 有变才切）——plugin 侧实现 */
  readonly syncAllowlist: (session: SessionId | undefined) => void;
  /** 宿主受信命令词表（sh -c 载荷全段 argv0 匹配——trusted.ts） */
  readonly trustedCommands: readonly string[];
  readonly isTornDown: () => boolean;
}

export interface SandboxEnvHandle {
  readonly env: ExecEnv;
  /** 拆卸契约用：当前活围栏句柄快照 */
  liveHandles(): readonly ProcHandle[];
}

export function createSandboxEnv(deps: SandboxEnvDeps): SandboxEnvHandle {
  const live = new Set<ProcHandle>();
  const unavailable = (detail: string) =>
    ({ ok: false, reason: { kind: "sandbox_unavailable", detail } }) as const;
  /** spawn 成功后的公共收尾：逃逸复查自杀（不交还调用方）+ 活句柄登记 */
  const settle = async (spawned: SpawnResult): Promise<SpawnResult> => {
    if (!spawned.ok) return spawned;
    if (deps.isTornDown()) {
      await spawned.proc.kill("term");
      const killTimer = setTimeout(() => void spawned.proc.kill("kill"), 5_000);
      spawned.proc.settled.then(() => clearTimeout(killTimer));
      return unavailable("sandbox plugin is disposed — refusing to run unfenced");
    }
    live.add(spawned.proc);
    spawned.proc.settled.then(() => {
      live.delete(spawned.proc);
    });
    return spawned;
  };
  const shCommandOf = (req: SpawnRequest): string | undefined =>
    req.argv.length === 3 && req.argv[0] === "/bin/sh" && req.argv[1] === "-c" ? req.argv[2] : undefined;
  const spawn: ExecEnv["spawn"] = async (req) => {
    if (deps.isTornDown()) return unavailable("sandbox plugin is disposed — refusing to run unfenced");
    if (req.argv.length === 0) return { ok: false, reason: { kind: "not_found", detail: "empty argv" } };
    const fence = deps.fenceOf(req.session);
    const command = shCommandOf(req);
    const direct = fence.unfenced || (command !== undefined && isTrustedCommand(command, deps.trustedCommands));
    // 直通也显式物化 env：Bun.spawn 缺省继承是启动快照而非运行期 process.env（平台坑）——
    // 不物化则运行期新增的工具键（如宿主装配后的 BW_API_KEY）到不了子进程
    if (direct) return settle(await deps.base.spawn({ ...req, env: envOf(req) }));
    deps.syncAllowlist(req.session);
    let wrapped: readonly string[];
    try {
      wrapped = await deps.runtime.wrap({
        command: commandOf(req.argv),
        fs: { denyRead: fence.denyRead, allowWrite: fence.writable, denyWrite: fence.denyWrite },
        cwd: req.cwd,
        commandId: `${req.session ?? "anon"}:${randomUUID()}`,
      });
    } catch (error) {
      return unavailable(`sandbox wrap failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (deps.isTornDown()) return unavailable("sandbox plugin is disposed — refusing to run unfenced");
    return settle(await deps.base.spawn({ ...req, argv: wrapped, env: scrubEnv(envOf(req)) }));
  };
  return {
    env: {
      kind: "sandbox",
      root: deps.base.root,
      realpath: deps.base.realpath,
      stat: deps.base.stat,
      openRead: deps.base.openRead,
      writeFileAtomic: deps.base.writeFileAtomic,
      readDir: deps.base.readDir,
      spawn,
    },
    liveHandles: () => [...live],
  };
}
