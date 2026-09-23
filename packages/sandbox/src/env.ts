// 围栏执行环境（docs/PERMISSION-V2-DESIGN.md §6.1）：fs 面直通 base（执法在 gate/permission
// ——两层口径裁决不变）；spawn 面按执行指令分路——
//   直通（req.exec=direct 且非隔离会话；或 unrestricted=full 总括覆写）：原样 argv/env 转发
//   （env 不清洗——受信面自带工具键，清洗正则会误杀 KEY 类键名；裁决管线照常先行）；
//   包裹（contained/缺席=fail-safe 缺省；隔离会话恒包裹）：fenceFor(session) → 白名单热切换
//   → srt wrap（失败收殓判别联合——srt wrap 可抛：shell 缺席/半初始化）→ base.spawn(清洗
//   env)。srt 返回的 env 不采用（宿主 process.env 未清洗）；代理/TMPDIR 注入经 wrapped 命令
//   内 env 前缀叠加。活句柄登记供拆卸契约（两段杀 → settled；逃逸复查自杀）。

import { randomUUID } from "node:crypto";
import type { SessionId } from "@x-harness/session";
import type { ExecEnv, ProcHandle, SpawnResult } from "@x-harness/exec-env";
import type { Fence } from "./fence.ts";
import type { SrtRuntime } from "./srt-runtime.ts";
import { commandOf } from "./shell-quote.ts";
import { scrubEnv } from "./scrub-env.ts";

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
  const spawn: ExecEnv["spawn"] = async (req) => {
    if (deps.isTornDown()) return unavailable("sandbox plugin is disposed — refusing to run unfenced");
    if (req.argv.length === 0) return { ok: false, reason: { kind: "not_found", detail: "empty argv" } };
    const fence = deps.fenceOf(req.session);
    // 执行指令分路（U1/U15）：direct=免包裹直通（裁决 allow 且档位 containment=none）；
    // contained/缺席=包裹（fail-safe 缺省）。隔离会话（rootOverride）恒包裹（U17）；
    // unrestricted（full 总括）恒直通——唯一两个覆写形态。
    const direct = (req.exec === "direct" || fence.unfenced) && !fence.isolated;
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
