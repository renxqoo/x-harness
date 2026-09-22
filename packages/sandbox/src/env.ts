// 围栏执行环境（docs/SANDBOX.md §1/§3）：fs 面直通 base（执法在 gate/permission——两层口径
// 裁决不变）；spawn 面 = fenceFor(session) → 白名单热切换 → srt wrap → base.spawn(清洗 env)。
// srt 返回的 env 不采用（宿主 process.env 未清洗）；代理/TMPDIR 注入经 wrapped 命令内 env 前缀
// 叠加在我们传入的清洗 env 之上。活句柄登记供拆卸契约（两段杀 → settled；逃逸复查自杀）。

import { randomUUID } from "node:crypto";
import type { SessionId } from "@x-harness/session";
import type { ExecEnv, ProcHandle } from "@x-harness/exec-env";
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
  const spawn: ExecEnv["spawn"] = async (req) => {
    if (deps.isTornDown()) return unavailable("sandbox plugin is disposed — refusing to run unfenced");
    if (req.argv.length === 0) return { ok: false, reason: { kind: "not_found", detail: "empty argv" } };
    const fence = deps.fenceOf(req.session);
    deps.syncAllowlist(req.session);
    const commandId = `${req.session ?? "anon"}:${randomUUID()}`;
    const wrapped = await deps.runtime.wrap({
      command: commandOf(req.argv),
      fs: { denyRead: fence.denyRead, allowWrite: fence.writable, denyWrite: fence.denyWrite },
      cwd: req.cwd,
      commandId,
    });
    if (deps.isTornDown()) return unavailable("sandbox plugin is disposed — refusing to run unfenced");
    const spawned = await deps.base.spawn({ ...req, argv: wrapped, env: scrubEnv(envOf(req)) });
    if (spawned.ok) {
      if (deps.isTornDown()) {
        // 拆卸窗口逃逸复查：围栏已拆而 spawn 已成——立即两段杀自杀，不交还调用方
        await spawned.proc.kill("term");
        setTimeout(() => void spawned.proc.kill("kill"), 5_000);
        return unavailable("sandbox plugin is disposed — refusing to run unfenced");
      }
      live.add(spawned.proc);
      spawned.proc.settled.then(() => {
        live.delete(spawned.proc);
      });
    }
    return spawned;
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
