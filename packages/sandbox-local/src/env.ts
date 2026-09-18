// 围栏执行环境（docs/EXEC-ENV.md §4/§6）：fs 面直通 base（执法在 gate/permission——§3 裁决）；
// spawn 面 confine（darwin=seatbelt argv 改写 / linux=bwrap+socat 桥）+ 子进程 env 密钥清洗
// + 会话代理注入。活句柄登记供拆卸契约（dispose 两段杀→await settled）。fence 由单一解析
// 函数在 spawn 时取（会话授权即时生效）。

import type { SessionId } from "@x-harness/session";
import type { ExecEnv, ProcHandle } from "@x-harness/exec-env";
import { realpathDeep } from "@x-harness/exec-env";
import type { Fence } from "./fence.ts";
import { seatbeltArgv } from "./confine/seatbelt.ts";
import { bwrapArgv } from "./confine/bubblewrap.ts";
import type { Dialect } from "./probe.ts";

export interface ProxyTarget {
  /** darwin：会话代理 TCP 回环口（SBPL 网络放行仅此口） */
  readonly port?: number;
  /** linux：代理 unix socket 已挂载进 ns（socat 桥就位） */
  readonly mounted?: boolean;
}

export interface SandboxEnvDeps {
  readonly base: ExecEnv;
  readonly fenceOf: (session: SessionId | undefined) => Fence;
  readonly dialect: Dialect;
  /** allowlist 档惰性取会话代理目标（off 档不会被调用）；拆卸后返回 undefined → fail-closed */
  readonly proxyTargetOf: (session: SessionId | undefined) => Promise<ProxyTarget | undefined>;
  readonly isTornDown: () => boolean;
}

const SCRUB_RE = /KEY|PASSWORD|SECRET|TOKEN/i;

type EnvMap = Readonly<Record<string, string>>;

function envOf(req: { readonly env?: EnvMap }): EnvMap {
  if (req.env !== undefined) return req.env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 密钥清洗（dsh 思想）：内核拦不住进程读自身 env——这层必须在 spawn 前做掉 */
export function scrubEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SCRUB_RE.test(key)) out[key] = value;
  }
  return out;
}

export interface SandboxEnvHandle {
  readonly env: ExecEnv;
  /** 拆卸契约用：当前活围栏句柄快照 */
  liveHandles(): readonly ProcHandle[];
}

export function createSandboxEnv(deps: SandboxEnvDeps): SandboxEnvHandle {
  const live = new Set<ProcHandle>();
  const spawn = async (req: Parameters<ExecEnv["spawn"]>[0]): ReturnType<ExecEnv["spawn"]> => {
    if (deps.isTornDown()) {
      return { ok: false, reason: { kind: "sandbox_unavailable", detail: "sandbox plugin is disposed — refusing to run unfenced" } };
    }
    const fence = deps.fenceOf(req.session);
    const base = scrubEnv(envOf(req));
    const confineInput = { fence, argv: req.argv, proxyMounted: false, proxyPort: undefined as number | undefined };
    let env: Record<string, string> = base;
    if (fence.network !== "off") {
      const target = await deps.proxyTargetOf(req.session);
      if (target === undefined) {
        return { ok: false, reason: { kind: "sandbox_unavailable", detail: "session proxy unavailable (torn down) — refusing to run unfenced" } };
      }
      confineInput.proxyMounted = target.mounted === true;
      confineInput.proxyPort = target.port;
      if (target.port !== undefined || target.mounted === true) {
        // curl 只认小写 http_proxy（CGI 安全惯例）；大小写双写覆盖主流客户端；linux=ns 内 socat 桥口。
        // 剥除宿主 NO_PROXY/no_proxy——回环目标绕代理直连会被剖面拒（实测坑）；一切出站强制经代理
        const proxyUrl = deps.dialect === "darwin" ? `http://127.0.0.1:${String(target.port)}` : "http://127.0.0.1:18080";
        const { NO_PROXY, no_proxy, ...rest } = base;
        void NO_PROXY;
        void no_proxy;
        env = { ...rest, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl };
      }
    }
    const argv = confine(deps.dialect, confineInput);
    const spawned = await deps.base.spawn({ ...req, argv, env });
    if (spawned.ok) {
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

interface ConfineInput {
  readonly fence: Fence;
  readonly argv: readonly string[];
  readonly proxyMounted: boolean;
  readonly proxyPort: number | undefined;
}

function confine(dialect: Dialect, input: ConfineInput): readonly string[] {
  if (dialect === "darwin") return seatbeltArgv({ fence: input.fence, proxyPort: input.proxyPort, argv: input.argv, realpathOf: (p) => realpathDeep(p) });
  return bwrapArgv({ fence: input.fence, proxyMounted: input.proxyMounted, argv: input.argv });
}
