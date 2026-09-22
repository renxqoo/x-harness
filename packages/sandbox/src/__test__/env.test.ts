// createSandboxEnv 拆卸窗口矩阵（docs/SANDBOX.md §1 拆卸契约）：wrap 在飞拆卸（fail-fast）/
// base.spawn 在飞拆卸（逃逸复查自杀——不交还调用方）/ 正常路径活句柄登记与 settled 自清。
// 可控假 base + 假 runtime——时序确定性（不经竞速）。

import { describe, expect, it } from "vitest";
import type { ExecEnv, ProcHandle, SpawnResult } from "@x-harness/exec-env";
import { createSandboxEnv } from "../env.ts";
import type { Fence } from "../fence.ts";
import type { SrtRuntime } from "../srt-runtime.ts";

const FENCE: Fence = { writable: ["/w"], denyRead: ["~/.ssh"], denyWrite: ["/w/.git"], allowedDomains: [] };

function makeFakeProc(): ProcHandle & { readonly kills: readonly string[]; settle(): void } {
  const kills: string[] = [];
  let releaseSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    releaseSettled = resolve;
  });
  return {
    kills,
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: async (phase) => {
      kills.push(phase);
    },
    settled,
    settle: () => releaseSettled(),
  };
}

function makeGate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("createSandboxEnv 拆卸窗口", () => {
  it("wrap 在飞时拆卸：wrap 返回后 fail-fast（不触 base.spawn）", async () => {
    let tornDown = false;
    const gate = makeGate<readonly string[]>();
    const runtime: SrtRuntime = {
      checkDeps: async () => [],
      start: async () => {},
      syncNetwork: () => {},
      wrap: () => gate.promise,
      reset: async () => {},
    };
    let baseSpawned = 0;
    const base = {
      kind: "local",
      root: "/w",
      realpath: async (p: string) => p,
      stat: async () => ({ ok: false, reason: "not_found" as const }),
      openRead: async () => ({ ok: false, reason: "not_found" as const }),
      writeFileAtomic: async () => ({ ok: false, reason: "access_denied" as const }),
      readDir: async () => ({ ok: false, reason: "not_found" as const }),
      spawn: async (): Promise<SpawnResult> => {
        baseSpawned += 1;
        return { ok: true, proc: makeFakeProc() };
      },
    } as unknown as ExecEnv;
    const { env } = createSandboxEnv({ base, runtime, fenceOf: () => FENCE, syncAllowlist: () => {}, isTornDown: () => tornDown });
    const inFlight = env.spawn({ argv: ["/bin/true"], cwd: "/w" });
    tornDown = true;
    gate.release(["/bin/true"]);
    const r = await inFlight;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.kind).toBe("sandbox_unavailable");
    expect(baseSpawned).toBe(0);
  });

  it("base.spawn 在飞时拆卸：逃逸复查自杀（kill term 起手，不交还调用方）", async () => {
    let tornDown = false;
    const wrapGate = makeGate<readonly string[]>();
    const spawnGate = makeGate<SpawnResult>();
    const runtime: SrtRuntime = {
      checkDeps: async () => [],
      start: async () => {},
      syncNetwork: () => {},
      wrap: () => wrapGate.promise,
      reset: async () => {},
    };
    const base = {
      kind: "local",
      root: "/w",
      realpath: async (p: string) => p,
      stat: async () => ({ ok: false, reason: "not_found" as const }),
      openRead: async () => ({ ok: false, reason: "not_found" as const }),
      writeFileAtomic: async () => ({ ok: false, reason: "access_denied" as const }),
      readDir: async () => ({ ok: false, reason: "not_found" as const }),
      spawn: () => spawnGate.promise,
    } as unknown as ExecEnv;
    const { env, liveHandles } = createSandboxEnv({
      base,
      runtime,
      fenceOf: () => FENCE,
      syncAllowlist: () => {},
      isTornDown: () => tornDown,
    });
    const inFlight = env.spawn({ argv: ["/bin/true"], cwd: "/w" });
    wrapGate.release(["/bin/true"]); // wrap 先过（tornDown 仍 false——post-wrap 检查放行）
    await new Promise((r) => {
      setTimeout(r, 0);
    }); // 已抵达 base.spawn await
    tornDown = true; // 拆卸发生在 spawn 在飞期
    const proc = makeFakeProc();
    spawnGate.release({ ok: true, proc });
    const r = await inFlight;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.kind).toBe("sandbox_unavailable");
    expect(proc.kills).toEqual(["term"]); // 自杀起手 term（5s 宽限 kill 是 escalation 兜底）
    expect(liveHandles()).toEqual([]); // 未登记——已拆围栏的句柄不入账
  });

  it("正常路径：活句柄登记，settled 后自清", async () => {
    const runtime: SrtRuntime = {
      checkDeps: async () => [],
      start: async () => {},
      syncNetwork: () => {},
      wrap: async ({ command }) => ["/bin/sh", "-c", command],
      reset: async () => {},
    };
    const proc = makeFakeProc();
    const base = {
      kind: "local",
      root: "/w",
      realpath: async (p: string) => p,
      stat: async () => ({ ok: false, reason: "not_found" as const }),
      openRead: async () => ({ ok: false, reason: "not_found" as const }),
      writeFileAtomic: async () => ({ ok: false, reason: "access_denied" as const }),
      readDir: async () => ({ ok: false, reason: "not_found" as const }),
      spawn: async (): Promise<SpawnResult> => ({ ok: true, proc }),
    } as unknown as ExecEnv;
    const { env, liveHandles } = createSandboxEnv({
      base,
      runtime,
      fenceOf: () => FENCE,
      syncAllowlist: () => {},
      isTornDown: () => false,
    });
    const r = await env.spawn({ argv: ["/bin/true"], cwd: "/w" });
    expect(r.ok).toBe(true);
    expect(liveHandles()).toEqual([proc]); // settled 未决——登记在场
    proc.settle();
    await proc.settled;
    expect(liveHandles()).toEqual([]); // settled 后自清
  });
});
