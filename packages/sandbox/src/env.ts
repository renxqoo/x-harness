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
  readonly syncAllowlist: (session: SessionId | undefined) => void;
  readonly isTornDown: () => boolean;
}

export interface SandboxEnvHandle {
  readonly env: ExecEnv;
  liveHandles(): readonly ProcHandle[];
}

export function createSandboxEnv(deps: SandboxEnvDeps): SandboxEnvHandle {
  const live = new Set<ProcHandle>();
  const unavailable = (detail: string) =>
    ({ ok: false, reason: { kind: "sandbox_unavailable", detail } }) as const;
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
    const direct = (req.exec === "direct" || fence.unfenced) && !fence.isolated;
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
